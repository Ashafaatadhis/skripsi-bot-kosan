import type { Context } from "telegraf";
import { runChat } from "../graph/runner";
import {
  createOwnerKosan,
  getOwnerKosan,
  registerUser,
} from "../mcp/client";
import { createTraceLogger, truncateText } from "../logging/logger";
import { buildTraceContext } from "../logging/request";

const ownerOnboardingState = new Map<
  string,
  {
    userId: string;
    step: "name" | "address" | "description";
    data: { name?: string; address?: string; description?: string };
  }
>();

async function ensureOwnerOnboarding(ctx: Context, userId: string, trace: ReturnType<typeof buildTraceContext>) {
  const log = createTraceLogger("message-handler", { ...trace, userId, role: "owner" });
  const chatId = trace.chatId!;

  const existingKosan = await getOwnerKosan(userId, { ...trace, userId, role: "owner" });
  if (existingKosan) {
    ownerOnboardingState.delete(chatId);
    return false;
  }

  if (!ownerOnboardingState.has(chatId)) {
    ownerOnboardingState.set(chatId, {
      userId,
      step: "name",
      data: {},
    });

    log.info({ event: "owner_onboarding_started" }, "Owner onboarding started");
    await ctx.reply(
      "Sebelum mulai, saya perlu data kosan kamu dulu.\n\nNama kosan kamu apa?",
    );
    return true;
  }

  return false;
}

async function handleOwnerOnboardingMessage(
  ctx: Context,
  text: string,
  trace: ReturnType<typeof buildTraceContext>,
) {
  const chatId = trace.chatId!;
  const state = ownerOnboardingState.get(chatId);
  if (!state) return false;

  const log = createTraceLogger("message-handler", {
    ...trace,
    userId: state.userId,
    role: "owner",
  });

  if (state.step === "name") {
    state.data.name = text.trim();
    state.step = "address";
    ownerOnboardingState.set(chatId, state);

    log.info({ event: "owner_onboarding_name_collected" }, "Collected kosan name");
    await ctx.reply("Alamat lengkap kosan kamu apa?");
    return true;
  }

  if (state.step === "address") {
    state.data.address = text.trim();
    state.step = "description";
    ownerOnboardingState.set(chatId, state);

    log.info({ event: "owner_onboarding_address_collected" }, "Collected kosan address");
    await ctx.reply("Deskripsi singkat kosan (opsional). Kalau tidak ada, balas '-' saja.");
    return true;
  }

  if (state.step === "description") {
    state.data.description = text.trim() === "-" ? undefined : text.trim();

    const kosan = await createOwnerKosan(
      {
        ownerId: state.userId,
        name: state.data.name!,
        address: state.data.address!,
        description: state.data.description,
      },
      {
        ...trace,
        userId: state.userId,
        role: "owner",
      },
    );

    ownerOnboardingState.delete(chatId);

    log.info(
      {
        event: "owner_onboarding_completed",
        kosanId: kosan.id,
      },
      "Owner onboarding completed",
    );

    await ctx.reply(
      `Siap! Kosan \"${kosan.name}\" sudah terdaftar.\nSekarang kamu bisa mulai tambah kamar atau kelola data kosan.`,
    );
    return true;
  }

  return false;
}

export async function handleStart(ctx: Context, role: "tenant" | "owner") {
  const initialTrace = buildTraceContext(ctx, role);
  const log = createTraceLogger("message-handler", initialTrace);

  try {
    log.info({ event: "telegram_start_received" }, "Received /start command");

    const from = ctx.from!;
    const user = await registerUser(from.id, from.first_name ?? "User", role, initialTrace);
    const trace = { ...initialTrace, userId: user.id };
    const tracedLog = createTraceLogger("message-handler", trace);

    if (role === "owner") {
      const onboardingHandled = await ensureOwnerOnboarding(ctx, user.id, trace);
      if (onboardingHandled) {
        return;
      }
    }

    const greeting =
      role === "tenant"
        ? `Halo ${from.first_name}! Selamat datang di KosanBot.\nSaya bisa bantu kamu cari kamar, booking, bayar sewa, dan lapor kerusakan.\n\nMau mulai dari mana?`
        : `Halo ${from.first_name}! Selamat datang di KosanBot Pemilik.\nSaya bisa bantu kelola kamar, konfirmasi booking, dan lihat laporan.\n\nApa yang ingin kamu lakukan?`;

    tracedLog.info({ event: "telegram_start_reply" }, "Sending greeting message");
    await ctx.reply(greeting);
  } catch (error) {
    log.error({ event: "telegram_start_failed", error }, "Failed to handle /start");
    await ctx.reply("Maaf, terjadi kesalahan. Coba lagi ya.");
  }
}

export async function handleMessage(ctx: Context, role: "tenant" | "owner") {
  const text = (ctx.message as { text?: string } | undefined)?.text;
  if (!text) return;

  const initialTrace = buildTraceContext(ctx, role);
  const log = createTraceLogger("message-handler", initialTrace);

  try {
    log.info(
      {
        event: "telegram_message_received",
        inputPreview: truncateText(text),
      },
      "Received Telegram message",
    );

    await ctx.sendChatAction("typing");

    const from = ctx.from!;
    const user = await registerUser(from.id, from.first_name ?? "User", role, initialTrace);
    const trace = { ...initialTrace, userId: user.id };
    const tracedLog = createTraceLogger("message-handler", trace);

    tracedLog.info({ event: "user_registered" }, "User context resolved");

    if (role === "owner") {
      const onboardingConsumed = await handleOwnerOnboardingMessage(ctx, text, trace);
      if (onboardingConsumed) {
        return;
      }

      const onboardingStarted = await ensureOwnerOnboarding(ctx, user.id, trace);
      if (onboardingStarted) {
        return;
      }
    }

    const response = await runChat(
      {
        chatId: trace.chatId!,
        userText: text,
        userId: user.id,
        role,
      },
      trace,
    );

    const finalResponse = response.trim() || "Maaf, saya belum bisa memberi respons. Coba lagi ya.";

    tracedLog.info(
      {
        event: "telegram_message_reply",
        outputPreview: truncateText(finalResponse),
      },
      "Sending Telegram reply",
    );

    await ctx.reply(finalResponse);
  } catch (error) {
    log.error({ event: "telegram_message_failed", error }, "Failed to handle message");
    await ctx.reply("Maaf, terjadi kesalahan. Coba lagi ya.");
  }
}
