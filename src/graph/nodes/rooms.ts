import { GraphStateType } from "../state.js";
import { llm } from "../../llm/index.js";
import { roomsPrompt } from "../../prompts/index.js";
import { createLogger } from "../../lib/logger.js";
import { toTextOnlyMessages } from "../../lib/formatter.js";
import { getRoomsTools } from "../tools.js";

const log = createLogger("node-rooms");

/**
 * Agent khusus untuk pencarian kosan, detail bangunan,
 * daftar kamar, dan alur sewa kamar.
 */
export const roomsNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const { messages, summary, userId } = state;
  const textMessages = toTextOnlyMessages(messages);

  log.info({ userId }, "Rooms agent thinking...");

  const tools = await getRoomsTools();
  const chain = roomsPrompt.pipe(llm.bindTools(tools));

  const response = await chain.invoke({
    messages: textMessages,
    summary: summary ? `Konteks ringkasan:\n${summary}` : "",
    currentDate: new Date().toLocaleDateString("id-ID"),
    currentTime: new Date().toLocaleTimeString("id-ID"),
    currentTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  return {
    messages: [response],
  };
};
