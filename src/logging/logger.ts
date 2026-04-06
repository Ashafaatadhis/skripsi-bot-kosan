import pino from "pino";

export type TraceContext = {
  requestId?: string;
  chatId?: string;
  telegramId?: string;
  userId?: string;
  role?: string;
};

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    app: "kosan-bot",
    env: process.env.NODE_ENV ?? "development",
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  redact: {
    paths: ["authorization", "headers.authorization"],
    remove: true,
  },
});

export function createTraceLogger(service: string, trace: TraceContext = {}) {
  return logger.child({ service, ...trace });
}

export function truncateText(text: string, maxLength = 160): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
}
