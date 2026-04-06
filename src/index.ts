import "dotenv/config";
import { createTenantBot } from "./bots/tenant.bot";
import { createOwnerBot } from "./bots/owner.bot";
import { logger } from "./logging/logger";

async function main() {
  const tenantBot = createTenantBot();
  const ownerBot = createOwnerBot();

  logger.info({ event: "bot_starting" }, "Starting bots");

  await Promise.all([tenantBot.launch(), ownerBot.launch()]);

  logger.info({ event: "bot_started" }, "Both bots are running");

  process.once("SIGINT", () => {
    logger.warn({ event: "bot_shutdown", signal: "SIGINT" }, "Stopping bots");
    tenantBot.stop("SIGINT");
    ownerBot.stop("SIGINT");
  });

  process.once("SIGTERM", () => {
    logger.warn({ event: "bot_shutdown", signal: "SIGTERM" }, "Stopping bots");
    tenantBot.stop("SIGTERM");
    ownerBot.stop("SIGTERM");
  });
}

main().catch((error) => {
  logger.error({ event: "bot_bootstrap_failed", error }, "Failed to start bots");
});
