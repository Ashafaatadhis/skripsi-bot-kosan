import { complaintAgentPrompt } from "../../prompts/agents.prompt";
import { createAgentNode } from "../createAgent";
import type { StructuredToolInterface } from "@langchain/core/tools";

const TOOL_NAMES = ["submit_complaint", "get_complaint_status"];

export const createComplaintAgent = (allTools: StructuredToolInterface[]) =>
  createAgentNode("complaint_agent", complaintAgentPrompt, TOOL_NAMES, allTools);
