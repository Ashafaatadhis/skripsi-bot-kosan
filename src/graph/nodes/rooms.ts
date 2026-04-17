import { randomUUID } from "node:crypto";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { GraphStateType } from "../state.js";
import { llm } from "../../llm/index.js";
import { roomsPrompt } from "../../prompts/index.js";
import { createLogger } from "../../lib/logger.js";
import { toTextOnlyMessage, toTextOnlyMessages } from "../../lib/formatter.js";
import { getRoomsTools } from "../tools.js";

const log = createLogger("node-rooms");

const ROOM_ID_REGEX = /\bRM-[A-Z0-9]+\b/i;
const DATE_ONLY_REGEX = /\b\d{4}-\d{2}-\d{2}\b/;

const buildToolCallMessage = (
  toolName: string,
  args: Record<string, unknown>,
): AIMessage =>
  new AIMessage({
    content: "",
    tool_calls: [
      {
        id: `call_${randomUUID()}`,
        name: toolName,
        args,
        type: "tool_call",
      },
    ],
  });

const getLatestHumanText = (messages: GraphStateType["messages"]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = toTextOnlyMessage(messages[i]);
    if (msg instanceof HumanMessage && typeof msg.content === "string") {
      return msg.content.trim();
    }
  }

  return "";
};

const isLatestMessageHuman = (messages: GraphStateType["messages"]): boolean => {
  const lastMessage = messages[messages.length - 1];
  return lastMessage?.getType?.() === "human";
};

/**
 * Agent khusus untuk menangani pencarian kosan, detail bangunan, 
 * daftar kamar, dan inisialisasi sewa.
 */
export const roomsNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const { messages, summary, userId, pendingRentalDraft } = state;
  const textMessages = toTextOnlyMessages(messages);
  const latestHumanText = getLatestHumanText(messages);
  const latestMessageIsHuman = isLatestMessageHuman(messages);
  const detectedRoomId = latestHumanText.match(ROOM_ID_REGEX)?.[0]?.toUpperCase() ?? "";
  const detectedStartDate = latestHumanText.match(DATE_ONLY_REGEX)?.[0] ?? "";

  const nextDraftRoomId = detectedRoomId || pendingRentalDraft.roomId;
  const shouldResetStartDate =
    detectedRoomId &&
    detectedRoomId !== pendingRentalDraft.roomId &&
    !detectedStartDate;
  const nextDraftStartDate = shouldResetStartDate
    ? ""
    : detectedStartDate || pendingRentalDraft.startDate;

  log.info({ userId }, "Rooms agent thinking...");

  if (latestMessageIsHuman && nextDraftRoomId && nextDraftStartDate) {
    log.info(
      { roomId: nextDraftRoomId, startDate: nextDraftStartDate },
      "Rental draft complete; creating rental tool call deterministically",
    );

    return {
      messages: [
        buildToolCallMessage("create_rental", {
          roomId: nextDraftRoomId,
          startDate: nextDraftStartDate,
        }),
      ],
      pendingRentalDraft: {
        roomId: nextDraftRoomId,
        startDate: nextDraftStartDate,
      },
      awaitingRentalStartDate: false,
    };
  }

  // 1. Siapkan chain & tools (BATASI cuma tool milik room agent)
  const tools = await getRoomsTools();
  const chain = roomsPrompt.pipe(llm.bindTools(tools));

  // 3. Jalankan LLM
  const response = await chain.invoke({
    messages: textMessages,
    summary: summary ? `Konteks ringkasan:\n${summary}` : "",
    currentDate: new Date().toLocaleDateString("id-ID"),
    currentTime: new Date().toLocaleTimeString("id-ID"),
    currentTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  return {
    messages: [response],
    pendingRentalDraft: {
      roomId: nextDraftRoomId,
      startDate: nextDraftStartDate,
    },
    awaitingRentalStartDate: Boolean(nextDraftRoomId && !nextDraftStartDate),
  };
};
