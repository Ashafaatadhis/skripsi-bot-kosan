import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { handleStart, handleMessage } from "../handlers/message.handler";

export function createOwnerBot() {
  const token = process.env.OWNER_BOT_TOKEN;
  if (!token) throw new Error("OWNER_BOT_TOKEN is not set");

  const bot = new Telegraf(token);

  bot.start((ctx) => handleStart(ctx, "owner"));
  bot.on(message("text"), (ctx) => handleMessage(ctx, "owner"));

  bot.catch((err) => console.error("[OwnerBot]", err));

  return bot;
}
