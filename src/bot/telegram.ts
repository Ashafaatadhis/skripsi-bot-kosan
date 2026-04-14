import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { registerUser } from "../mcp/client.js";
import { runChat } from "../graph/index.js";
import { createLogger } from "../lib/logger.js";
import { formatTelegramMessage } from "../lib/formatter.js";
import path from "node:path";
import fs from "node:fs";

const log = createLogger("telegram");

const saveTelegramPhotoTemp = async (buffer: Buffer, extension = ".jpg") => {
  const targetDir = path.join(process.cwd(), "..", "skripsi-web", "public", "uploads", "temp");
  await mkdir(targetDir, { recursive: true });

  const fileName = `${Date.now()}-${randomUUID()}${extension}`;
  const targetPath = path.join(targetDir, fileName);
  await writeFile(targetPath, buffer);

  return `/uploads/temp/${fileName}`;
};

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
      const user = await registerUser(telegramId, displayName);
      await ctx.reply(
        formatTelegramMessage(
          `Halo! Selamat datang di Bot Kosan. 👋\n\n` +
            `Saya asisten virtual yang siap membantu Anda mencari dan menyewa kos.\n\n` +
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
      const user = await registerUser(telegramId, displayName);
      const graphRes = await runChat(user.id, chatId, text);
      const formattedText = formatTelegramMessage(graphRes.text);

      const getMediaSource = (url: string) => {
        if (url.startsWith("/uploads/")) {
          const localPath = path.join(process.cwd(), "..", "skripsi-web", "public", url);
          if (fs.existsSync(localPath)) {
            return { source: localPath };
          }
        }
        return url;
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
        log.error({ err: err.message }, "Telegram media sending failed");
        await ctx.reply(formattedText, { parse_mode: "HTML" });
      }
      log.info({ userId: user.id, imageCount: graphRes.imageUrls.length }, "Response sent");
    } catch (error) {
      log.error({ error }, "Failed to handle message");
      await ctx.reply("Maaf, terjadi kesalahan. Silakan coba lagi.");
    }
  });

  // Photo messages (IN-MEMORY VISION FLOW)
  bot.on(message("photo"), async (ctx) => {
    const telegramId = String(ctx.from.id);
    const chatId = String(ctx.chat.id);
    const displayName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || ctx.from.username;

    log.info({ telegramId, chatId }, "Photo received for in-memory processing");

    try {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const fileId = photo.file_id;
      const fileLink = await ctx.telegram.getFileLink(fileId);

      // Download ke memori (buffer) untuk langsung dikirim ke AI Vision
      const response = await fetch(fileLink.href);
      const buffer = Buffer.from(await response.arrayBuffer());
      const base64Image = buffer.toString("base64");
      const dataUrl = `data:image/jpeg;base64,${base64Image}`;
      const tempImageUrl = await saveTelegramPhotoTemp(buffer);

      const user = await registerUser(telegramId, displayName);
      const caption = (ctx.message as any).caption || "";

      // Kirim ke graph: base64 untuk vision, temp URL untuk upload bukti bayar
      const graphRes = await runChat(user.id, chatId, caption, [dataUrl], tempImageUrl);
      const formattedText = formatTelegramMessage(graphRes.text);

      await ctx.reply(formattedText, { parse_mode: "HTML" });
      log.info({ userId: user.id }, "Photo processed in-memory and response sent");
    } catch (error) {
      log.error({ error }, "Failed to handle photo");
      await ctx.reply("Maaf, gagal memproses foto Anda.");
    }
  });

  return bot;
};
