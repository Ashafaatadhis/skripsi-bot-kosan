import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { handleStart, handleMessage } from "../handlers/message.handler";

export function createTenantBot() {
  const token = process.env.TENANT_BOT_TOKEN;
  if (!token) throw new Error("TENANT_BOT_TOKEN is not set");

  const bot = new Telegraf(token);

  bot.start((ctx) => handleStart(ctx, "tenant"));
  bot.on(message("text"), (ctx) => handleMessage(ctx, "tenant"));

  bot.catch((err) => console.error("[TenantBot]", err));

  return bot;
}
