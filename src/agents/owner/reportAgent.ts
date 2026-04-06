import { reportAgentPrompt } from "../../prompts/agents.prompt";
import { createAgentNode } from "../createAgent";
import type { StructuredToolInterface } from "@langchain/core/tools";

const TOOL_NAMES = ["get_occupancy_report", "get_payment_report", "list_complaints"];

export const createReportAgent = (allTools: StructuredToolInterface[]) =>
  createAgentNode("report_agent", reportAgentPrompt, TOOL_NAMES, allTools);
