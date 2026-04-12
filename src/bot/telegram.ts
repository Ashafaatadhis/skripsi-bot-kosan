import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { registerUser } from "../mcp/client.js";
import { runChat } from "../graph/index.js";
import { createLogger } from "../lib/logger.js";
import { formatTelegramMessage } from "../lib/formatter.js";
import path from "node:path";
import fs from "node:fs";

const log = createLogger("telegram");

export const createBot = () => {
  const token = process.env.TENANT_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TENANT_BOT_TOKEN is required");
  }

  const bot = new Telegraf(token);

  // /start command
  bot.command("start", async (ctx) => {
    const telegramId = String(ctx.from.id);
    const chatId = String(ctx.chat.id);
    const displayName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || ctx.from.username;

    log.info({ telegramId, chatId }, "Start command received");

    try {
      // Register user
      const user = await registerUser(telegramId, displayName);

      await ctx.reply(
        formatTelegramMessage(
          `Halo! Selamat datang di Bot Kosan. 👋\n\n` +
            `Saya asisten virtual yang siap membantu Anda mencari dan menyewa kos.\n\n` +
            `Saat ini fitur masih dalam pengembangan. ` +
            `Silakan chat untuk bertanya seputar kosan!`,
        ),
        { parse_mode: "HTML" },
      );

      log.info({ userId: user.id }, "User registered and welcomed");
    } catch (error) {
      log.error({ error }, "Failed to handle start command");
      await ctx.reply("Maaf, terjadi kesalahan. Silakan coba lagi.");
    }
  });

  // Text messages
  bot.on(message("text"), async (ctx) => {
    const telegramId = String(ctx.from.id);
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text;
    const displayName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || ctx.from.username;

    log.info({ telegramId, chatId, text: text.slice(0, 50) }, "Message received");

    try {
      // Register/resolve user
      const user = await registerUser(telegramId, displayName);

      // Run graph
      const graphRes = await runChat(user.id, chatId, text);
      const formattedText = formatTelegramMessage(graphRes.text);

      // Helper untuk resolusi path gambar (Local vs URL)
      const getMediaSource = (url: string) => {
        if (url.startsWith("/uploads/")) {
          const localPath = path.join(process.cwd(), "..", "skripsi-web", "public", url);
          if (fs.existsSync(localPath)) {
            return { source: localPath };
          }
        }
        return url; // Fallback ke URL jika bukan path upload atau file tidak ada
      };

      try {
        if (graphRes.imageUrls.length === 1) {
          await ctx.sendPhoto(getMediaSource(graphRes.imageUrls[0]), {
            caption: formattedText,
            parse_mode: "HTML",
          });
        } else if (graphRes.imageUrls.length > 1) {
          const media = graphRes.imageUrls.slice(0, 10).map((url, index) => ({
            type: "photo" as const,
            media: getMediaSource(url),
            caption: index === 0 ? formattedText : undefined,
            parse_mode: "HTML" as const,
          }));
          await ctx.sendMediaGroup(media);
        } else {
          await ctx.reply(formattedText, { parse_mode: "HTML" });
        }
      } catch (err: any) {
        log.error({ err: err.message }, "Telegram media sending failed, falling back to text + document");
        
        // Cek jika error spesifik soal dimensi foto
        if (err.description?.includes("PHOTO_INVALID_DIMENSIONS")) {
           await ctx.reply(formattedText + "\n\n(Gambar dikirim sebagai lampiran karena format tidak didukung pengiriman foto biasa)", { parse_mode: "HTML" });
           for (const url of graphRes.imageUrls) {
             await ctx.sendDocument(getMediaSource(url));
           }
        } else {
           // Fallback umum ke balasan teks saja jika yang lain gagal
           await ctx.reply(formattedText, { parse_mode: "HTML" });
        }
      }

      log.info({ userId: user.id, imageCount: graphRes.imageUrls.length }, "Response sent");
    } catch (error) {
      log.error({ error }, "Failed to handle message");
      await ctx.reply("Maaf, terjadi kesalahan. Silakan coba lagi.");
    }
  });

  return bot;
};
