import { BaseMessage, getBufferString } from "@langchain/core/messages";
import { GraphStateType, VisionResult } from "../state.js";
import { llm } from "../../llm/index.js";
import { supervisorPrompt, AGENTS } from "../../prompts/index.js";
import { createLogger } from "../../lib/logger.js";
import { toTextOnlyMessages } from "../../lib/formatter.js";

const log = createLogger("supervisor");

type SupervisorRoute = (typeof AGENTS)[number];

type SupervisorDecision = {
  route: SupervisorRoute;
  reason?: string;
  needsClarification?: boolean;
};

const PAYMENT_ID_REGEX = /\bPYM-[A-Z0-9]+\b/i;
const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ROUTE_REGEX = new RegExp(
  `\\b(${AGENTS.map(escapeRegex).join("|")})\\b`,
  "i",
);

const extractJsonObject = (content: string): string | null => {
  const match = content.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
};

const normalizeRoute = (value: string | undefined): SupervisorRoute | null => {
  if (!value) return null;
  const route = value.trim().toLowerCase();
  return AGENTS.includes(route as SupervisorRoute)
    ? (route as SupervisorRoute)
    : null;
};

const parseSupervisorDecision = (content: string): SupervisorDecision | null => {
  const jsonText = extractJsonObject(content);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as {
        route?: string;
        reason?: string;
        needsClarification?: boolean;
      };
      const route = normalizeRoute(parsed.route);
      if (route) {
        return {
          route,
          reason: parsed.reason,
          needsClarification: parsed.needsClarification,
        };
      }
    } catch (error) {
      log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to parse supervisor JSON response",
      );
    }
  }

  const routeMatch = content.match(ROUTE_REGEX);

  if (!routeMatch) return null;

  return {
    route: routeMatch[1] as SupervisorRoute,
    reason: "Recovered from non-JSON supervisor output.",
    needsClarification: false,
  };
};

const getMessageText = (message: BaseMessage): string => {
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

const getLatestHumanText = (messages: BaseMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.getType?.() === "human") {
      return getMessageText(messages[i]).trim();
    }
  }

  return "";
};

const fallbackSupervisorDecision = (
  visionResult: VisionResult | null,
): SupervisorDecision => {
  const visionLooksLikePayment = visionResult?.kind === "payment_proof";

  if (visionLooksLikePayment) {
    return {
      route: "payments",
      reason: "Vision context indicates payment proof.",
      needsClarification: false,
    };
  }

  return {
    route: "general",
    reason: "Supervisor output invalid; defaulting to general.",
    needsClarification: true,
  };
};

export const supervisorNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const {
    messages,
    summary,
    pendingAction,
    visionAnalysis,
    visionResult,
    paymentProofImageUrl,
    paymentStage,
  } = state;
  const textMessages = toTextOnlyMessages(messages);
  const latestHumanText = getLatestHumanText(textMessages);

  // JALUR PAKSA: Hanya jika benar-benar ada yang harus dikonfirmasi
  if (pendingAction) {
    log.info({ pendingAction: pendingAction.toolName }, "Strict routing to confirmation resolver");
    return { next: "resolve_confirmation" };
  }

  if (paymentStage !== "idle") {
    log.info({ paymentStage }, "Routing to payments because payment flow is still active");
    return { next: "payments" };
  }

  if (PAYMENT_ID_REGEX.test(latestHumanText)) {
    log.info({ latestHumanText }, "Routing to payments because latest user message contains a payment ID");
    return { next: "payments" };
  }

  const chain = supervisorPrompt.pipe(llm);
  const conversation = getBufferString(textMessages);
  const result = await chain.invoke({
    agents: AGENTS.join(", "),
    summary: summary ? `Konteks sebelumnya:\n${summary}` : "",
    visionContext: visionAnalysis ? `Hasil analisis gambar:\n${visionAnalysis}` : "",
    proofContext: visionResult?.kind === "payment_proof"
      ? "Sistem mendeteksi ada foto bukti bayar pada turn ini."
      : "",
    conversation,
  });

  const rawResponse = String(result.content).trim();
  const parsedDecision = parseSupervisorDecision(rawResponse);
  const decision =
    parsedDecision ?? fallbackSupervisorDecision(visionResult);

  log.info(
    {
      selectedAgent: decision.route,
      reason: decision.reason,
      needsClarification: decision.needsClarification ?? false,
      usedFallback: !parsedDecision,
    },
    "Supervisor routed",
  );

  return { next: decision.route };
};
