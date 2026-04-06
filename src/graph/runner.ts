import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { getMcpTools } from "../mcp/client";
import { createTraceLogger } from "../logging/logger";
import type { TraceContext } from "../logging/logger";
import { buildGraph } from "./graph";

let graph: ReturnType<typeof buildGraph> | null = null;

async function getGraph(trace: TraceContext = {}) {
  if (graph) return graph;

  const log = createTraceLogger("graph-runner", trace);
  log.info({ event: "graph_init_start" }, "Initializing LangGraph runtime");

  const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL!);
  await checkpointer.setup();

  const mcpTools = await getMcpTools();
  graph = buildGraph(checkpointer, mcpTools);

  log.info(
    {
      event: "graph_init_success",
      toolCount: mcpTools.length,
    },
    "LangGraph runtime initialized",
  );

  return graph;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;

        if (
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }

        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
}

export async function runChat(
  params: {
    chatId: string;
    userText: string;
    userId: string;
    role: "tenant" | "owner";
  },
  trace: TraceContext = {},
): Promise<string> {
  const { chatId, userText, userId, role } = params;
  const log = createTraceLogger("graph-runner", {
    ...trace,
    chatId,
    userId,
    role,
  });

  const g = await getGraph({ ...trace, chatId, userId, role });
  const threadId = `${role}:${chatId}`;
  const config = { configurable: { thread_id: threadId } };

  log.info(
    {
      event: "graph_thread_selected",
      threadId,
    },
    "Selected LangGraph thread",
  );

  log.info({ event: "graph_invoke_start" }, "Starting graph invocation");

  const graphState = await g.getState(config);
  const hasActiveInterrupt = graphState.tasks.some(
    (t) => (t.interrupts?.length ?? 0) > 0,
  );

  log.info(
    {
      event: "graph_interrupt_state",
      hasActiveInterrupt,
      taskCount: graphState.tasks.length,
    },
    "Checked graph interrupt state",
  );

  const result = hasActiveInterrupt
    ? await g.invoke(new Command({ resume: userText }), config)
    : await g.invoke(
        { messages: [new HumanMessage(userText)], userId, role },
        config,
      );

  const postState = await g.getState(config);
  for (const task of postState.tasks ?? []) {
    for (const intr of task.interrupts ?? []) {
      const value = intr.value as { type?: string; prompt?: string };
      if (value?.type === "tool_confirmation") {
        log.info(
          {
            event: "graph_interrupt_prompt",
            prompt: value.prompt,
          },
          "Returning HITL confirmation prompt",
        );

        return value.prompt ?? "Konfirmasi diperlukan. Balas 'ya' atau 'batal'.";
      }
    }
  }

  const messages = result?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = extractTextContent(messages[i]?.content);
    if (text) {
      log.info(
        {
          event: "graph_invoke_success",
          messageCount: messages.length,
        },
        "Graph invocation completed with response",
      );
      return text;
    }
  }

  log.warn(
    {
      event: "graph_empty_response",
      messageCount: messages.length,
    },
    "Graph invocation returned no text response",
  );

  return "Maaf, saya belum bisa memberi respons yang valid. Coba lagi ya.";
}
