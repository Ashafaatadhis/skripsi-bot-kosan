import { FactCategory } from "../config/memory.js";

export interface ExtractedFact {
  category: FactCategory;
  canonicalKey: string;
  content: string;
  confidence?: number;
  importanceScore?: number;
}

export interface ExtractedEpisode {
  topicKey: string;
  content: string;
  importanceScore?: number;
}

export interface MemoryExtraction {
  facts: ExtractedFact[];
  episodeSummary: ExtractedEpisode | null;
}

export interface LongTermMemory {
  id: string;
  userId: string;
  content: string;
  memoryType: "fact" | "episode_summary";
  category: string;
  canonicalKey?: string;
  confidence?: number;
  importanceScore?: number;
  mentionCount: number;
  lastConfirmedAt: Date;
  expiresAt?: Date;
  createdAt: Date;
}
