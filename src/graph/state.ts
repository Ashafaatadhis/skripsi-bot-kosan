import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { FactCategory } from "../config/memory.js";

export interface VisionResult {
  kind: "payment_proof" | "non_payment" | "unknown";
  confidence: number;
  summary: string;
  amount?: number;
  bank?: string;
  transferDate?: string;
  recipient?: string;
}

export interface PendingPaymentSnapshot {
  paymentId: string;
  monthsPaid?: number;
  amount?: number;
  periodStart?: string;
  periodEnd?: string;
  status?: string;
  note?: string;
}

export type PaymentStage = "idle" | "choosing_payment" | "awaiting_proof";

// Pending action for confirmation
export interface PendingAction {
  toolName: string;
  toolArgs: Record<string, unknown>;
  description: string; // Human-readable description for confirmation
  paymentProofImageUrl?: string;
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

  // Vision analysis derived from the current turn's image input
  visionAnalysis: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  // Structured vision result for the current turn
  visionResult: Annotation<VisionResult | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),

  // Temporary payment proof image URL captured from the current turn
  paymentProofImageUrl: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  // Last payment ID explicitly selected by the user or inferred from a single pending bill
  activePaymentId: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  // Snapshot of pending payments from the latest get_pending_payments result
  pendingPaymentsSnapshot: Annotation<PendingPaymentSnapshot[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  // Current payment flow stage for deterministic follow-up handling
  paymentStage: Annotation<PaymentStage>({
    reducer: (_, update) => update,
    default: () => "idle",
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
