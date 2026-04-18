import { randomUUID } from "node:crypto";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  GraphStateType,
  PaymentStage,
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
const EXIT_PAYMENT_FLOW_REGEX =
  /\b(batal|gak jadi|nggak jadi|ga jadi|nanti dulu|skip|stop|keluar)\b/i;
const EXIT_PAYMENT_FLOW_HINT =
  'Kalau mau keluar dari alur pembayaran, ketik "batal".';

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

const isKnownPendingPaymentId = (
  payments: PendingPaymentSnapshot[],
  paymentId: string,
): boolean => payments.some((payment) => payment.paymentId === paymentId);

const normalizePaymentSelectionText = (text: string): string =>
  text.replace(/[`"'<>.,!?()\s]/g, "").toUpperCase();

const isPaymentIdOnlyText = (text: string, paymentId: string): boolean =>
  normalizePaymentSelectionText(text) === paymentId.toUpperCase();

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
  const visionKind = state.visionResult?.kind ?? "unknown";
  const hasImageInput = Boolean(state.paymentProofImageUrl);
  const expectsPaymentProof =
    state.paymentStage !== "idle" || Boolean(state.activePaymentId);

  return {
    latestMessageIsHuman,
    latestHumanText,
    explicitPaymentId,
    resolvedPaymentId: resolvePaymentId(
      explicitPaymentId,
      state.activePaymentId,
      state.pendingPaymentsSnapshot,
    ),
    hasProofImage: hasImageInput && (visionKind === "payment_proof" || expectsPaymentProof),
    visionKind,
  };
};

const buildChoosePaymentReply = (
  payments: PendingPaymentSnapshot[],
  intro = "Pilih dulu tagihan mana yang mau diproses ya:",
): AIMessage =>
  reply(
    `${intro}\n${formatPaymentChoices(payments)}\n\nBalas dengan ID tagihan, misalnya <code>${payments[0]?.paymentId}</code>. ${EXIT_PAYMENT_FLOW_HINT}`,
  );

const buildAskForProofReply = (paymentId: string): AIMessage =>
  reply(
    `Siap. Tagihan <code>${paymentId}</code> sudah aku tandai. Sekarang kirim foto bukti bayar dulu, nanti aku minta konfirmasi sebelum mengunggahnya. ${EXIT_PAYMENT_FLOW_HINT}`,
  );

const buildUnknownPaymentReply = (
  paymentId: string,
  payments: PendingPaymentSnapshot[],
): AIMessage => {
  if (payments.length === 0) {
    return reply(
      `Aku belum punya daftar tagihan pending untuk memastikan <code>${paymentId}</code>. Aku cek dulu tagihan aktifnya ya. ${EXIT_PAYMENT_FLOW_HINT}`,
    );
  }

  return reply(
    `Aku belum nemu tagihan <code>${paymentId}</code> di daftar pending saat ini.\n${formatPaymentChoices(payments)}\n\nBalas dengan salah satu ID di atas ya. ${EXIT_PAYMENT_FLOW_HINT}`,
  );
};

const getAwaitingProofReply = (paymentId: string): AIMessage =>
  reply(
    `Tagihan <code>${paymentId}</code> sudah dipilih. Sekarang kirim foto bukti bayarnya ya, nanti aku bantu lanjut sampai konfirmasi upload. ${EXIT_PAYMENT_FLOW_HINT}`,
  );

const getStageAfterSelection = (paymentId: string): PaymentStage =>
  paymentId ? "awaiting_proof" : "choosing_payment";

const handleExitPaymentFlow = (
  state: GraphStateType,
  context: PaymentContext,
): Partial<GraphStateType> | null => {
  if (state.paymentStage === "idle") {
    return null;
  }

  if (!context.latestMessageIsHuman || context.hasProofImage) {
    return null;
  }

  if (!EXIT_PAYMENT_FLOW_REGEX.test(context.latestHumanText)) {
    return null;
  }

  return {
    messages: [
      reply(
        'Oke, alur pembayaran aku hentikan dulu. Kalau mau lanjut lagi nanti bilang saja.',
      ),
    ],
    activePaymentId: "",
    pendingPaymentsSnapshot: [],
    paymentStage: "idle",
  };
};

const handleExplicitPaymentSelection = (
  state: GraphStateType,
  context: PaymentContext,
): Partial<GraphStateType> | null => {
  const { pendingPaymentsSnapshot } = state;
  const { latestMessageIsHuman, latestHumanText, explicitPaymentId, hasProofImage } =
    context;

  if (!latestMessageIsHuman || hasProofImage || !explicitPaymentId) {
    return null;
  }

  if (!isPaymentIdOnlyText(latestHumanText, explicitPaymentId)) {
    return null;
  }

  if (
    pendingPaymentsSnapshot.length > 0 &&
    !isKnownPendingPaymentId(pendingPaymentsSnapshot, explicitPaymentId)
  ) {
    return {
      messages: [buildUnknownPaymentReply(explicitPaymentId, pendingPaymentsSnapshot)],
      paymentStage: pendingPaymentsSnapshot.length > 0 ? "choosing_payment" : "idle",
    };
  }

  return {
    messages: [buildAskForProofReply(explicitPaymentId)],
    activePaymentId: explicitPaymentId,
    paymentStage: getStageAfterSelection(explicitPaymentId),
  };
};

const handleChoosingPaymentStage = (
  state: GraphStateType,
  context: PaymentContext,
): Partial<GraphStateType> | null => {
  if (state.paymentStage !== "choosing_payment" || !context.latestMessageIsHuman) {
    return null;
  }

  if (!context.explicitPaymentId) {
    if (state.pendingPaymentsSnapshot.length === 0) {
      return {
        messages: [buildToolCallMessage("get_pending_payments", {})],
        paymentStage: "choosing_payment",
      };
    }

    return {
      messages: [
        buildChoosePaymentReply(
          state.pendingPaymentsSnapshot,
          "Aku masih butuh ID tagihan dulu biar bisa lanjut:",
        ),
      ],
      paymentStage: "choosing_payment",
    };
  }

  if (
    state.pendingPaymentsSnapshot.length > 0 &&
    !isKnownPendingPaymentId(state.pendingPaymentsSnapshot, context.explicitPaymentId)
  ) {
    return {
      messages: [
        buildUnknownPaymentReply(
          context.explicitPaymentId,
          state.pendingPaymentsSnapshot,
        ),
      ],
      paymentStage: "choosing_payment",
    };
  }

  return {
    messages: [buildAskForProofReply(context.explicitPaymentId)],
    activePaymentId: context.explicitPaymentId,
    paymentStage: "awaiting_proof",
  };
};

const handleAwaitingProofStage = (
  state: GraphStateType,
  context: PaymentContext,
): Partial<GraphStateType> | null => {
  if (
    state.paymentStage !== "awaiting_proof" ||
    !context.latestMessageIsHuman ||
    context.hasProofImage
  ) {
    return null;
  }

  if (context.explicitPaymentId) {
    if (
      state.pendingPaymentsSnapshot.length > 0 &&
      !isKnownPendingPaymentId(state.pendingPaymentsSnapshot, context.explicitPaymentId)
    ) {
      return {
        messages: [
          buildUnknownPaymentReply(
            context.explicitPaymentId,
            state.pendingPaymentsSnapshot,
          ),
        ],
        paymentStage: state.pendingPaymentsSnapshot.length > 0 ? "choosing_payment" : "idle",
      };
    }

    return {
      messages: [buildAskForProofReply(context.explicitPaymentId)],
      activePaymentId: context.explicitPaymentId,
      paymentStage: "awaiting_proof",
    };
  }

  if (context.resolvedPaymentId) {
    return {
      messages: [getAwaitingProofReply(context.resolvedPaymentId)],
      activePaymentId: context.resolvedPaymentId,
      paymentStage: "awaiting_proof",
    };
  }

  if (state.pendingPaymentsSnapshot.length > 1) {
    return {
      messages: [
        buildChoosePaymentReply(
          state.pendingPaymentsSnapshot,
          "Sebelum kirim bukti bayar, pilih dulu tagihan targetnya ya:",
        ),
      ],
      paymentStage: "choosing_payment",
    };
  }

  return {
    messages: [buildToolCallMessage("get_pending_payments", {})],
    activePaymentId: state.activePaymentId,
    paymentStage: "choosing_payment",
  };
};

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
          `Aku sudah menerima gambarnya, tapi itu belum terlihat seperti bukti pembayaran. Kalau ini memang untuk tagihan, kirim foto struk/transfer yang lebih jelas ya. ${EXIT_PAYMENT_FLOW_HINT}`,
        ),
      ],
      activePaymentId: explicitPaymentId || activePaymentId,
      paymentStage:
        explicitPaymentId || activePaymentId ? "awaiting_proof" : state.paymentStage,
    };
  }

  if (!resolvedPaymentId) {
    if (pendingPaymentsSnapshot.length > 1) {
      return {
        messages: [
          buildChoosePaymentReply(
            pendingPaymentsSnapshot,
            "Bukti bayarnya sudah masuk. Sebelum aku unggah, pilih dulu tagihan mana yang mau dibayarkan ya:",
          ),
        ],
        paymentStage: "choosing_payment",
      };
    }

    if (!latestMessageIsHuman && pendingPaymentsSnapshot.length === 0) {
      return {
        messages: [
          reply(
            "Aku sudah cek, tapi saat ini tidak ada tagihan pending yang bisa dipasangkan dengan bukti bayar itu.",
          ),
        ],
        paymentStage: "idle",
      };
    }

    log.info(
      "Payment proof image received without target payment; fetching pending payments first",
    );
    return {
      messages: [buildToolCallMessage("get_pending_payments", {})],
      activePaymentId,
      paymentStage: "choosing_payment",
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
      paymentStage: "awaiting_proof",
    };
  }

  return {
    messages: [
      reply(
        `Aku sudah menerima gambarnya untuk tagihan <code>${resolvedPaymentId}</code>, tapi masih belum yakin itu bukti pembayaran. Kalau memang benar struk/transfer, kirim gambar yang lebih jelas ya. ${EXIT_PAYMENT_FLOW_HINT}`,
      ),
    ],
    activePaymentId: resolvedPaymentId,
    paymentStage: "awaiting_proof",
  };
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

  const exitPaymentFlowResult = handleExitPaymentFlow(state, paymentContext);
  if (exitPaymentFlowResult) {
    return exitPaymentFlowResult;
  }

  const explicitSelectionResult = handleExplicitPaymentSelection(state, paymentContext);
  if (explicitSelectionResult) {
    return explicitSelectionResult;
  }

  const choosingPaymentResult = handleChoosingPaymentStage(state, paymentContext);
  if (choosingPaymentResult) {
    return choosingPaymentResult;
  }

  const awaitingProofResult = handleAwaitingProofStage(state, paymentContext);
  if (awaitingProofResult) {
    return awaitingProofResult;
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
    proofContext: paymentContext.hasProofImage
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
    paymentStage: state.paymentStage,
  };
};
