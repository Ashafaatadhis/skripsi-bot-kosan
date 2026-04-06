import type { StructuredToolInterface } from "@langchain/core/tools";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { createTraceLogger, logger } from "../logging/logger";
import type { TraceContext } from "../logging/logger";

const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "http://localhost:3000";

let mcpClient: MultiServerMCPClient | null = null;
let cachedTools: StructuredToolInterface[] | null = null;

type RegisteredUser = {
  id: string;
  name: string;
  role: string;
};

type OwnerKosan = {
  id: string;
  name: string;
  address: string | null;
  description: string | null;
} | null;

function isRegisteredUser(value: unknown): value is RegisteredUser {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.role === "string"
  );
}

function isOwnerKosan(value: unknown): value is OwnerKosan {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;

  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.name === "string";
}

export async function getMcpClient(): Promise<MultiServerMCPClient> {
  if (!mcpClient) {
    logger.info(
      {
        event: "mcp_client_init",
        mcpServerUrl: MCP_SERVER_URL,
      },
      "Initializing MCP client",
    );

    mcpClient = new MultiServerMCPClient({
      kosan: {
        transport: "http",
        url: `${MCP_SERVER_URL}/mcp`,
      },
    });
  }

  return mcpClient;
}

export async function getMcpTools(): Promise<StructuredToolInterface[]> {
  if (cachedTools) return cachedTools;

  const client = await getMcpClient();
  cachedTools = await client.getTools();

  logger.info(
    {
      event: "mcp_tools_loaded",
      toolCount: cachedTools.length,
      toolNames: cachedTools.map((tool) => tool.name),
    },
    "Loaded MCP tools",
  );

  return cachedTools;
}

export async function registerUser(
  telegramId: number,
  name: string,
  role: "tenant" | "owner",
  trace: TraceContext = {},
): Promise<RegisteredUser> {
  const log = createTraceLogger("mcp-client", {
    ...trace,
    telegramId: trace.telegramId ?? String(telegramId),
    role: trace.role ?? role,
  });

  log.info({ event: "register_user_request" }, "Registering or resolving user");

  const res = await fetch(`${MCP_SERVER_URL}/users/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ telegramId, name, role }),
  });

  if (!res.ok) {
    log.error(
      {
        event: "register_user_failed",
        statusCode: res.status,
      },
      "User registration failed",
    );
    throw new Error(`registerUser failed: ${res.status}`);
  }

  const data: unknown = await res.json();
  if (!isRegisteredUser(data)) {
    log.error({ event: "register_user_invalid_response" }, "Invalid register user response");
    throw new Error("registerUser returned invalid response");
  }

  log.info(
    {
      event: "register_user_success",
      resolvedUserId: data.id,
    },
    "User registration resolved",
  );

  return data;
}

export async function getOwnerKosan(
  ownerId: string,
  trace: TraceContext = {},
): Promise<OwnerKosan> {
  const log = createTraceLogger("mcp-client", {
    ...trace,
    userId: trace.userId ?? ownerId,
    role: trace.role ?? "owner",
  });

  const url = new URL(`${MCP_SERVER_URL}/kosan/me`);
  url.searchParams.set("ownerId", ownerId);

  log.info({ event: "get_owner_kosan_request", ownerId }, "Fetching owner kosan");

  const res = await fetch(url.toString());
  if (!res.ok) {
    log.error(
      {
        event: "get_owner_kosan_failed",
        ownerId,
        statusCode: res.status,
      },
      "Failed to fetch owner kosan",
    );
    throw new Error(`getOwnerKosan failed: ${res.status}`);
  }

  const raw = await res.text();
  const data: unknown = raw.trim() ? JSON.parse(raw) : null;
  if (!isOwnerKosan(data)) {
    log.error({ event: "get_owner_kosan_invalid_response", ownerId }, "Invalid owner kosan response");
    throw new Error("getOwnerKosan returned invalid response");
  }

  log.info(
    {
      event: "get_owner_kosan_success",
      ownerId,
      found: Boolean(data),
    },
    "Owner kosan lookup completed",
  );

  return data;
}

export async function createOwnerKosan(
  input: { ownerId: string; name: string; address: string; description?: string },
  trace: TraceContext = {},
): Promise<Exclude<OwnerKosan, null>> {
  const log = createTraceLogger("mcp-client", {
    ...trace,
    userId: trace.userId ?? input.ownerId,
    role: trace.role ?? "owner",
  });

  log.info({ event: "create_owner_kosan_request", ownerId: input.ownerId }, "Creating owner kosan");

  const res = await fetch(`${MCP_SERVER_URL}/kosan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    log.error(
      {
        event: "create_owner_kosan_failed",
        ownerId: input.ownerId,
        statusCode: res.status,
      },
      "Failed to create owner kosan",
    );
    throw new Error(`createOwnerKosan failed: ${res.status}`);
  }

  const data: unknown = await res.json();
  if (!isOwnerKosan(data) || data === null) {
    log.error({ event: "create_owner_kosan_invalid_response", ownerId: input.ownerId }, "Invalid create owner kosan response");
    throw new Error("createOwnerKosan returned invalid response");
  }

  log.info(
    {
      event: "create_owner_kosan_success",
      ownerId: input.ownerId,
      kosanId: data.id,
    },
    "Owner kosan created successfully",
  );

  return data;
}
