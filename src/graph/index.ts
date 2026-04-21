import { END, START, StateGraph, MemorySaver } from "@langchain/langgraph"; 
import { HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import { GraphState, GraphStateType, PendingPaymentSnapshot } from "./state.js";
import { memoryNode } from "./nodes/memory.js";
import { supervisorNode } from "./nodes/supervisor.js";
import { generalNode } from "./nodes/general.js";
import { profileNode } from "./nodes/profile.js";
import { roomsNode } from "./nodes/rooms.js";
import {
  prepareConfirmationNode,
  resolveConfirmationNode,
  executePendingActionNode,
} from "./nodes/confirm.js";
import { paymentsNode } from "./nodes/payments.js";
import { mediaExtractorNode } from "./nodes/media.js";
import { visionProcessorNode } from "./nodes/vision.js";
import {
  clarifyNode,
  resolveClarificationNode,
} from "./nodes/clarify.js";
import { getAllTools, hasAnyToolCall, hasWriteToolCall } from "./tools.js";
import { createLogger } from "../lib/logger.js";
import { ToolMessage } from "@langchain/core/messages";
import { callSecureMcpTool } from "../mcp/client.js";

const log = createLogger("graph");

type McpTextContent = {
  type?: string;
  text?: string;
};

type McpToolResult = {
  content?: McpTextContent[];
};

type PendingPaymentPayload = {
  humanId?: string;
  monthsPaid?: number;
  amount?: number;
  periodStart?: string;
  periodEnd?: string;
  status?: string;
  note?: string;
};

type PaymentToolState = {
  activePaymentId: string;
  pendingPaymentsSnapshot: PendingPaymentSnapshot[];
};

const parseJsonIfPossible = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const normalizeMcpToolResult = (result: unknown): string => {
  if (typeof result === "string") {
    const normalized = parseJsonIfPossible(result);
    return typeof normalized === "string"
      ? normalized
      : JSON.stringify(normalized);
  }

  if (result === undefined) {
    return "null";
  }

  if (result === null) {
    return "null";
  }

  if (typeof result !== "object") {
    return String(result);
  }

  const maybeMcpResult = result as McpToolResult;
  const textPayload = maybeMcpResult.content?.find(
    (item) => item?.type === "text" && typeof item.text === "string",
  )?.text;

  if (!textPayload) {
    return JSON.stringify(result);
  }

  const normalized = parseJsonIfPossible(textPayload);
  return typeof normalized === "string"
    ? normalized
    : JSON.stringify(normalized);
};

const parsePendingPaymentsSnapshot = (
  normalizedResult: string,
): PendingPaymentSnapshot[] => {
  try {
    const parsed = JSON.parse(normalizedResult) as {
      payments?: PendingPaymentPayload[];
    };

    return (parsed.payments ?? [])
      .filter((payment) => typeof payment.humanId === "string")
      .map(
        (payment): PendingPaymentSnapshot => ({
          paymentId: payment.humanId as string,
          monthsPaid: payment.monthsPaid,
          amount: payment.amount,
          periodStart: payment.periodStart,
          periodEnd: payment.periodEnd,
          status: payment.status,
          note: payment.note,
        }),
      );
  } catch {
    return [];
  }
};

const updatePaymentStateFromToolResult = (
  toolName: string,
  toolArgs: Record<string, unknown>,
  normalizedResult: string,
  currentState: PaymentToolState,
): PaymentToolState => {
  if (toolName === "get_pending_payments") {
    const pendingPaymentsSnapshot = parsePendingPaymentsSnapshot(normalizedResult);
    const activePaymentId =
      pendingPaymentsSnapshot.length === 1 && pendingPaymentsSnapshot[0]?.paymentId
        ? pendingPaymentsSnapshot[0].paymentId
        : currentState.activePaymentId;

    return {
      activePaymentId,
      pendingPaymentsSnapshot,
    };
  }

  if (toolName === "get_payment_status" && typeof toolArgs.paymentId === "string") {
    return {
      ...currentState,
      activePaymentId: toolArgs.paymentId,
    };
  }

  if (toolName === "create_payment") {
    try {
      const parsed = JSON.parse(normalizedResult) as {
        payment?: { humanId?: string };
      };

      if (typeof parsed.payment?.humanId === "string") {
        return {
          ...currentState,
          activePaymentId: parsed.payment.humanId,
        };
      }
    } catch {
      return currentState;
    }
  }

  return currentState;
};

const routeAfterGeneral = (state: GraphStateType) => {
  const lastMessage = state.messages[state.messages.length - 1];
  if (hasAnyToolCall(lastMessage)) return "tools";
  return END;
};

const routeAfterProfile = (state: GraphStateType) => {
  const lastMessage = state.messages[state.messages.length - 1];
  if (hasWriteToolCall(lastMessage)) return "confirm_action";
  if (hasAnyToolCall(lastMessage)) return "tools";
  return END;
};

const routeAfterRooms = (state: GraphStateType) => {
  const lastMessage = state.messages[state.messages.length - 1];
  if (hasWriteToolCall(lastMessage)) return "confirm_action";
  if (hasAnyToolCall(lastMessage)) return "tools";
  return END;
};

const routeAfterPayments = (state: GraphStateType) => {
  const lastMessage = state.messages[state.messages.length - 1];
  if (hasWriteToolCall(lastMessage)) return "confirm_action";
  if (hasAnyToolCall(lastMessage)) return "tools";
  return END;
};

const routeAfterTools = (state: GraphStateType) => {
  const messages = state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { tool_calls?: Array<{ name: string }> };
    const toolCall = msg.tool_calls?.[0];
    if (!toolCall) continue;

    if (toolCall.name === "search_long_term_memory") return "general";
    if (["get_profile", "update_profile"].includes(toolCall.name)) return "profile";
    if ([
      "search_houses",
      "get_house_detail",
      "get_room_detail",
      "search_rooms",
      "create_rental",
      "get_my_rentals",
      "get_rental_status",
      "cancel_rental",
      "end_rental",
    ].includes(toolCall.name)) return "rooms";
    if (["create_payment", "get_pending_payments", "get_payment_status", "get_payment_history", "upload_payment_proof"].includes(toolCall.name)) return "payments";
  }

  return END;
};

const routeAfterResolveConfirmation = (state: GraphStateType) => {
  if (state.next === "execute_pending") return "execute_pending";
  return END;
};

const routeAfterResolveClarification = (state: GraphStateType) => {
  if (state.next === "clarify") return "clarify";
  if (state.next === "general") return "general";
  if (state.next === "profile") return "profile";
  if (state.next === "rooms") return "rooms";
  if (state.next === "payments") return "payments";
  return END;
};

const buildGraph = async () => {
  // Custom Secure Tool Node (Middleware)
  const secureToolNode = async (state: GraphStateType) => {
    const {
      messages,
      userId,
      paymentProofImageUrl,
      activePaymentId,
      pendingPaymentsSnapshot,
    } = state;
    const lastMessage = messages[messages.length - 1] as AIMessage;
    const toolCalls = lastMessage.tool_calls;
    
    if (!toolCalls || toolCalls.length === 0) {
      log.warn("secureToolNode called but no tool calls found in last message");
      return { messages: [] };
    }

    try {
      const allTools = await getAllTools();
      let paymentToolState: PaymentToolState = {
        activePaymentId,
        pendingPaymentsSnapshot,
      };
      const toolMessages = await Promise.all(
        toolCalls.map(async (tc) => {
          const tool = allTools.find((t) => t.name === tc.name);
          if (!tool) {
            log.error({ toolName: tc.name }, "Tool not found in allTools");
            return new ToolMessage({
              tool_call_id: tc.id ?? "",
              content: "Tool not found",
            });
          }

          const toolArgs =
            tc.name === "upload_payment_proof" && paymentProofImageUrl
              ? { ...tc.args, imageUrl: paymentProofImageUrl }
              : tc.args;

          log.info({ toolName: tc.name, userId, args: toolArgs }, "Executing secure tool call");

          try {
            const result = await callSecureMcpTool(userId, tc.name, toolArgs);
            log.info({ toolName: tc.name, resultType: typeof result }, "Tool invocation successful");
            const normalizedResult = normalizeMcpToolResult(result);
            paymentToolState = updatePaymentStateFromToolResult(
              tc.name,
              toolArgs,
              normalizedResult,
              paymentToolState,
            );

            log.info(
              { toolName: tc.name, resultSnippet: normalizedResult.slice(0, 100) },
              "Result processed",
            );

            return new ToolMessage({
              tool_call_id: tc.id ?? "",
              content: normalizedResult,
            });
          } catch (error: any) {
            log.error({ error: error.message, toolName: tc.name }, "Tool execution crashed inside callSecureMcpTool");
            return new ToolMessage({
              tool_call_id: tc.id ?? "",
              content: `Error: ${error.message}`,
            });
          }
        })
      );

      return {
        messages: toolMessages,
        activePaymentId: paymentToolState.activePaymentId,
        pendingPaymentsSnapshot: paymentToolState.pendingPaymentsSnapshot,
      };
    } catch (error: any) {
      log.error({ error: error.message }, "Critical failure in secureToolNode Promise.all");
      throw error;
    }
  };

  const graph = new StateGraph(GraphState)
    .addNode("memory", memoryNode)
    .addNode("supervisor", supervisorNode)
    .addNode("general", generalNode)
    .addNode("profile", profileNode)
    .addNode("rooms", roomsNode)
    .addNode("payments", paymentsNode)
    .addNode("tools", secureToolNode)
    .addNode("confirm_action", prepareConfirmationNode)
    .addNode("resolve_confirmation", resolveConfirmationNode)
    .addNode("execute_pending", executePendingActionNode)
    .addNode("media_extractor", mediaExtractorNode)
    .addNode("vision", visionProcessorNode)
    .addNode("clarify", clarifyNode)
    .addNode("resolve_clarification", resolveClarificationNode)

    .addEdge(START, "memory")
    .addEdge("memory", "vision")
    .addEdge("vision", "supervisor")

    .addConditionalEdges("supervisor", (state: GraphStateType) => state.next, {
      general: "general",
      profile: "profile",
      rooms: "rooms",
      payments: "payments",
      clarify: "clarify",
      resolve_clarification: "resolve_clarification",
      resolve_confirmation: "resolve_confirmation",
    })

    .addConditionalEdges("general", routeAfterGeneral, {
      tools: "tools",
      [END]: END,
    })

    .addConditionalEdges("profile", routeAfterProfile, {
      confirm_action: "confirm_action",
      tools: "tools",
      [END]: END,
    })

    .addConditionalEdges("rooms", routeAfterRooms, {
      confirm_action: "confirm_action",
      tools: "tools",
      [END]: END,
    })

    .addConditionalEdges("payments", routeAfterPayments, {
      confirm_action: "confirm_action",
      tools: "tools",
      [END]: END,
    })

    .addEdge("confirm_action", END)
    .addConditionalEdges("resolve_confirmation", routeAfterResolveConfirmation, {
      execute_pending: "execute_pending",
      [END]: END,
    })
    .addEdge("clarify", END)
    .addConditionalEdges(
      "resolve_clarification",
      routeAfterResolveClarification,
      {
        clarify: "clarify",
        general: "general",
        profile: "profile",
        rooms: "rooms",
        payments: "payments",
        [END]: END,
      },
    )
    .addEdge("execute_pending", END)

    .addEdge("tools", "media_extractor")
    .addConditionalEdges("media_extractor", routeAfterTools, {
      general: "general",
      profile: "profile",
      rooms: "rooms",
      payments: "payments",
      [END]: END,
    });

  return graph;
};

let checkpointer: any = null;

const getCheckpointer = async (): Promise<any> => {
  if (!checkpointer) {
    if (process.env.NODE_ENV === "production") {
      const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
      checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL!);
      await checkpointer.setup();
      log.info("Production: PostgreSQL checkpointer initialized");
    } else {
      checkpointer = new MemorySaver();
      log.info("Development: In-memory checkpointer initialized");
    }
  }
  return checkpointer;
};

let compiledGraph: ReturnType<
  Awaited<ReturnType<typeof buildGraph>>["compile"]
> | null = null;

const getCompiledGraph = async () => {
  if (!compiledGraph) {
    const saver = await getCheckpointer();
    const graph = await buildGraph();
    compiledGraph = graph.compile({ checkpointer: saver });
    log.info("Graph compiled");
  }
  return compiledGraph;
};

export const runChat = async (
  userId: string,
  chatId: string,
  message: string,
  images: string[] = [],
  paymentProofImageUrl = "",
): Promise<{ text: string; imageUrls: string[] }> => {
  const graph = await getCompiledGraph();
  const threadId = chatId;

  log.info({ threadId, userId, hasImages: images.length > 0 }, "Running chat");

  const imageParts = images
    .filter((image) => {
      const isBase64Image = image.startsWith("data:image/");
      if (!isBase64Image) {
        log.warn({ image }, "Skipping non-base64 image input");
      }
      return isBase64Image;
    })
    .map((image) => ({
      type: "image_url",
      image_url: {
        url: image,
      },
    }));

  const content = imageParts.length > 0
    ? [{ type: "text", text: message }, ...imageParts]
    : message;

  if (imageParts.length > 0) {
    log.info({ imageCount: imageParts.length }, "Base64 images attached to message");
  }

  const result = await graph.invoke(
    {
      messages: [new HumanMessage(content)],
      userId,
      visionAnalysis: "", // Reset vision analysis for this turn
      visionResult: null, // Reset structured vision result for this turn
      paymentProofImageUrl, // Reset proof image URL for this turn
      imageUrls: [], // Reset images for this turn
    },
    {
      configurable: { thread_id: threadId },
    },
  );

  const messages = result.messages as BaseMessage[];
  let text = "Maaf, terjadi kesalahan.";

  // 1. Dapatkan teks balasan terakhir dari AI
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg instanceof AIMessage && msg.content && typeof msg.content === "string") {
      text = msg.content;
      break;
    }
  }

  return { text, imageUrls: result.imageUrls || [] };
};

export const initGraph = async (): Promise<void> => {
  await getCompiledGraph();
};
