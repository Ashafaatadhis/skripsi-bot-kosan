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
  "ya",
  "yes",
  "oke",
  "ok",
  "iya",
  "yup",
  "setuju",
  "lanjut",
  "konfirmasi",
  "boleh",
  "sip",
  "gas",
  "okey",
  "acc",
  "pastikan",
  "mantap",
  "bolehdeh",
];

const CANCEL_KEYWORDS = [
  "tidak",
  "no",
  "batal",
  "cancel",
  "jangan",
  "gak",
  "nggak",
  "enggak",
  "nanti",
  "skip",
  "stop",
  "hentikan",
  "belumpengen",
  "gakjadi",
  "nantiaja",
];

const isConfirmation = (text: string): boolean => {
  const lower = text.toLowerCase().trim();
  const words = lower.split(/\s+/);
  const confirmPhrases = [
    "boleh deh",
    "oke deh",
    "siap bos",
    "lanjut aja",
    "gas terus",
  ];

  return (
    CONFIRM_KEYWORDS.some((keyword) => words.includes(keyword)) ||
    confirmPhrases.some((phrase) => lower.includes(phrase))
  );
};

const isCancellation = (text: string): boolean => {
  const lower = text.toLowerCase().trim();
  const words = lower.split(/\s+/);
  const cancelPhrases = [
    "gak jadi",
    "nggak jadi",
    "nanti aja",
    "jangan dulu",
    "batalin aja",
    "ga jadi",
  ];

  return (
    CANCEL_KEYWORDS.some((keyword) => words.includes(keyword)) ||
    cancelPhrases.some((phrase) => lower.includes(phrase))
  );
};

const getActionDescription = (
  toolName: string,
  args: Record<string, unknown>,
): string => {
  switch (toolName) {
    case "update_profile": {
      const updates: string[] = [];
      if (args.name) {
        updates.push(`nama menjadi "<b>${escapeHtml(String(args.name))}</b>"`);
      }
      if (args.phone) {
        updates.push(`nomor HP menjadi "<b>${escapeHtml(String(args.phone))}</b>"`);
      }
      return `mengubah ${updates.join(" dan ")}`;
    }
    case "create_rental":
      return `memulai sewa kamar <code>${escapeHtml(String(args.roomId))}</code> mulai tanggal <b>${escapeHtml(String(args.startDate))}</b>`;
    case "cancel_rental":
      return `membatalkan sewa <code>${escapeHtml(String(args.rentalId))}</code>`;
    case "end_rental":
      return `mengakhiri sewa <code>${escapeHtml(String(args.rentalId))}</code>${
        args.checkoutDate
          ? ` pada tanggal <b>${escapeHtml(String(args.checkoutDate))}</b>`
          : ""
      }`;
    case "create_payment":
      return `membuat tagihan pembayaran untuk <b>${escapeHtml(String(args.monthsPaid))} bulan</b>${
        args.rentalId
          ? ` pada sewa <code>${escapeHtml(String(args.rentalId))}</code>`
          : ""
      }`;
    case "upload_payment_proof":
      return `mengunggah bukti pembayaran untuk tagihan <code>${escapeHtml(String(args.paymentId))}</code>`;
    default:
      return `menjalankan ${toolName}`;
  }
};

const getLastWriteToolCall = (state: GraphStateType) => {
  const lastMessage = state.messages[state.messages.length - 1];
  if (!(lastMessage instanceof AIMessage) || !lastMessage.tool_calls?.length) {
    return null;
  }
  return lastMessage.tool_calls.find((toolCall) => isWriteTool(toolCall.name)) ?? null;
};

const getHumanTextContent = (message: HumanMessage): string => {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .filter(
      (part): part is { type: string; text?: string } =>
        typeof part === "object" && part !== null,
    )
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
};

const extractToolResultText = (result: unknown): string => {
  if (typeof result === "string") {
    return result;
  }

  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content?: Array<{ type?: string; text?: string }> })
      .content;
    const textPayload = content?.find(
      (item) => item?.type === "text" && typeof item.text === "string",
    )?.text;

    if (textPayload) {
      return textPayload;
    }
  }

  return JSON.stringify(result);
};

export const prepareConfirmationNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const writeToolCall = getLastWriteToolCall(state);

  if (!writeToolCall) {
    log.warn("No write tool call found for confirmation");
    return {
      messages: [new AIMessage("Tidak ada aksi yang perlu dikonfirmasi.")],
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
        `Boleh aku bantu ${pendingAction.description}?\n\nKetik "ya" kalau oke, atau "nggak" kalau mau dibatalkan.`,
      ),
    ],
    pendingAction,
  };
};

export const resolveConfirmationNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const {
    pendingAction,
    messages,
    paymentStage,
  } = state;

  if (!pendingAction) {
    log.warn("No pending action to resolve");
    return {
      messages: [new AIMessage("Tidak ada aksi yang sedang menunggu konfirmasi.")],
      next: "end",
      pendingAction: null,
    };
  }

  const lastMessage = messages[messages.length - 1];
  const userText = lastMessage instanceof HumanMessage ? getHumanTextContent(lastMessage) : "";

  if (isCancellation(userText)) {
    log.info(
      { pendingAction: pendingAction.toolName, userText },
      "User cancelled action",
    );

    return {
      messages: [new AIMessage("Oke, aksi itu dibatalkan dulu.")],
      next: "end",
      pendingAction: null,
      paymentStage:
        pendingAction.toolName === "upload_payment_proof"
          ? "awaiting_proof"
          : pendingAction.toolName === "create_payment"
            ? "idle"
            : paymentStage,
    };
  }

  if (isConfirmation(userText)) {
    log.info(
      { pendingAction: pendingAction.toolName, userText },
      "User confirmed action",
    );
    return { next: "execute_pending" };
  }

  log.info(
    { pendingAction: pendingAction.toolName, userText },
    "User confirmation input not recognized",
  );

  return {
    messages: [
      new AIMessage(
        `Aku masih menunggu konfirmasi untuk ${pendingAction.description}.\n\nBalas "ya" untuk lanjut atau "nggak" untuk batal.`,
      ),
    ],
    next: "end",
    pendingAction,
  };
};

export const executePendingActionNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const {
    pendingAction,
    userId,
    paymentProofImageUrl,
    activePaymentId,
    paymentStage,
  } = state;

  if (!pendingAction) {
    log.warn("No pending action to execute");
    return {
      messages: [new AIMessage("Tidak ada aksi yang perlu dijalankan.")],
      pendingAction: null,
    };
  }

  log.info({ pendingAction }, "Executing confirmed action");

  try {
    const allTools = await getAllTools();
    const tool = allTools.find((item) => item.name === pendingAction.toolName);

    if (!tool) {
      log.error({ toolName: pendingAction.toolName }, "Tool not found");
      return {
        messages: [new AIMessage("Tool yang diminta tidak ditemukan.")],
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
    const resultText = extractToolResultText(result);

    log.info(
      { toolName: pendingAction.toolName, result: resultText },
      "Action executed successfully",
    );

    let responseText = "Aksi berhasil dijalankan.";
    let nextActivePaymentId = activePaymentId;
    let nextPaymentStage = paymentStage;

    try {
      const parsed = JSON.parse(resultText) as {
        message?: string;
        profile?: { name?: string; phone?: string };
        room?: { name?: string; kosan?: { name?: string } };
        startDate?: string;
        payment?: {
          humanId?: string;
          periodStart?: string;
          periodEnd?: string;
          amount?: number;
        };
      };

      if (pendingAction.toolName === "update_profile" && parsed.profile) {
        responseText = `Profil berhasil diperbarui.\nNama: ${parsed.profile.name}\nHP: ${parsed.profile.phone || "-"}`;
      } else if (pendingAction.toolName === "create_rental") {
        responseText = `<b>Sewa berhasil dibuat</b>\n\nKamar <b>${parsed.room?.name}</b> di <b>${parsed.room?.kosan?.name}</b> sudah aktif untuk kamu mulai <b>${parsed.startDate?.slice?.(0, 10) ?? "-"}</b>.\n\nKalau mau lanjut bayar, bilang saja mau bayar berapa bulan.`;
      } else if (pendingAction.toolName === "end_rental") {
        responseText =
          typeof parsed.message === "string"
            ? parsed.message
            : "Sewa berhasil diakhiri. Kamu bisa memilih kamar lain sekarang.";
      } else if (pendingAction.toolName === "create_payment") {
        const payment = parsed.payment;
        if (typeof payment?.humanId === "string") {
          nextActivePaymentId = payment.humanId;
          nextPaymentStage = "awaiting_proof";
        }
        responseText = `<b>Tagihan berhasil dibuat</b>\n\nID tagihan: <code>${payment?.humanId ?? "-"}</code>\nPeriode: <b>${payment?.periodStart?.slice?.(0, 10) ?? "-"} s/d ${payment?.periodEnd?.slice?.(0, 10) ?? "-"}</b>\nTotal: <b>Rp ${(payment?.amount ?? 0).toLocaleString("id-ID")}</b>\n\nSekarang kirim bukti bayarnya ya, nanti admin verifikasi.`;
      } else if (pendingAction.toolName === "upload_payment_proof") {
        nextActivePaymentId = "";
        nextPaymentStage = "idle";
        responseText =
          typeof parsed.message === "string"
            ? parsed.message
            : "Bukti bayar berhasil diunggah. Admin akan verifikasi ya.";
      } else if (parsed.message) {
        responseText = parsed.message;
      } else {
        responseText = resultText || responseText;
      }
    } catch {
      responseText = resultText || responseText;
      if (pendingAction.toolName === "upload_payment_proof") {
        nextActivePaymentId = "";
        nextPaymentStage = "idle";
      }
    }

    return {
      messages: [new AIMessage(responseText)],
      pendingAction: null,
      activePaymentId: nextActivePaymentId,
      paymentStage: nextPaymentStage,
    };
  } catch (error) {
    log.error({ error, pendingAction }, "Failed to execute action");
    return {
      messages: [new AIMessage("Ada error saat menjalankan aksi. Coba ulang lagi.")],
      pendingAction: null,
    };
  }
};
