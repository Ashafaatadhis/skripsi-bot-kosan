import { BaseMessage, getBufferString } from "@langchain/core/messages";
import { GraphStateType } from "../state.js";
import { llm } from "../../llm/index.js";
import { supervisorPrompt, AGENTS } from "../../prompts/index.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("supervisor");

// formatMessages dihapus karena sudah menggunakan getBufferString bawaan LangChain

export const supervisorNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const { messages, summary, pendingAction } = state;

  if (pendingAction) {
    log.info({ pendingAction: pendingAction.toolName }, "Routing to confirmation resolver");
    return { next: "resolve_confirmation" };
  }

  const chain = supervisorPrompt.pipe(llm);
  const result = await chain.invoke({
    agents: AGENTS.join(", "),
    summary: summary ? `Konteks sebelumnya:\n${summary}` : "",
    conversation: getBufferString(messages),
  });

  const response = String(result.content).trim().toLowerCase();
  const next = AGENTS.includes(response as (typeof AGENTS)[number]) ? response : "general";

  log.info({ selectedAgent: next }, "Supervisor routed");

  return { next };
};
