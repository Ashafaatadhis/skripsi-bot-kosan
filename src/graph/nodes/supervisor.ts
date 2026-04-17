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

const PAYMENT_KEYWORDS = [
  "tagihan",
  "bayar",
  "pembayaran",
  "bukti bayar",
  "transfer",
  "struk",
  "iuran",
  "payment",
];

const PROFILE_KEYWORDS = [
  "profil",
  "profile",
  "akun saya",
  "siapa saya",
  "nama saya",
  "nomor hp",
  "phone",
];

const ROOMS_KEYWORDS = [
  "kos",
  "kosan",
  "kamar",
  "pesan kamar",
  "status sewa",
  "sewa saya",
  "batalkan sewa",
  "sewa",
];

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

  const routeMatch = content
    .toLowerCase()
    .match(/\b(general|profile|rooms|payments)\b/);

  if (!routeMatch) return null;

  return {
    route: routeMatch[1] as SupervisorRoute,
    reason: "Recovered from non-JSON supervisor output.",
    needsClarification: false,
  };
};

const scoreKeywords = (text: string, keywords: string[]): number =>
  keywords.reduce(
    (score, keyword) => score + (text.includes(keyword) ? 1 : 0),
    0,
  );

const heuristicSupervisorRoute = (
  conversation: string,
  visionResult: VisionResult | null,
  visionAnalysis: string,
): SupervisorDecision => {
  const text = `${conversation}\n${visionAnalysis}`.toLowerCase();

  const visionLooksLikePayment = visionResult?.kind === "payment_proof";

  if (visionLooksLikePayment) {
    return {
      route: "payments",
      reason: "Vision context indicates payment proof.",
      needsClarification: false,
    };
  }

  const scores: Record<SupervisorRoute, number> = {
    general: 0,
    profile: scoreKeywords(text, PROFILE_KEYWORDS),
    rooms: scoreKeywords(text, ROOMS_KEYWORDS),
    payments: scoreKeywords(text, PAYMENT_KEYWORDS),
  };

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]) as Array<
    [SupervisorRoute, number]
  >;

  if (ranked[0][1] === 0) {
    return {
      route: "general",
      reason: "No strong heuristic intent signal found.",
      needsClarification: false,
    };
  }

  const isAmbiguous = ranked[0][1] === ranked[1][1] && ranked[0][1] > 0;
  return {
    route: isAmbiguous ? "general" : ranked[0][0],
    reason: isAmbiguous
      ? "Heuristic intent scores are ambiguous."
      : `Heuristic intent matched ${ranked[0][0]}.`,
    needsClarification: isAmbiguous,
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
    awaitingRentalStartDate,
  } = state;
  const textMessages = toTextOnlyMessages(messages);

  // JALUR PAKSA: Hanya jika benar-benar ada yang harus dikonfirmasi
  if (pendingAction) {
    log.info({ pendingAction: pendingAction.toolName }, "Strict routing to confirmation resolver");
    return { next: "resolve_confirmation" };
  }

  if (awaitingRentalStartDate) {
    log.info("Routing to rooms because rental draft is awaiting start date");
    return { next: "rooms" };
  }

  const chain = supervisorPrompt.pipe(llm);
  const conversation = getBufferString(textMessages);
  const result = await chain.invoke({
    agents: AGENTS.join(", "),
    summary: summary ? `Konteks sebelumnya:\n${summary}` : "",
    visionContext: visionAnalysis ? `Hasil analisis gambar:\n${visionAnalysis}` : "",
    proofContext: paymentProofImageUrl
      ? "Sistem mendeteksi ada foto bukti bayar pada turn ini."
      : "",
    conversation,
  });

  const rawResponse = String(result.content).trim();
  const parsedDecision = parseSupervisorDecision(rawResponse);
  const decision =
    parsedDecision ?? heuristicSupervisorRoute(conversation, visionResult, visionAnalysis);

  log.info(
    {
      selectedAgent: decision.route,
      reason: decision.reason,
      needsClarification: decision.needsClarification ?? false,
      usedHeuristicFallback: !parsedDecision,
    },
    "Supervisor routed",
  );

  return { next: decision.route };
};
