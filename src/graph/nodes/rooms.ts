import { GraphStateType } from "../state.js";
import { llm } from "../../llm/index.js";
import { buildRuntimeContext, roomsPrompt } from "../../prompts/index.js";
import { createLogger } from "../../lib/logger.js";
import { getTimeContext } from "../../lib/time.js";
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
  const time = getTimeContext();

  log.info({ userId }, "Rooms agent thinking...");

  const tools = await getRoomsTools();
  const chain = roomsPrompt.pipe(llm.bindTools(tools));
  const runtimeContext = buildRuntimeContext([
    ["WAKTU", `${time.currentDate} ${time.currentTime} (${time.currentTimezone})`],
    ["USER_ID", userId],
    ["SUMMARY", summary ? `Konteks ringkasan:\n${summary}` : ""],
  ]);

  const response = await chain.invoke({
    messages: textMessages,
    runtimeContext,
  });

  return {
    messages: [response],
  };
};
