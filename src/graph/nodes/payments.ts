import { HumanMessage } from "@langchain/core/messages";
import { GraphStateType, PendingPaymentSnapshot, VisionResult } from "../state.js";
import { llm } from "../../llm/index.js";
import { buildRuntimeContext, paymentsPrompt } from "../../prompts/index.js";
import { getToolsForAI } from "../tools.js";
import { createLogger } from "../../lib/logger.js";
import { toTextOnlyMessage, toTextOnlyMessages } from "../../lib/formatter.js";
import { getTimeContext } from "../../lib/time.js";

const log = createLogger("node-payments");

const PAYMENT_ID_REGEX = /\bPYM-[A-Z0-9]+\b/i;

type PaymentContext = {
  latestMessageIsHuman: boolean;
  latestHumanText: string;
  explicitPaymentId: string;
  resolvedPaymentId: string;
  hasImageInput: boolean;
  hasProofImage: boolean;
  visionKind: VisionResult["kind"];
};

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

const getSinglePendingPaymentId = (
  payments: PendingPaymentSnapshot[],
): string => {
  if (payments.length !== 1) return "";
  return payments[0]?.paymentId || "";
};

const resolvePaymentId = (
  explicitPaymentId: string,
  activePaymentId: string,
  pendingPaymentsSnapshot: PendingPaymentSnapshot[],
): string =>
  explicitPaymentId ||
  activePaymentId ||
  getSinglePendingPaymentId(pendingPaymentsSnapshot);

const formatPendingPaymentsContext = (
  payments: PendingPaymentSnapshot[],
): string => {
  if (payments.length === 0) {
    return "- pendingPayments: tidak ada snapshot tagihan pending di state";
  }

  const paymentLines = payments.map((payment, index) => {
    const period =
      payment.periodStart && payment.periodEnd
        ? `, periode=${payment.periodStart} s/d ${payment.periodEnd}`
        : "";
    const amount =
      typeof payment.amount === "number"
        ? `, total=Rp ${payment.amount.toLocaleString("id-ID")}`
        : "";
    const status = payment.status ? `, status=${payment.status}` : "";
    return `  ${index + 1}. ${payment.paymentId}${period}${amount}${status}`;
  });

  return ["- pendingPayments:", ...paymentLines].join("\n");
};

const buildPaymentContext = (state: GraphStateType): PaymentContext => {
  const latestMessageIsHuman = isLatestMessageHuman(state.messages);
  const latestHumanText = getLatestHumanText(state.messages);
  const explicitPaymentId = extractLatestHumanPaymentId(state.messages);
  const visionKind = state.visionResult?.kind ?? "unknown";
  const hasImageInput = Boolean(state.paymentProofImageUrl);

  return {
    latestMessageIsHuman,
    latestHumanText,
    explicitPaymentId,
    resolvedPaymentId: resolvePaymentId(
      explicitPaymentId,
      state.activePaymentId,
      state.pendingPaymentsSnapshot,
    ),
    hasImageInput,
    hasProofImage: hasImageInput && visionKind === "payment_proof",
    visionKind,
  };
};

const buildPaymentStateContext = (
  state: GraphStateType,
  context: PaymentContext,
): string => {
  const lines = [
    "PAYMENT_STATE:",
    `- paymentStage: ${state.paymentStage}`,
    `- activePaymentId: ${state.activePaymentId || "-"}`,
    `- explicitPaymentIdFromUser: ${context.explicitPaymentId || "-"}`,
    `- resolvedPaymentId: ${context.resolvedPaymentId || "-"}`,
    `- hasImageInput: ${context.hasImageInput ? "true" : "false"}`,
    `- hasProofImage: ${context.hasProofImage ? "true" : "false"}`,
    `- visionKind: ${context.visionKind}`,
    `- latestMessageIsHuman: ${context.latestMessageIsHuman ? "true" : "false"}`,
    `- latestUserText: ${context.latestHumanText || "-"}`,
    formatPendingPaymentsContext(state.pendingPaymentsSnapshot),
  ];

  return lines.join("\n");
};

export const paymentsNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const { messages, summary, visionAnalysis } = state;

  const textMessages = toTextOnlyMessages(messages);
  const paymentContext = buildPaymentContext(state);
  const tools = await getToolsForAI("payments");
  const time = getTimeContext();
  const runtimeContext = buildRuntimeContext([
    [
      "WAKTU",
      `${time.currentDate} ${time.currentTime} (${time.currentTimezone})`,
    ],
    ["SUMMARY", summary ? `Konteks sebelumnya:\n${summary}` : ""],
    ["PAYMENT_STATE", buildPaymentStateContext(state, paymentContext)],
    [
      "VISION_AGENT_RESULT",
      visionAnalysis ? `Hasil analisis gambar untuk turn ini:\n${visionAnalysis}` : "",
    ],
    [
      "IMAGE_INPUT_SIGNAL",
      paymentContext.hasImageInput
        ? "User mengirim gambar pada turn ini. Ikuti visionKind sebelum menentukan apakah ini bukti bayar."
        : "",
    ],
    [
      "PROOF_IMAGE_SIGNAL",
      paymentContext.hasProofImage
        ? "Sistem mendeteksi user baru saja mengirim foto bukti bayar pada turn ini."
        : "",
    ],
    [
      "TARGET_TAGIHAN",
      paymentContext.resolvedPaymentId
        ? `Tagihan target yang sedang aktif: ${paymentContext.resolvedPaymentId}. Jika user ingin melanjutkan pembayaran, gunakan ID ini.`
        : "",
    ],
  ]);

  const chain = paymentsPrompt.pipe(llm.bindTools(tools));
  const response = await chain.invoke({
    messages: textMessages,
    runtimeContext,
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
    activePaymentId: paymentContext.resolvedPaymentId || state.activePaymentId,
    paymentStage: state.paymentStage,
  };
};
