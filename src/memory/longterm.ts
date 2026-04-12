import pg from "pg";
import { createLogger } from "../lib/logger.js";
import { PendingMemoryCandidate } from "../graph/state.js";
import { EPISODE_TTL_DAYS } from "../config/memory.js";
import { generateEmbedding } from "../lib/embeddings.js";

const log = createLogger("longterm-memory");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Initialize table
export const initLongTermMemoryTable = async () => {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS long_term_memory (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR(255) NOT NULL,
      content TEXT NOT NULL,
      embedding vector(1536),
      memory_type VARCHAR(50) NOT NULL,
      category VARCHAR(100) NOT NULL,
      canonical_key VARCHAR(255),
      confidence FLOAT,
      importance_score FLOAT,
      mention_count INTEGER DEFAULT 1,
      last_confirmed_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),

      UNIQUE(user_id, canonical_key)
    );

    DO $$ 
    BEGIN 
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='long_term_memory' AND column_name='embedding') THEN
        ALTER TABLE long_term_memory ADD COLUMN embedding vector(1536);
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_ltm_user_id ON long_term_memory(user_id);
    CREATE INDEX IF NOT EXISTS idx_ltm_expires ON long_term_memory(expires_at);
  `);
  log.info("Long-term memory table initialized");
};

// Save promoted candidate to long-term
export const saveLongTermMemory = async (
  userId: string,
  candidate: PendingMemoryCandidate,
): Promise<void> => {
  const expiresAt =
    candidate.memoryType === "episode_summary"
      ? new Date(Date.now() + EPISODE_TTL_DAYS * 24 * 60 * 60 * 1000)
      : null;

  // Generate embedding
  const embedding = await generateEmbedding(candidate.content);

  // Upsert: if same canonicalKey exists, update; otherwise insert
  await pool.query(
    `
    INSERT INTO long_term_memory (
      user_id, content, embedding, memory_type, category, canonical_key,
      confidence, importance_score, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (user_id, canonical_key) DO UPDATE SET
      content = EXCLUDED.content,
      embedding = EXCLUDED.embedding,
      confidence = EXCLUDED.confidence,
      importance_score = EXCLUDED.importance_score,
      mention_count = long_term_memory.mention_count + 1,
      last_confirmed_at = NOW()
  `,
    [
      userId,
      candidate.content,
      `[${embedding.join(",")}]`,
      candidate.memoryType,
      candidate.category,
      candidate.canonicalKey || candidate.candidateKey,
      candidate.confidence || null,
      candidate.importanceScore || null,
      expiresAt,
    ],
  );

  log.info(
    { userId, candidateKey: candidate.candidateKey },
    "Saved to long-term memory",
  );
};

// Get long-term memories for context
export const getLongTermMemories = async (userId: string): Promise<string> => {
  const result = await pool.query(
    `
    SELECT content, memory_type, category
    FROM long_term_memory
    WHERE user_id = $1
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY importance_score DESC, last_confirmed_at DESC
    LIMIT 10
  `,
    [userId],
  );

  if (result.rows.length === 0) {
    return "";
  }

  const facts = result.rows
    .filter((r) => r.memory_type === "fact")
    .map((r) => `- ${r.content}`)
    .join("\n");

  const episodes = result.rows
    .filter((r) => r.memory_type === "episode_summary")
    .map((r) => `- ${r.content}`)
    .join("\n");

  let context = "";
  if (facts) {
    context += `FAKTA TENTANG USER:\n${facts}\n`;
  }
  if (episodes) {
    context += `KONTEKS SEBELUMNYA:\n${episodes}`;
  }

  return context.trim();
};

// Cleanup expired memories
export const cleanupExpiredMemories = async (): Promise<number> => {
  const result = await pool.query(`
    DELETE FROM long_term_memory
    WHERE expires_at IS NOT NULL AND expires_at < NOW()
  `);
  return result.rowCount || 0;
};
// Search long-term memory using vector similarity
export const searchLongTermMemory = async (
  userId: string,
  query?: string,
  limit: number = 5
) => {
  if (!query) {
    const result = await pool.query(
      `SELECT content, category FROM long_term_memory 
       WHERE user_id = $1 
       ORDER BY importance_score DESC, created_at DESC 
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows;
  }

  const embedding = await generateEmbedding(query);
  const result = await pool.query(
    `SELECT content, category, 1 - (embedding <=> $1) as similarity
     FROM long_term_memory
     WHERE user_id = $2
     ORDER BY embedding <=> $1
     LIMIT $3`,
    [`[${embedding.join(",")}]`, userId, limit]
  );

  return result.rows;
};
