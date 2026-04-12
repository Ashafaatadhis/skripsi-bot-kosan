import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { FactCategory } from "../config/memory.js";

// Pending action for confirmation
export interface PendingAction {
  toolName: string;
  toolArgs: Record<string, unknown>;
  description: string; // Human-readable description for confirmation
}

// Pending memory candidate structure
export interface PendingMemoryCandidate {
  candidateKey: string; // "fact:profile.nama" or "episode:searching_room"
  memoryType: "fact" | "episode_summary";
  category: FactCategory | "episode";
  canonicalKey?: string; // For facts only
  content: string;
  confidence?: number;
  importanceScore?: number;
  firstSeenAt: string; // ISO timestamp
  lastSeenAt: string; // ISO timestamp
  seenCount: number; // How many times extracted
  checkpointCount: number; // How many checkpoints survived
}

export const GraphState = Annotation.Root({
  // Conversation
  messages: Annotation<BaseMessage[]>({
    reducer: (curr, update) => [...curr, ...update],
    default: () => [],
  }),

  // Short-term memory
  summary: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  // Token counter for checkpoint trigger
  tokensSinceLastCheckpoint: Annotation<number>({
    reducer: (_, update) => update,
    default: () => 0,
  }),

  // Pending candidates for long-term
  pendingMemoryCandidates: Annotation<PendingMemoryCandidate[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  // User info
  userId: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  // Routing
  next: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  // Images found during tool execution (reset each turn)
  imageUrls: Annotation<string[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  // Pending action awaiting confirmation
  pendingAction: Annotation<PendingAction | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),
});

export type GraphStateType = typeof GraphState.State;
