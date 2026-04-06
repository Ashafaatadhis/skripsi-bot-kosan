import { HumanMessage } from "@langchain/core/messages";
import { llm } from "../../config/llm";
import type { GraphStateType } from "../state";

const MESSAGE_TOKEN_LIMIT = 1000;
const SUMMARY_TOKEN_LIMIT = 500;
const RECENT_RAW_TAIL_COUNT = 6;

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

function shouldSummarize(messages: GraphStateType["messages"]): boolean {
  const total = messages.reduce(
    (sum, m) => sum + estimateTokens(String(m.content)),
    0
  );
  return total > MESSAGE_TOKEN_LIMIT;
}

function shouldCondenseSummary(summary: string): boolean {
  return estimateTokens(summary) > SUMMARY_TOKEN_LIMIT;
}

export async function summarizeNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const { messages, summary } = state;

  if (!shouldSummarize(messages)) return {};

  const recentMessages = messages.slice(-RECENT_RAW_TAIL_COUNT);
  const olderMessages = messages.slice(0, -RECENT_RAW_TAIL_COUNT);

  const olderText = olderMessages
    .map((m) => `${m.getType() === "human" ? "User" : "AI"}: ${m.content}`)
    .join("\n");

  let prompt: string;
  if (summary && shouldCondenseSummary(summary)) {
    prompt = `Ringkas percakapan berikut menjadi lebih singkat (maks 400 karakter):\n\nSummary lama:\n${summary}\n\nPercakapan tambahan:\n${olderText}\n\nBuat ringkasan baru yang padat dalam Bahasa Indonesia.`;
  } else {
    const existing = summary ? `\nSummary sebelumnya:\n${summary}\n` : "";
    prompt = `Buat ringkasan singkat percakapan berikut dalam Bahasa Indonesia (maks 500 karakter):${existing}\nPercakapan:\n${olderText}`;
  }

  const response = await llm.invoke([new HumanMessage(prompt)]);

  return {
    summary: String(response.content),
    messages: recentMessages,
  };
}
