import { END, START, StateGraph, MemorySaver } from "@langchain/langgraph"; 
import { HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import { GraphState, GraphStateType } from "./state.js";
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
import { mediaExtractorNode } from "./nodes/media.js";
import { getAllTools, hasAnyToolCall, hasWriteToolCall } from "./tools.js";
import { createLogger } from "../lib/logger.js";
import { ToolMessage } from "@langchain/core/messages";
import { callSecureMcpTool } from "../mcp/client.js";

const log = createLogger("graph");

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

const routeAfterTools = (state: GraphStateType) => {
  const messages = state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { tool_calls?: Array<{ name: string }> };
    const toolCall = msg.tool_calls?.[0];
    if (!toolCall) continue;

    if (toolCall.name === "search_long_term_memory") return "general";
    if (["get_profile", "update_profile"].includes(toolCall.name)) return "profile";
    if (["search_houses", "get_house_detail", "get_room_detail", "search_rooms", "create_booking"].includes(toolCall.name)) return "rooms";
  }

  return END;
};

const routeAfterResolveConfirmation = (state: GraphStateType) => {
  if (state.next === "execute_pending") return "execute_pending";
  return END;
};

const buildGraph = async () => {
  const allTools = await getAllTools();
  
  // Custom Secure Tool Node (Middleware)
  const secureToolNode = async (state: GraphStateType) => {
    const { messages, userId } = state;
    const lastMessage = messages[messages.length - 1] as AIMessage;
    const toolCalls = lastMessage.tool_calls;
    
    if (!toolCalls || toolCalls.length === 0) {
      log.warn("secureToolNode called but no tool calls found in last message");
      return { messages: [] };
    }

    try {
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

          log.info({ toolName: tc.name, userId, args: tc.args }, "Executing secure tool call");
          
          try {
            const result = await callSecureMcpTool(userId, tc.name, tc.args);
            log.info({ toolName: tc.name, resultType: typeof result }, "Tool invocation successful");
            
            // Log a bit of the result to see the structure
            const resultStr = typeof result === "string" ? result : JSON.stringify(result);
            log.info({ toolName: tc.name, resultSnippet: resultStr.slice(0, 100) }, "Result processed");

            return new ToolMessage({
              tool_call_id: tc.id ?? "",
              content: resultStr,
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

      return { messages: toolMessages };
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
    .addNode("tools", secureToolNode)
    .addNode("confirm_action", prepareConfirmationNode)
    .addNode("resolve_confirmation", resolveConfirmationNode)
    .addNode("execute_pending", executePendingActionNode)
    .addNode("media_extractor", mediaExtractorNode)

    .addEdge(START, "memory")
    .addEdge("memory", "supervisor")

    .addConditionalEdges("supervisor", (state: GraphStateType) => state.next, {
      general: "general",
      profile: "profile",
      rooms: "rooms",
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

    .addEdge("confirm_action", END)
    .addConditionalEdges("resolve_confirmation", routeAfterResolveConfirmation, {
      execute_pending: "execute_pending",
      [END]: END,
    })
    .addEdge("execute_pending", END)

    .addEdge("tools", "media_extractor")
    .addConditionalEdges("media_extractor", routeAfterTools, {
      general: "general",
      profile: "profile",
      rooms: "rooms",
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
): Promise<{ text: string; imageUrls: string[] }> => {
  const graph = await getCompiledGraph();
  const threadId = chatId;

  log.info({ threadId, userId }, "Running chat");

  const result = await graph.invoke(
    {
      messages: [new HumanMessage(message)],
      userId,
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
