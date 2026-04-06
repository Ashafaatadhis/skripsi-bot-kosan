import { randomUUID } from "node:crypto";
import type { Context } from "telegraf";
import type { TraceContext } from "./logger";

export function buildTraceContext(
  ctx: Context,
  role: "tenant" | "owner",
  userId?: string,
): TraceContext {
  return {
    requestId: randomUUID(),
    chatId: ctx.chat ? String(ctx.chat.id) : undefined,
    telegramId: ctx.from ? String(ctx.from.id) : undefined,
    userId,
    role,
  };
}
