import { randomUUID } from "node:crypto";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  GraphStateType,
  PendingPaymentSnapshot,
  VisionResult,
} from "../state.js";
import { llm } from "../../llm/index.js";
import { paymentsPrompt } from "../../prompts/index.js";
import { getToolsForAI } from "../tools.js";
import { createLogger } from "../../lib/logger.js";
import { toTextOnlyMessage, toTextOnlyMessages } from "../../lib/formatter.js";
import { getTimeContext } from "../../lib/time.js";

const log = createLogger("node-payments");

const PAYMENT_ID_REGEX = /\bPYM-[A-Z0-9]+\b/i;
const PAY_INTENT_REGEX =
  /\b(bayar|bayarin|lunas|upload|unggah|kirim|kirimkan|konfirmasi)\b/i;
const PENDING_REQUEST_REGEX =
  /\b(pending|tagihan|riwayat pembayaran|riwayat tagihan|cek pembayaran|pembayaran saya)\b/i;

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

const extractLatestHumanPaymentId = (
  messages: GraphStateType["messages"],
): string => {
  const latestText = getLatestHumanText(messages);
  const match = latestText.match(PAYMENT_ID_REGEX);
  return match ? match[0].toUpperCase() : "";
};

const formatPaymentChoices = (payments: PendingPaymentSnapshot[]): string =>
  payments
    .map((payment) => {
      const period =
        payment.periodStart && payment.periodEnd
          ? ` (${payment.periodStart} s/d ${payment.periodEnd})`
          : "";
      return `- <code>${payment.paymentId}</code>${period}`;
    })
    .join("\n");

const getSinglePendingPaymentId = (
  payments: PendingPaymentSnapshot[],
): string => {
  if (payments.length !== 1) return "";
  return payments[0]?.paymentId || "";
};

const isPendingRequest = (text: string): boolean => PENDING_REQUEST_REGEX.test(text);

const isExplicitPayIntent = (text: string): boolean => PAY_INTENT_REGEX.test(text);

type PaymentContext = {
  latestMessageIsHuman: boolean;
  latestHumanText: string;
  explicitPaymentId: string;
  resolvedPaymentId: string;
  hasProofImage: boolean;
  visionKind: VisionResult["kind"];
};

const reply = (text: string): AIMessage => new AIMessage(text);

const resolvePaymentId = (
  explicitPaymentId: string,
  activePaymentId: string,
  pendingPaymentsSnapshot: PendingPaymentSnapshot[],
): string => {
  const singlePendingPaymentId = getSinglePendingPaymentId(pendingPaymentsSnapshot);
  return explicitPaymentId || activePaymentId || singlePendingPaymentId;
};

const buildPaymentContext = (state: GraphStateType): PaymentContext => {
  const latestMessageIsHuman = isLatestMessageHuman(state.messages);
  const latestHumanText = getLatestHumanText(state.messages);
  const explicitPaymentId = extractLatestHumanPaymentId(state.messages);

  return {
    latestMessageIsHuman,
    latestHumanText,
    explicitPaymentId,
    resolvedPaymentId: resolvePaymentId(
      explicitPaymentId,
      state.activePaymentId,
      state.pendingPaymentsSnapshot,
    ),
    hasProofImage: Boolean(state.paymentProofImageUrl),
    visionKind: state.visionResult?.kind ?? "unknown",
  };
};

const buildChoosePaymentReply = (payments: PendingPaymentSnapshot[]): AIMessage =>
  reply(
    `Bukti bayarnya sudah masuk. Sebelum aku unggah, pilih dulu tagihan mana yang mau dibayarkan ya:\n${formatPaymentChoices(payments)}\n\nBalas dengan ID tagihan, misalnya <code>${payments[0]?.paymentId}</code>.`,
  );

const buildAskForProofReply = (paymentId: string): AIMessage =>
  reply(
    `Siap. Tagihan <code>${paymentId}</code> sudah aku tandai. Sekarang kirim foto bukti bayar dulu, nanti aku minta konfirmasi sebelum mengunggahnya.`,
  );

const handleProofImage = (
  state: GraphStateType,
  context: PaymentContext,
): Partial<GraphStateType> | null => {
  const { pendingPaymentsSnapshot, activePaymentId } = state;
  const { visionKind, explicitPaymentId, resolvedPaymentId, latestMessageIsHuman } =
    context;

  if (!context.hasProofImage) {
    return null;
  }

  if (visionKind === "non_payment") {
    return {
      messages: [
        reply(
          "Aku sudah menerima gambarnya, tapi itu belum terlihat seperti bukti pembayaran. Kalau ini memang untuk tagihan, kirim foto struk/transfer yang lebih jelas ya.",
        ),
      ],
      activePaymentId: explicitPaymentId || activePaymentId,
    };
  }

  if (!resolvedPaymentId) {
    if (pendingPaymentsSnapshot.length > 1) {
      return {
        messages: [buildChoosePaymentReply(pendingPaymentsSnapshot)],
      };
    }

    if (!latestMessageIsHuman && pendingPaymentsSnapshot.length === 0) {
      return {
        messages: [
          reply(
            "Aku sudah cek, tapi saat ini tidak ada tagihan pending yang bisa dipasangkan dengan bukti bayar itu.",
          ),
        ],
      };
    }

    log.info(
      "Payment proof image received without target payment; fetching pending payments first",
    );
    return {
      messages: [buildToolCallMessage("get_pending_payments", {})],
      activePaymentId,
    };
  }

  if (visionKind === "payment_proof") {
    log.info(
      { paymentId: resolvedPaymentId },
      "Payment proof detected with resolved target; preparing confirmation flow",
    );
    return {
      messages: [
        buildToolCallMessage("upload_payment_proof", {
          paymentId: resolvedPaymentId,
        }),
      ],
      activePaymentId: resolvedPaymentId,
    };
  }

  return {
    messages: [
      reply(
        `Aku sudah menerima gambarnya untuk tagihan <code>${resolvedPaymentId}</code>, tapi masih belum yakin itu bukti pembayaran. Kalau memang benar struk/transfer, kirim gambar yang lebih jelas ya.`,
      ),
    ],
    activePaymentId: resolvedPaymentId,
  };
};

const handleHumanPaymentIntent = (
  state: GraphStateType,
  context: PaymentContext,
): Partial<GraphStateType> | null => {
  const { activePaymentId } = state;
  const {
    latestMessageIsHuman,
    latestHumanText,
    explicitPaymentId,
    resolvedPaymentId,
  } = context;

  if (!latestMessageIsHuman) {
    return null;
  }

  if (explicitPaymentId && isExplicitPayIntent(latestHumanText)) {
    return {
      messages: [buildAskForProofReply(explicitPaymentId)],
      activePaymentId: explicitPaymentId,
    };
  }

  if (!explicitPaymentId && activePaymentId && isExplicitPayIntent(latestHumanText)) {
    return {
      messages: [
        reply(
          `Siap. Kita lanjut untuk tagihan <code>${activePaymentId}</code>. Kirim foto bukti bayarnya dulu, nanti aku minta konfirmasi sebelum upload.`,
        ),
      ],
      activePaymentId,
    };
  }

  if (isExplicitPayIntent(latestHumanText) && !resolvedPaymentId) {
    return {
      messages: [buildToolCallMessage("get_pending_payments", {})],
      activePaymentId,
    };
  }

  if (!latestHumanText && resolvedPaymentId) {
    return {
      messages: [
        reply(
          `Untuk tagihan <code>${resolvedPaymentId}</code>, kirim foto bukti bayarnya dulu ya. Setelah itu aku akan minta konfirmasi sebelum mengunggah.`,
        ),
      ],
      activePaymentId: resolvedPaymentId,
    };
  }

  if (isPendingRequest(latestHumanText)) {
    return {
      messages: [buildToolCallMessage("get_pending_payments", {})],
      activePaymentId,
    };
  }

  return null;
};

export const paymentsNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const { messages, summary, visionAnalysis } = state;

  const textMessages = toTextOnlyMessages(messages);
  const paymentContext = buildPaymentContext(state);

  const proofImageResult = handleProofImage(state, paymentContext);
  if (proofImageResult) {
    return proofImageResult;
  }

  const humanIntentResult = handleHumanPaymentIntent(state, paymentContext);
  if (humanIntentResult) {
    return humanIntentResult;
  }

  const tools = await getToolsForAI("payments");
  const { currentDate, currentTime, currentTimezone } = getTimeContext();
  const chain = paymentsPrompt.pipe(llm.bindTools(tools));
  const response = await chain.invoke({
    messages: textMessages,
    summary: summary ? `Konteks sebelumnya:\n${summary}` : "",
    visionContext: visionAnalysis
      ? `Hasil analisis gambar untuk turn ini:\n${visionAnalysis}`
      : "",
    proofContext: state.paymentProofImageUrl
      ? "Sistem mendeteksi user baru saja mengirim foto bukti bayar pada turn ini."
      : "",
    targetPaymentContext: paymentContext.resolvedPaymentId
      ? `Tagihan target yang sedang aktif: ${paymentContext.resolvedPaymentId}. Jika user ingin melanjutkan pembayaran, gunakan ID ini.`
      : "",
    currentDate,
    currentTime,
    currentTimezone,
  });

  log.info(
    {
      hasToolCalls: !!response.tool_calls?.length,
      toolNames: response.tool_calls?.map((tc) => tc.name),
    },
    "Payments agent responded",
  );

  return {
    messages: [response],
    activePaymentId: paymentContext.resolvedPaymentId,
  };
};
