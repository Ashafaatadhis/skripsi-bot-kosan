import { GraphStateType } from "../state.js";
import { llm } from "../../llm/index.js";
import { generalPrompt } from "../../prompts/index.js";
import { getTimeContext } from "../../lib/time.js";
import { createLogger } from "../../lib/logger.js";
import { toTextOnlyMessages } from "../../lib/formatter.js";
import { getGeneralTools } from "../tools.js";

const log = createLogger("general-agent");

export const generalNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const { messages, summary, userId } = state;
  const time = getTimeContext();
  const textMessages = toTextOnlyMessages(messages);

  const tools = await getGeneralTools();
  const llmWithTools = tools.length > 0 ? llm.bindTools(tools) : llm;

  const prompt = await generalPrompt.invoke({
    ...time,
    userId,
    summary: summary ? `Konteks percakapan:\n${summary}` : "",
    longTermContext: "Gunakan tool search_long_term_memory kalau perlu recall konteks lama.",
    messages: textMessages,
  });

  const response = await llmWithTools.invoke(prompt);

  log.info(
    {
      hasToolCalls: !!(response.tool_calls && response.tool_calls.length > 0),
      toolCalls: response.tool_calls?.map((t) => t.name),
    },
    "General agent responded",
  );

  return {
    messages: [response],
  };
};
