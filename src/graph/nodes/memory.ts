import { BaseMessage, getBufferString } from "@langchain/core/messages";
import { GraphStateType, PendingMemoryCandidate } from "../state.js";
import { llm } from "../../llm/index.js";
import {
  RAW_TAIL_COUNT,
  MESSAGE_TOKEN_LIMIT,
  SUMMARY_TOKEN_LIMIT,
  CHECKPOINT_TOKEN_THRESHOLD,
  FACT_MIN_SEEN,
  FACT_MAX_CHECKPOINTS,
  EPISODE_MIN_SEEN,
  EPISODE_MAX_CHECKPOINTS,
  EPISODE_MIN_IMPORTANCE,
  MAX_PENDING_CANDIDATES,
  MAX_AGE_DAYS,
} from "../../config/memory.js";
import {
  summarizePrompt,
  condenseSummaryPrompt,
  memoryExtractionPrompt,
} from "../../prompts/index.js";
import { createLogger } from "../../lib/logger.js";
import { saveLongTermMemory } from "../../memory/longterm.js";
import { MemoryExtraction } from "../../memory/types.js";

const log = createLogger("memory");

// ===================
// HELPERS
// ===================

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const estimateMessagesTokens = (messages: BaseMessage[]): number => {
  return messages.reduce((sum, m) => sum + estimateTokens(String(m.content)), 0);
};

/**
 * Format history agar rapi (USER/BOT) dan BERSIH (buang data teknis JSON)
 */
const formatCleanHistory = (messages: BaseMessage[]): string => {
  return messages
    .filter((m) => m._getType() !== "tool") // <--- Buang semua JSON berantakan
    .map((m) => {
      const role = m._getType() === "human" ? "USER" : "BOT";
      return `${role}: ${m.content}`;
    })
    .join("\n");
};

// ===================
// SHORT-TERM SUMMARIZATION
// ===================

const shouldSummarize = (messages: BaseMessage[]): boolean => {
  if (messages.length <= RAW_TAIL_COUNT) return false;
  return estimateMessagesTokens(messages) > MESSAGE_TOKEN_LIMIT;
};

const summarizeMessages = async (
  messages: BaseMessage[],
  existingSummary: string,
): Promise<{ summary: string; droppedTokens: number }> => {
  const messagesToSummarize = messages.slice(0, -RAW_TAIL_COUNT);
  const droppedTokens = estimateMessagesTokens(messagesToSummarize);

  // Generate summary
  const chain = summarizePrompt.pipe(llm);
  const result = await chain.invoke({
    conversation: formatCleanHistory(messagesToSummarize),
  });
  let newSummary = String(result.content);

  // Combine with existing
  if (existingSummary) {
    newSummary = `${existingSummary}\n\n${newSummary}`;
  }

  // Condense if too long
  if (estimateTokens(newSummary) > SUMMARY_TOKEN_LIMIT) {
    const condenseChain = condenseSummaryPrompt.pipe(llm);
    const condensed = await condenseChain.invoke({ oldSummary: newSummary });
    newSummary = String(condensed.content);
    log.info("Summary condensed");
  }

  return { summary: newSummary, droppedTokens };
};

// ===================
// MEMORY EXTRACTION
// ===================

const extractMemories = async (
  summary: string,
  recentMessages: BaseMessage[],
): Promise<MemoryExtraction> => {
  const chain = memoryExtractionPrompt.pipe(llm);
  const result = await chain.invoke({
    summary,
    recentMessages: formatCleanHistory(recentMessages),
  });

  try {
    const content = String(result.content).trim();
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn("No JSON found in extraction response");
      return { facts: [], episodeSummary: null };
    }
    return JSON.parse(jsonMatch[0]) as MemoryExtraction;
  } catch (e) {
    log.error({ error: e }, "Failed to parse memory extraction");
    return { facts: [], episodeSummary: null };
  }
};

// ===================
// PENDING CANDIDATE MANAGEMENT
// ===================

const shouldPromote = (candidate: PendingMemoryCandidate): boolean => {
  if (candidate.memoryType === "fact") {
    return candidate.seenCount >= FACT_MIN_SEEN;
  }
  // Episode: seenCount >= 2 OR (checkpointCount >= 3 AND importance >= 0.6)
  if (candidate.seenCount >= EPISODE_MIN_SEEN) return true;
  if (
    candidate.checkpointCount >= EPISODE_MAX_CHECKPOINTS &&
    (candidate.importanceScore || 0) >= EPISODE_MIN_IMPORTANCE
  ) {
    return true;
  }
  return false;
};

const shouldDiscard = (candidate: PendingMemoryCandidate, now: Date): boolean => {
  const maxCheckpoints =
    candidate.memoryType === "fact" ? FACT_MAX_CHECKPOINTS : EPISODE_MAX_CHECKPOINTS;

  if (candidate.checkpointCount > maxCheckpoints) return true;

  const ageMs = now.getTime() - new Date(candidate.firstSeenAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays > MAX_AGE_DAYS;
};

const updatePendingCandidates = (
  existing: PendingMemoryCandidate[],
  extraction: MemoryExtraction,
  now: Date,
): {
  pending: PendingMemoryCandidate[];
  promoted: PendingMemoryCandidate[];
} => {
  const nowIso = now.toISOString();
  const candidateMap = new Map<string, PendingMemoryCandidate>();

  // Increment checkpointCount for existing candidates
  for (const c of existing) {
    candidateMap.set(c.candidateKey, {
      ...c,
      checkpointCount: c.checkpointCount + 1,
    });
  }

  // Add/merge new facts
  for (const fact of extraction.facts) {
    const key = `fact:${fact.canonicalKey}`;
    const existing = candidateMap.get(key);

    if (existing) {
      candidateMap.set(key, {
        ...existing,
        content: fact.content,
        confidence: fact.confidence,
        importanceScore: fact.importanceScore,
        seenCount: existing.seenCount + 1,
        lastSeenAt: nowIso,
      });
    } else {
      candidateMap.set(key, {
        candidateKey: key,
        memoryType: "fact",
        category: fact.category,
        canonicalKey: fact.canonicalKey,
        content: fact.content,
        confidence: fact.confidence,
        importanceScore: fact.importanceScore,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        seenCount: 1,
        checkpointCount: 1,
      });
    }
  }

  // Add/merge episode
  if (extraction.episodeSummary) {
    const ep = extraction.episodeSummary;
    const key = `episode:${ep.topicKey}`;
    const existing = candidateMap.get(key);

    if (existing) {
      candidateMap.set(key, {
        ...existing,
        content: ep.content,
        importanceScore: ep.importanceScore,
        seenCount: existing.seenCount + 1,
        lastSeenAt: nowIso,
      });
    } else {
      candidateMap.set(key, {
        candidateKey: key,
        memoryType: "episode_summary",
        category: "episode",
        content: ep.content,
        importanceScore: ep.importanceScore,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        seenCount: 1,
        checkpointCount: 1,
      });
    }
  }

  // Evaluate: promote, discard, or keep pending
  const pending: PendingMemoryCandidate[] = [];
  const promoted: PendingMemoryCandidate[] = [];

  for (const candidate of candidateMap.values()) {
    if (shouldDiscard(candidate, now)) {
      log.info({ key: candidate.candidateKey }, "Candidate discarded");
      continue;
    }
    if (shouldPromote(candidate)) {
      promoted.push(candidate);
    } else {
      pending.push(candidate);
    }
  }

  // Cap pending candidates
  const sorted = pending.sort((a, b) => {
    if (b.seenCount !== a.seenCount) return b.seenCount - a.seenCount;
    if ((b.importanceScore || 0) !== (a.importanceScore || 0)) {
      return (b.importanceScore || 0) - (a.importanceScore || 0);
    }
    return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime();
  });

  return {
    pending: sorted.slice(0, MAX_PENDING_CANDIDATES),
    promoted,
  };
};

// ===================
// MAIN NODE
// ===================

export const memoryNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const { messages, summary, tokensSinceLastCheckpoint, pendingMemoryCandidates, userId } =
    state;

  let newSummary = summary;
  let newMessages = messages;
  let newTokenCounter = tokensSinceLastCheckpoint;
  let newPendingCandidates = pendingMemoryCandidates;

  // Step 1: Short-term summarization
  if (shouldSummarize(messages)) {
    log.info({ messageCount: messages.length }, "Summarizing messages");

    const { summary: summarized, droppedTokens } = await summarizeMessages(
      messages,
      summary,
    );
    newSummary = summarized;
    newMessages = messages.slice(-RAW_TAIL_COUNT);
    newTokenCounter += droppedTokens;

    log.info(
      { droppedTokens, newTokenCounter },
      "Messages summarized",
    );
  }

  // Step 2: Long-term checkpoint
  if (newTokenCounter >= CHECKPOINT_TOKEN_THRESHOLD) {
    log.info({ tokens: newTokenCounter }, "Running long-term checkpoint");

    // Extract memories
    const extraction = await extractMemories(newSummary, newMessages);
    log.info(
      { facts: extraction.facts.length, hasEpisode: !!extraction.episodeSummary },
      "Memories extracted",
    );

    // Update pending candidates
    const { pending, promoted } = updatePendingCandidates(
      pendingMemoryCandidates,
      extraction,
      new Date(),
    );

    // Persist promoted candidates
    for (const candidate of promoted) {
      await saveLongTermMemory(userId, candidate);
      log.info({ key: candidate.candidateKey }, "Candidate promoted to long-term");
    }

    newPendingCandidates = pending;
    newTokenCounter = 0; // Reset counter

    log.info(
      { promoted: promoted.length, pending: pending.length },
      "Checkpoint complete",
    );
  }

  return {
    messages: newMessages,
    summary: newSummary,
    tokensSinceLastCheckpoint: newTokenCounter,
    pendingMemoryCandidates: newPendingCandidates,
  };
};
