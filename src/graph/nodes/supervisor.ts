import { BaseMessage, getBufferString } from "@langchain/core/messages";
import { GraphStateType, PendingClarification, VisionResult } from "../state.js";
import { supervisorLLM } from "../../llm/index.js";
import { buildRuntimeContext, supervisorPrompt, AGENTS } from "../../prompts/index.js";
import { createLogger } from "../../lib/logger.js";
import { toTextOnlyMessages } from "../../lib/formatter.js";

const log = createLogger("supervisor");

type SupervisorRoute = (typeof AGENTS)[number];

type SupervisorDecision = {
  route: SupervisorRoute;
  reason?: string;
  needsClarification?: boolean;
  candidateRoutes?: SupervisorRoute[];
  clarificationQuestion?: string;
};

const PAYMENT_ID_REGEX = /\bPYM-[A-Z0-9]+\b/i;
const ROUTE_LABELS: Record<SupervisorRoute, string> = {
  general: "hal umum atau isi gambar",
  profile: "profil atau data akunmu",
  rooms: "kamar atau kosan",
  payments: "pembayaran atau tagihan",
};

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

const normalizeCandidateRoutes = (value: unknown): SupervisorRoute[] => {
  if (!Array.isArray(value)) return [];

  const normalized: SupervisorRoute[] = [];
  for (const item of value) {
    const route = normalizeRoute(typeof item === "string" ? item : undefined);
    if (route && !normalized.includes(route)) {
      normalized.push(route);
    }
  }

  return normalized;
};

const dedupeRoutes = (...routes: SupervisorRoute[]): SupervisorRoute[] =>
  routes.filter((candidate, index, list) => list.indexOf(candidate) === index);

const containsAny = (text: string, terms: string[]): boolean =>
  terms.some((term) => text.includes(term));

const getFallbackCandidateRoutes = (
  route: SupervisorRoute,
  latestHumanText: string,
  visionResult: VisionResult | null,
): SupervisorRoute[] => {
  const lower = latestHumanText.toLowerCase();

  if (containsAny(lower, ["bayar", "tagihan", "transfer", "bukti", "lunas"])) {
    return dedupeRoutes(route, "payments", "general");
  }

  if (containsAny(lower, ["nama", "profil", "akun", "nomor", "hp"])) {
    return dedupeRoutes(route, "profile", "general");
  }

  if (containsAny(lower, ["kamar", "kos", "kosan", "sewa", "room"])) {
    return dedupeRoutes(route, "rooms", "general");
  }

  if (visionResult?.kind === "payment_proof") {
    return dedupeRoutes(route, "payments", "general");
  }

  if (visionResult?.kind === "non_payment") {
    return dedupeRoutes(route, "general", "rooms");
  }

  return dedupeRoutes(route, "general", "rooms");
};

const buildClarificationQuestion = (
  candidateRoutes: SupervisorRoute[],
  visionResult: VisionResult | null,
): string => {
  const hasGeneral = candidateRoutes.includes("general");
  const hasRooms = candidateRoutes.includes("rooms");
  const hasPayments = candidateRoutes.includes("payments");
  const hasProfile = candidateRoutes.includes("profile");

  if (hasGeneral && hasRooms && visionResult?.kind === "non_payment") {
    return "Maksudmu mau aku jelasin isi gambar yang barusan, atau mau lanjut bahas kamar/kosan?";
  }

  if (hasGeneral && hasRooms) {
    return "Maksudmu mau bahas hal umum dulu, atau mau cari atau lihat kamar/kosan?";
  }

  if (hasGeneral && hasPayments) {
    return "Maksudmu mau bahas isi gambar atau hal umum, atau sebenarnya soal pembayaran atau tagihan?";
  }

  if (hasGeneral && hasProfile) {
    return "Maksudmu mau tanya hal umum, atau mau cek atau ubah profilmu?";
  }

  if (hasRooms && hasPayments) {
    return "Maksudmu mau lanjut bahas kamar atau kosan, atau soal pembayaran atau tagihan?";
  }

  if (hasProfile && hasPayments) {
    return "Maksudmu mau urusan profil akunmu, atau soal pembayaran atau tagihan?";
  }

  if (candidateRoutes.length >= 2) {
    const [first, second] = candidateRoutes;
    return `Maksudmu mau bahas ${ROUTE_LABELS[first]}, atau ${ROUTE_LABELS[second]}?`;
  }

  return "Bisa jelasin maksudmu sedikit lagi?";
};

const buildPendingClarification = (
  decision: SupervisorDecision,
  latestHumanText: string,
  visionAnalysis: string,
  visionResult: VisionResult | null,
): PendingClarification => {
  const candidateRoutes =
    decision.candidateRoutes && decision.candidateRoutes.length > 0
      ? decision.candidateRoutes
      : getFallbackCandidateRoutes(decision.route, latestHumanText, visionResult);

  const normalizedCandidateRoutes = candidateRoutes.includes(decision.route)
    ? candidateRoutes
    : [decision.route, ...candidateRoutes];

  const question =
    decision.clarificationQuestion?.trim() ||
    buildClarificationQuestion(normalizedCandidateRoutes, visionResult);

  return {
    question,
    reason: decision.reason?.trim() || "Intent user masih ambigu.",
    candidateRoutes: normalizedCandidateRoutes.slice(0, 3),
    suggestedRoute: decision.route,
    originalUserText: latestHumanText,
    visionAnalysis: visionAnalysis || undefined,
    attempts: 1,
  };
};

const parseSupervisorDecision = (content: string): SupervisorDecision | null => {
  const jsonText = extractJsonObject(content);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as {
        route?: string;
        reason?: string;
        needsClarification?: boolean;
        candidateRoutes?: string[];
        clarificationQuestion?: string;
      };
      const route = normalizeRoute(parsed.route);
      if (route) {
        return {
          route,
          reason: parsed.reason,
          needsClarification: parsed.needsClarification,
          candidateRoutes: normalizeCandidateRoutes(parsed.candidateRoutes),
          clarificationQuestion:
            typeof parsed.clarificationQuestion === "string"
              ? parsed.clarificationQuestion
              : "",
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
    candidateRoutes: [],
    clarificationQuestion: "",
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
    pendingClarification,
    visionAnalysis,
    visionResult,
    activePaymentId,
    pendingPaymentsSnapshot,
  } = state;
  const textMessages = toTextOnlyMessages(messages);
  const latestHumanText = getLatestHumanText(textMessages);

  // JALUR PAKSA: Hanya jika benar-benar ada yang harus dikonfirmasi
  if (pendingAction) {
    log.info({ pendingAction: pendingAction.toolName }, "Strict routing to confirmation resolver");
    return { next: "resolve_confirmation" };
  }

  if (pendingClarification) {
    log.info(
      { candidateRoutes: pendingClarification.candidateRoutes, attempts: pendingClarification.attempts },
      "Routing to clarification resolver because a clarification is still pending",
    );
    return { next: "resolve_clarification" };
  }

  if (PAYMENT_ID_REGEX.test(latestHumanText)) {
    log.info({ latestHumanText }, "Routing to payments because latest user message contains a payment ID");
    return { next: "payments" };
  }

  const chain = supervisorPrompt.pipe(supervisorLLM);
  const conversation = getBufferString(textMessages);
  const result = await chain.invoke({
    runtimeContext: buildRuntimeContext([
      ["SUMMARY", summary ? `Konteks sebelumnya:\n${summary}` : ""],
      [
        "VISION_AGENT_RESULT",
        visionAnalysis ? `Hasil analisis gambar:\n${visionAnalysis}` : "",
      ],
      [
        "VISION_KIND",
        visionResult
          ? `${visionResult.kind} (confidence: ${visionResult.confidence})`
          : "",
      ],
      [
        "PROOF_IMAGE_SIGNAL",
        visionResult?.kind === "payment_proof"
          ? "Sistem mendeteksi ada foto bukti bayar pada turn ini."
          : "",
      ],
      [
        "PAYMENT_FLOW_STATE",
        activePaymentId || pendingPaymentsSnapshot.length > 0
          ? [
              `activePaymentId: ${activePaymentId || "-"}`,
              `pendingPaymentsCount: ${pendingPaymentsSnapshot.length}`,
            ].join("\n")
          : "",
      ],
    ]),
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
      candidateRoutes: decision.candidateRoutes ?? [],
      usedFallback: !parsedDecision,
    },
    "Supervisor routed",
  );

  if (decision.needsClarification) {
    return {
      next: "clarify",
      pendingClarification: buildPendingClarification(
        decision,
        latestHumanText,
        visionAnalysis,
        visionResult,
      ),
    };
  }

  return { next: decision.route, pendingClarification: null };
};
