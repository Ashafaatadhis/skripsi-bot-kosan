import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

export const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec,

  // Short-term memory
  summary: Annotation<string>({
    reducer: (_, b) => b ?? "",
    default: () => "",
  }),

  // Routing
  next: Annotation<string>({
    reducer: (_, b) => b ?? "",
    default: () => "",
  }),

  // Long-term memory counter
  tokensSinceLastMemorySave: Annotation<number>({
    reducer: (_, b) => b ?? 0,
    default: () => 0,
  }),

  // HITL
  confirmationDecision: Annotation<"pending" | "confirmed" | "rejected">({
    reducer: (_, b) => b ?? "pending",
    default: () => "pending",
  }),

  // Error rerouting
  forceSupervisorReroute: Annotation<boolean>({
    reducer: (_, b) => b ?? false,
    default: () => false,
  }),
  rerouteReason: Annotation<string>({
    reducer: (_, b) => b ?? "",
    default: () => "",
  }),

  // User context (injected per request)
  userId: Annotation<string>({
    reducer: (_, b) => b ?? "",
    default: () => "",
  }),
  role: Annotation<"tenant" | "owner">({
    reducer: (_, b) => b ?? "tenant",
    default: () => "tenant",
  }),
});

export type GraphStateType = typeof GraphState.State;
