import { StructuredToolInterface } from "@langchain/core/tools";
import { getMcpTools } from "../mcp/client.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("tools");

// Tool name mappings per agent
export const TOOL_MAPPINGS = {
  general: ["search_long_term_memory"],
  profile: ["get_profile", "update_profile"],
  rooms: [
    "search_houses",
    "get_house_detail",
    "get_room_detail",
    "search_rooms",
    "create_rental",
    "get_my_rentals",
    "get_rental_status",
    "cancel_rental",
  ],
  payments: ["create_payment", "get_pending_payments", "get_payment_status", "get_payment_history", "upload_payment_proof"],
} as const;

export type AgentWithTools = keyof typeof TOOL_MAPPINGS;

// Tools that require confirmation before execution
export const WRITE_TOOLS = [
  "update_profile",
  "create_rental",
  "cancel_rental",
  "create_payment",
  "upload_payment_proof",
] as const;

export const isWriteTool = (toolName: string): boolean => {
  return WRITE_TOOLS.includes(toolName as any);
};

export const hasWriteToolCall = (message: unknown): boolean => {
  const toolCalls = (message as { tool_calls?: Array<{ name: string }> })?.tool_calls;
  return !!toolCalls?.some((tc) => isWriteTool(tc.name));
};

export const hasAnyToolCall = (message: unknown): boolean => {
  const toolCalls = (message as { tool_calls?: Array<{ name: string }> })?.tool_calls;
  return !!toolCalls?.length;
};

export const isAiMessageWithToolCalls = (message: unknown): boolean => {
  return hasAnyToolCall(message);
};

// Cache for tools
let cachedTools: StructuredToolInterface[] | null = null;

export const getAllTools = async (): Promise<StructuredToolInterface[]> => {
  if (!cachedTools) {
    cachedTools = await getMcpTools();
    log.info(
      {
        toolCount: cachedTools.length,
        toolNames: cachedTools.map((t) => t.name),
      },
      "Tools loaded from MCP",
    );
  }
  return cachedTools;
};


/**
 * Memberikan subset tool yang relevan untuk agent tertentu.
 * Kontrak human-readable ID ditegakkan di layer MCP/service.
 */
export const getToolsForAI = async (agent: AgentWithTools): Promise<any[]> => {
  const tools = await getToolsForAgent(agent);

  return tools.map((tool) => tool);
};

export const getToolsForAgent = async (
  agent: AgentWithTools,
): Promise<StructuredToolInterface[]> => {
  const allTools = await getAllTools();
  const toolNames = TOOL_MAPPINGS[agent] as readonly string[];
  return allTools.filter((t) => toolNames.includes(String(t.name)));
};

// Convenience functions for each agent
export const getGeneralTools = () => getToolsForAgent("general");
export const getProfileTools = () => getToolsForAgent("profile");
export const getRoomsTools = () => getToolsForAgent("rooms");

// Helper to find which agent owns a tool
export const getAgentForTool = (toolName: string): AgentWithTools | null => {
  for (const [agent, tools] of Object.entries(TOOL_MAPPINGS) as [AgentWithTools, readonly string[]][]) {
    if (tools.includes(toolName)) {
      return agent;
    }
  }
  return null;
};
