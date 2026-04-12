import "dotenv/config";
import { createBot } from "./bot/telegram.js";
import { initGraph } from "./graph/index.js";
import { initLongTermMemoryTable } from "./memory/longterm.js";
import { logger } from "./lib/logger.js";

const main = async () => {
  logger.info("Starting Kosan Bot...");

  // Initialize database tables
  await initLongTermMemoryTable();

  // Initialize graph
  await initGraph();

  // Create and launch bot
  const bot = createBot();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down...");
    bot.stop(signal);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Launch
  await bot.launch();
  logger.info("Bot is running!");
};

main().catch((error) => {
  logger.error(
    {
      error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
    "Failed to start bot",
  );
  process.exit(1);
});
