import { GraphStateType } from "../state.js";
import { SystemMessage } from "@langchain/core/messages";
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
  const { messages, summary, userId, visionAnalysis } = state;
  const time = getTimeContext();
  const textMessages = toTextOnlyMessages(messages);

  const tools = await getGeneralTools();
  const allowedToolNames = new Set(tools.map((tool) => String(tool.name)));
  const llmWithTools = tools.length > 0 ? llm.bindTools(tools) : llm;

  const prompt = await generalPrompt.invoke({
    ...time,
    userId,
    summary: summary ? `Konteks percakapan:\n${summary}` : "",
    visionContext: visionAnalysis
      ? `Hasil analisis gambar untuk turn ini:\n${visionAnalysis}`
      : "",
    longTermContext: "Gunakan tool search_long_term_memory kalau perlu recall konteks lama.",
    messages: textMessages,
  });

  let response = await llmWithTools.invoke(prompt);
  const disallowedToolCalls =
    response.tool_calls?.filter((toolCall) => !allowedToolNames.has(String(toolCall.name))) ?? [];

  if (disallowedToolCalls.length > 0) {
    log.warn(
      {
        userId,
        disallowedToolCalls: disallowedToolCalls.map((toolCall) => toolCall.name),
        allowedToolNames: Array.from(allowedToolNames),
      },
      "General agent attempted to call tools outside its whitelist; retrying without tools",
    );

    response = await llm.invoke([
      ...prompt.messages,
      new SystemMessage(
        "Jawab ulang pesan user terakhir tanpa tool call apa pun. Jangan memanggil tool transaksi, profil, pembayaran, atau sewa.",
      ),
    ]);
  }

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
