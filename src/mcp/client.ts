import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { createLogger } from "../lib/logger.js";
import { JsonRpcResponse, RegisterResponse } from "./types.js";

const log = createLogger("mcp-client");

const MCP_URL = process.env.MCP_URL || "http://localhost:3000/mcp";
const API_URL = process.env.API_URL || "http://localhost:3000";

const userCache = new Map<string, RegisterResponse>();
let mcpClient: MultiServerMCPClient | null = null;

export const getMcpClient = async () => {
  if (!mcpClient) {
    mcpClient = new MultiServerMCPClient({
      kosan: {
        transport: "http",
        url: MCP_URL,
      },
    });
    await mcpClient.initializeConnections();
    log.info("MCP client initialized");
  }
  return mcpClient;
};

export const getMcpTools = async () => {
  const client = await getMcpClient();
  return client.getTools();
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
    headers: { "Content-Type": "application/json" },
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
  args: any,
) => {
  const client = await getMcpClient();
  const tools = await client.getTools();
  const tool = tools.find((t) => t.name === toolName);

  if (!tool) {
    log.error({ toolName }, "Tool not found in MCP client tools list");
    throw new Error(`Tool ${toolName} not found`);
  }

  log.info({ userId, toolName }, "Calling secure MCP tool via LangChain adapter");

  // Suntikkan userId ke dalam argumen sebelum eksekusi (Way A)
  const secureArgs = { ...args, userId };

  // Panggil lewat jalur resmi LangChain
  const result = await tool.invoke(secureArgs);
  
  log.info({ toolName, hasResult: !!result }, "MCP invocation returned");

  return result;
};
