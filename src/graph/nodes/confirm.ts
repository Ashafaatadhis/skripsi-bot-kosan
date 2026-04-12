import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { GraphStateType, PendingAction } from "../state.js";
import { getAllTools, isWriteTool } from "../tools.js";
import { createLogger } from "../../lib/logger.js";
import { callSecureMcpTool } from "../../mcp/client.js";

const log = createLogger("confirm");

const CONFIRM_KEYWORDS = [
  "ya", "yes", "oke", "ok", "iya", "yup", "setuju", "lanjut", "konfirmasi",
  "boleh", "sip", "gas", "okey", "acc", "pastikan", "mantap", "bolehdeh",
];
const CANCEL_KEYWORDS = [
  "tidak", "no", "batal", "cancel", "jangan", "gak", "nggak", "enggak",
  "nanti", "skip", "stop", "hentikan", "belumpengen", "gakjadi", "nantiaja",
];

const isConfirmation = (text: string): boolean => {
  const lower = text.toLowerCase().trim();
  const words = lower.split(/\s+/);
  const confirmPhrases = ["boleh deh", "oke deh", "siap bos", "lanjut aja", "gas terus"];
  return (
    CONFIRM_KEYWORDS.some((kw) => words.includes(kw)) ||
    confirmPhrases.some((p) => lower.includes(p))
  );
};

const isCancellation = (text: string): boolean => {
  const lower = text.toLowerCase().trim();
  const words = lower.split(/\s+/);
  const cancelPhrases = ["gak jadi", "nggak jadi", "nanti aja", "jangan dulu", "batalin aja", "ga jadi"];
  return (
    CANCEL_KEYWORDS.some((kw) => words.includes(kw)) ||
    cancelPhrases.some((p) => lower.includes(p))
  );
};

const getActionDescription = (toolName: string, args: Record<string, unknown>): string => {
  switch (toolName) {
    case "update_profile": {
      const updates: string[] = [];
      if (args.name) updates.push(`nama menjadi "${args.name}"`);
      if (args.phone) updates.push(`nomor HP menjadi "${args.phone}"`);
      return `mengubah ${updates.join(" dan ")}`;
    }
    default:
      return `menjalankan ${toolName}`;
  }
};

const getLastWriteToolCall = (state: GraphStateType) => {
  const lastMessage = state.messages[state.messages.length - 1];
  if (!(lastMessage instanceof AIMessage) || !lastMessage.tool_calls?.length) {
    return null;
  }
  return lastMessage.tool_calls.find((tc) => isWriteTool(tc.name)) ?? null;
};

export const prepareConfirmationNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const writeToolCall = getLastWriteToolCall(state);

  if (!writeToolCall) {
    log.warn("No write tool call found for confirmation");
    return {
      messages: [new AIMessage("Hmm, gak ada aksi yang perlu dikonfirmasi nih 🤔")],
      pendingAction: null,
    };
  }

  const pendingAction: PendingAction = {
    toolName: writeToolCall.name,
    toolArgs: writeToolCall.args as Record<string, unknown>,
    description: getActionDescription(
      writeToolCall.name,
      writeToolCall.args as Record<string, unknown>,
    ),
  };

  log.info({ pendingAction }, "Prepared confirmation for write action");

  return {
    messages: [
      new AIMessage(
        `Boleh aku bantu ${pendingAction.description}? 🤔\n\nKetik "ya" kalau oke, atau "nggak" kalau mau dibatalin yaa!`,
      ),
    ],
    pendingAction,
  };
};

export const resolveConfirmationNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const { pendingAction, messages } = state;

  if (!pendingAction) {
    log.warn("No pending action to resolve");
    return {
      messages: [new AIMessage("Hmm, gak ada aksi yang lagi nunggu konfirmasi nih 🤔")],
      next: "end",
      pendingAction: null,
    };
  }

  const lastMessage = messages[messages.length - 1];
  const userText = lastMessage instanceof HumanMessage ? String(lastMessage.content) : "";

  if (isCancellation(userText)) {
    log.info({ pendingAction: pendingAction.toolName }, "User cancelled action");
    return {
      messages: [new AIMessage("Okeee, batal dulu yaa 👌")],
      next: "end",
      pendingAction: null,
    };
  }

  if (isConfirmation(userText)) {
    log.info({ pendingAction: pendingAction.toolName }, "User confirmed action");
    return { next: "execute_pending" };
  }

  return {
    messages: [
      new AIMessage(
        `Eh, aku masih nunggu konfirmasi nih buat ${pendingAction.description}... 🤔\n\nJadi dilanjut "ya" atau "nggak" aja nih?`,
      ),
    ],
    next: "end",
    pendingAction,
  };
};

export const executePendingActionNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const { pendingAction, userId } = state;

  if (!pendingAction) {
    log.warn("No pending action to execute");
    return {
      messages: [new AIMessage("Hmm, gak ada yang perlu dijalanin nih 🤔")],
      pendingAction: null,
    };
  }

  log.info({ pendingAction }, "Executing confirmed action");

  try {
    const allTools = await getAllTools();
    const tool = allTools.find((t) => t.name === pendingAction.toolName);

    if (!tool) {
      log.error({ toolName: pendingAction.toolName }, "Tool not found");
      return {
        messages: [new AIMessage("Yah, tool-nya gak ketemu 😅 Coba lagi ya.")],
        pendingAction: null,
      };
    }

    const result = await callSecureMcpTool(userId, pendingAction.toolName, pendingAction.toolArgs);

    const resultText = typeof result === "string" ? result : JSON.stringify(result);
    log.info({ toolName: pendingAction.toolName, result: resultText }, "Action executed successfully");

    let responseText = "Sip, berhasil yaa ✨";
    
    // Gunakan result langsung karena sekarang sudah berupa objek dari callSecureMcpTool
    if (result && typeof result === 'object' && 'content' in result && Array.isArray(result.content) && result.content.length > 0) {
      responseText = result.content[0].text;
    } else {
      try {
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        if (parsed.message) {
          responseText = parsed.message;
        } else if (parsed.profile) {
          responseText = `Sip, profil kamu udah ke-update ✨\nNama: ${parsed.profile.name}\nHP: ${parsed.profile.phone || "-"}`;
        }
      } catch {
        responseText = "Oke, aksinya udah berhasil dijalanin ✨";
      }
    }

    return {
      messages: [new AIMessage(responseText)],
      pendingAction: null,
    };
  } catch (error) {
    log.error({ error, pendingAction }, "Failed to execute action");
    return {
      messages: [new AIMessage("Aduh, tadi ada error pas jalanin aksinya 😅 Coba ulang lagi ya.")],
      pendingAction: null,
    };
  }
};
