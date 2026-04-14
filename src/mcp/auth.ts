import { createHmac } from "node:crypto";

const BOT_SECRET_HEADER = "x-mcp-bot-secret";
const TENANT_CONTEXT_HEADER = "x-tenant-context";
const DEFAULT_SHARED_SECRET = "dev-mcp-shared-secret-change-me";

type TenantContextPayload = {
  userId: string;
};

const getSharedSecret = () =>
  process.env.MCP_SHARED_SECRET?.trim() || DEFAULT_SHARED_SECRET;

const toBase64Url = (value: string) => Buffer.from(value).toString("base64url");

const sign = (value: string) =>
  createHmac("sha256", getSharedSecret()).update(value).digest("base64url");

const createTenantContextToken = (userId: string): string => {
  const payload = toBase64Url(
    JSON.stringify({ userId } satisfies TenantContextPayload),
  );
  return `${payload}.${sign(payload)}`;
};

export const createBotHeaders = (userId?: string): Record<string, string> => {
  const headers: Record<string, string> = {
    [BOT_SECRET_HEADER]: getSharedSecret(),
  };

  if (userId) {
    headers[TENANT_CONTEXT_HEADER] = createTenantContextToken(userId);
  }

  return headers;
};

export const MCP_AUTH_HEADERS = {
  botSecret: BOT_SECRET_HEADER,
  tenantContext: TENANT_CONTEXT_HEADER,
} as const;
