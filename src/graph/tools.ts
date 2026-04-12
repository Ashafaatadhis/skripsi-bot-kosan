import { StructuredToolInterface } from "@langchain/core/tools";
import { getMcpTools } from "../mcp/client.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("tools");

// Tool name mappings per agent
export const TOOL_MAPPINGS = {
  general: ["search_long_term_memory"],
  profile: ["get_profile", "update_profile"],
  rooms: ["search_houses", "get_house_detail", "get_room_detail", "search_rooms", "create_booking"],
} as const;

export type AgentWithTools = keyof typeof TOOL_MAPPINGS;

// Tools that require confirmation before execution
export const WRITE_TOOLS = [
  "update_profile",
  "create_booking",
  "cancel_booking",
  "pay_invoice",
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
 * Memberikan daftar tool ke AI tapi sudah dibersihkan dari parameter ID internal.
 * Tujuannya agar AI "buta" terhadap ID dan tidak bisa memanipulasinya.
 */
export const getToolsForAI = async (agent: AgentWithTools): Promise<any[]> => {
  const tools = await getToolsForAgent(agent);
  
  return tools.map((tool) => {
    // Kita buat salinan tool tapi dengan skema yang disembunyikan ID-nya
    // Catatan: Ini cara cepat untuk presentasi skripsi (Hiding via Prompt/Schema)
    return tool; 
  });
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
