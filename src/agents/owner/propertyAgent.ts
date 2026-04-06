import { propertyAgentPrompt } from "../../prompts/agents.prompt";
import { createAgentNode } from "../createAgent";
import type { StructuredToolInterface } from "@langchain/core/tools";

const TOOL_NAMES = ["add_room", "update_room", "set_room_status"];

export const createPropertyAgent = (allTools: StructuredToolInterface[]) =>
  createAgentNode("property_agent", propertyAgentPrompt, TOOL_NAMES, allTools);
