import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { GraphStateType } from "../state.js";
import { supervisorLLM } from "../../llm/index.js";
import {
  AGENTS,
  buildRuntimeContext,
  clarificationResolverPrompt,
} from "../../prompts/index.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("clarify");

type ClarificationRoute = (typeof AGENTS)[number];

type ClarificationResolution = {
  resolved: boolean;
  route: ClarificationRoute | null;
  reason?: string;
  followUpQuestion?: string;
};

const ROUTE_LABELS: Record<ClarificationRoute, string> = {
  general: "hal umum atau isi gambar",
  profile: "profil atau data akun",
  rooms: "kamar atau kosan",
  payments: "pembayaran atau tagihan",
};

const extractJsonObject = (content: string): string | null => {
  const match = content.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
};

const normalizeRoute = (value: string | undefined): ClarificationRoute | null => {
  if (!value) return null;
  const route = value.trim().toLowerCase();
  return AGENTS.includes(route as ClarificationRoute)
    ? (route as ClarificationRoute)
    : null;
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
    if (messages[i] instanceof HumanMessage) {
      return getMessageText(messages[i]).trim();
    }
  }

  return "";
};

const buildFallbackQuestion = (candidateRoutes: ClarificationRoute[]): string => {
  if (candidateRoutes.length >= 2) {
    const [first, second] = candidateRoutes;
    return `Maksudmu mau bahas ${ROUTE_LABELS[first]}, atau ${ROUTE_LABELS[second]}?`;
  }

  return "Bisa jelasin maksudmu sedikit lagi?";
};

const parseClarificationResolution = (
  content: string,
): ClarificationResolution | null => {
  const jsonText = extractJsonObject(content);
  if (!jsonText) return null;

  try {
    const parsed = JSON.parse(jsonText) as {
      resolved?: boolean;
      route?: string;
      reason?: string;
      followUpQuestion?: string;
    };

    const route = normalizeRoute(parsed.route);
    if (parsed.resolved === true && route) {
      return {
        resolved: true,
        route,
        reason: parsed.reason,
        followUpQuestion: "",
      };
    }

    if (parsed.resolved === false) {
      return {
        resolved: false,
        route: null,
        reason: parsed.reason,
        followUpQuestion:
          typeof parsed.followUpQuestion === "string"
            ? parsed.followUpQuestion
            : "",
      };
    }
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to parse clarification resolution",
    );
  }

  return null;
};

export const clarifyNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const { pendingClarification } = state;

  if (!pendingClarification) {
    log.warn("Clarify node reached without pending clarification");
    return {
      messages: [new AIMessage("Bisa jelasin maksudmu sedikit lagi?")],
    };
  }

  log.info(
    {
      attempts: pendingClarification.attempts,
      candidateRoutes: pendingClarification.candidateRoutes,
    },
    "Sending clarification question",
  );

  return {
    messages: [new AIMessage(pendingClarification.question)],
  };
};

export const resolveClarificationNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const { pendingClarification, messages, summary } = state;

  if (!pendingClarification) {
    log.warn("No pending clarification to resolve");
    return {
      next: "general",
      pendingClarification: null,
    };
  }

  const userReply = getLatestHumanText(messages);

  const chain = clarificationResolverPrompt.pipe(supervisorLLM);
  const result = await chain.invoke({
    runtimeContext: buildRuntimeContext([
      ["SUMMARY", summary ? `Konteks sebelumnya:\n${summary}` : ""],
      [
        "VISION_AGENT_RESULT",
        pendingClarification.visionAnalysis
          ? `Konteks gambar dari turn ambigu:\n${pendingClarification.visionAnalysis}`
          : "",
      ],
      ["KANDIDAT_AGENT", pendingClarification.candidateRoutes.join(", ")],
      ["AGENT_SEBELUMNYA", pendingClarification.suggestedRoute],
      ["ALASAN_KLARIFIKASI", pendingClarification.reason],
      ["PESAN_USER_AWAL", pendingClarification.originalUserText],
      ["PERTANYAAN_TERKIRIM", pendingClarification.question],
      ["JAWABAN_USER_SEKARANG", userReply],
    ]),
  });

  const rawResponse = String(result.content).trim();
  const resolution = parseClarificationResolution(rawResponse);

  if (resolution?.resolved && resolution.route) {
    log.info(
      {
        route: resolution.route,
        reason: resolution.reason,
        userReply,
      },
      "Clarification resolved",
    );

    return {
      next: resolution.route,
      pendingClarification: null,
    };
  }

  if (pendingClarification.attempts >= 2) {
    log.info(
      {
        suggestedRoute: pendingClarification.suggestedRoute,
        userReply,
      },
      "Clarification still ambiguous after retry; falling back to suggested route",
    );

    return {
      next: pendingClarification.suggestedRoute,
      pendingClarification: null,
    };
  }

  const nextQuestion =
    resolution?.followUpQuestion?.trim() ||
    buildFallbackQuestion(pendingClarification.candidateRoutes);

  log.info(
    {
      attempts: pendingClarification.attempts + 1,
      candidateRoutes: pendingClarification.candidateRoutes,
      userReply,
    },
    "Clarification still ambiguous; asking a sharper follow-up question",
  );

  return {
    next: "clarify",
    pendingClarification: {
      ...pendingClarification,
      question: nextQuestion,
      attempts: pendingClarification.attempts + 1,
    },
  };
};
