import { searchAgentPrompt } from "../../prompts/agents.prompt";
import { createAgentNode } from "../createAgent";
import type { StructuredToolInterface } from "@langchain/core/tools";

const TOOL_NAMES = ["search_rooms", "get_room_detail"];

export const createSearchAgent = (allTools: StructuredToolInterface[]) =>
  createAgentNode("search_agent", searchAgentPrompt, TOOL_NAMES, allTools);
