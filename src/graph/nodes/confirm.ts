import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { GraphStateType, PendingAction } from "../state.js";
import { getAllTools, isWriteTool } from "../tools.js";
import { createLogger } from "../../lib/logger.js";
import { callSecureMcpTool } from "../../mcp/client.js";

const log = createLogger("confirm");
 
const escapeHtml = (text: string): string => {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

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
      if (args.name) updates.push(`nama menjadi "<b>${escapeHtml(String(args.name))}</b>"`);
      if (args.phone) updates.push(`nomor HP menjadi "<b>${escapeHtml(String(args.phone))}</b>"`);
      return `mengubah ${updates.join(" dan ")}`;
    }
    case "create_booking": {
      return `mem-booking kamar <b>${escapeHtml(String(args.roomId))}</b> mulai tanggal <b>${escapeHtml(String(args.startDate))}</b> selama <b>${args.duration} bulan</b>`;
    }
    case "cancel_booking": {
      return `membatalkan booking <b>${escapeHtml(String(args.bookingId))}</b>`;
    }
    case "upload_payment_proof": {
      return `mengunggah bukti pembayaran untuk tagihan <b>${escapeHtml(String(args.paymentId))}</b>`;
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

const getHumanTextContent = (message: HumanMessage): string => {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
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
    paymentProofImageUrl:
      writeToolCall.name === "upload_payment_proof"
        ? state.paymentProofImageUrl || undefined
        : undefined,
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
  const userText = lastMessage instanceof HumanMessage ? getHumanTextContent(lastMessage) : "";

  if (isCancellation(userText)) {
    log.info({ pendingAction: pendingAction.toolName, userText }, "User cancelled action");
    return {
      messages: [new AIMessage("Okeee, batal dulu yaa 👌")],
      next: "end",
      pendingAction: null,
    };
  }

  if (isConfirmation(userText)) {
    log.info({ pendingAction: pendingAction.toolName, userText }, "User confirmed action");
    return { next: "execute_pending" };
  }

  log.info({ pendingAction: pendingAction.toolName, userText }, "User confirmation input not recognized");

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
  const { pendingAction, userId, paymentProofImageUrl, activePaymentId } = state;

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

    const persistedPaymentProofImageUrl =
      pendingAction.paymentProofImageUrl || paymentProofImageUrl;
    const toolArgs =
      pendingAction.toolName === "upload_payment_proof" &&
      persistedPaymentProofImageUrl
        ? {
            ...pendingAction.toolArgs,
            imageUrl: persistedPaymentProofImageUrl,
          }
        : pendingAction.toolArgs;

    const result = await callSecureMcpTool(userId, pendingAction.toolName, toolArgs);

    const resultText = typeof result === "string" ? result : JSON.stringify(result);
    log.info({ toolName: pendingAction.toolName, result: resultText }, "Action executed successfully");

    let responseText = "Sip, berhasil yaa ✨";
    
    if (result && typeof result === 'object' && 'content' in result && Array.isArray(result.content) && result.content.length > 0) {
      const rawText = result.content[0].text;
      try {
        const parsed = JSON.parse(rawText);
        
        if (pendingAction.toolName === "update_profile" && parsed.profile) {
          responseText = `Sip, profil kamu udah ke-update ✨\nNama: ${parsed.profile.name}\nHP: ${parsed.profile.phone || "-"}`;
        } else if (pendingAction.toolName === "create_booking") {
          const firstPayment = parsed.payments?.[0];
          const paymentInfo = firstPayment 
            ? `\n💰 Tagihan pertama: <b>Rp ${firstPayment.amount.toLocaleString("id-ID")}</b> (cek di menu pembayaran ya!)`
            : "";
          responseText = `<b>Hore! Booking berhasil dibuat ✨</b>\n\nKamar <b>${parsed.room?.name}</b> di <b>${parsed.room?.kosan?.name}</b> sudah dipesan untuk kamu.${paymentInfo}\n\nAda lagi yang bisa aku bantu?`;
        } else if (parsed.message) {
          responseText = parsed.message;
        } else {
          responseText = "Sip, berhasil yaa ✨";
        }
      } catch {
        responseText = rawText || "Sip, berhasil yaa ✨";
      }
    } else {
      responseText = "Oke, aksinya udah berhasil dijalanin ✨";
    }

    return {
      messages: [new AIMessage(responseText)],
      pendingAction: null,
      activePaymentId:
        pendingAction.toolName === "upload_payment_proof" ? "" : activePaymentId,
    };
  } catch (error) {
    log.error({ error, pendingAction }, "Failed to execute action");
    return {
      messages: [new AIMessage("Aduh, tadi ada error pas jalanin aksinya 😅 Coba ulang lagi ya.")],
      pendingAction: null,
    };
  }
};
