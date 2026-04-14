import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { createLogger } from "../lib/logger.js";
import { RegisterResponse } from "./types.js";
import { createBotHeaders } from "./auth.js";

const log = createLogger("mcp-client");

const MCP_URL = process.env.MCP_URL || "http://localhost:3000/mcp";
const API_URL = process.env.API_URL || "http://localhost:3000";

const userCache = new Map<string, RegisterResponse>();
let mcpClient: MultiServerMCPClient | null = null;

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const getMcpClient = async () => {
  if (!mcpClient) {
    mcpClient = new MultiServerMCPClient({
      kosan: {
        transport: "http",
        url: MCP_URL,
      },
    });
    log.info({ mcpUrl: MCP_URL }, "MCP client created");
  }
  return mcpClient;
};

export const getMcpTools = async () => {
  const client = await getMcpClient();
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const tools = await client.getTools(["kosan"], {
        headers: createBotHeaders(),
      });
      log.info(
        { toolCount: tools.length, attempt },
        "MCP tools loaded with bot auth",
      );
      return tools;
    } catch (error: any) {
      log.warn(
        {
          attempt,
          maxAttempts,
          error: error?.message ?? String(error),
        },
        "Failed to load MCP tools",
      );

      if (attempt === maxAttempts) {
        throw error;
      }

      await sleep(750 * attempt);
    }
  }

  throw new Error("Failed to load MCP tools");
};


export const registerUser = async (
  telegramId: string,
  name?: string,
): Promise<RegisterResponse> => {
  const cachedUser = userCache.get(telegramId);
  if (cachedUser) {
    log.info({ telegramId, userId: cachedUser.id }, "User loaded from cache");
    return cachedUser;
  }

  const res = await fetch(`${API_URL}/users/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...createBotHeaders(),
    },
    body: JSON.stringify({
      telegramId,
      role: "tenant",
      name: name?.trim() || `Tenant ${telegramId}`,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to register user: ${res.status}`);
  }

  const data = (await res.json()) as RegisterResponse;
  userCache.set(telegramId, data);
  log.info({ telegramId, userId: data.id }, "User registered");
  return data;
};

/**
 * Memanggil tool MCP secara resmi lewat LangChain (supaya Session ID aman)
 */
export const callSecureMcpTool = async (
  userId: string,
  toolName: string,
  args: Record<string, unknown>,
) => {
  const client = await getMcpClient();
  const mcpClient = await client.getClient("kosan", {
    headers: createBotHeaders(userId),
  });

  if (!mcpClient) {
    log.error({ toolName }, "MCP client connection unavailable");
    throw new Error("MCP client connection unavailable");
  }

  const secureArgs = { ...args };

  log.info({ userId, toolName }, "Calling secure MCP tool via LangChain adapter");

  try {
    const result = await mcpClient.callTool({
      name: toolName,
      arguments: secureArgs,
    });
    log.info({ toolName, hasResult: !!result }, "MCP invocation returned");
    return result;
  } catch (error: any) {
    log.error({ 
      toolName, 
      args: secureArgs,
      error: error.message,
      stack: error.stack 
    }, "MCP tool invocation failed");
    throw error;
  }
};
