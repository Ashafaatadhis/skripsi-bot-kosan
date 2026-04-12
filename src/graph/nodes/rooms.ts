import { GraphStateType } from "../state.js";
import { llm } from "../../llm/index.js";
import { roomsPrompt } from "../../prompts/index.js";
import { createLogger } from "../../lib/logger.js";
import { getRoomsTools } from "../tools.js";
import { searchLongTermMemory } from "../../memory/longterm.js";

const log = createLogger("node-rooms");

/**
 * Agent khusus untuk menangani pencarian kosan, detail bangunan, 
 * daftar kamar, dan inisialisasi booking.
 */
export const roomsNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const { messages, summary, userId } = state;

  log.info({ userId }, "Rooms agent thinking...");

  const date = new Date().toLocaleDateString("id-ID");
  const time = new Date().toLocaleTimeString("id-ID");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // 1. Siapkan chain & tools (BATASI cuma tool milik room agent)
  const tools = await getRoomsTools();
  const chain = roomsPrompt.pipe(llm.bindTools(tools));

  // 3. Jalankan LLM
  const response = await chain.invoke({
    messages,
    summary: summary ? `Konteks ringkasan:\n${summary}` : "",
    currentDate: new Date().toLocaleDateString("id-ID"),
    currentTime: new Date().toLocaleTimeString("id-ID"),
    currentTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  return {
    messages: [response],
  };
};
