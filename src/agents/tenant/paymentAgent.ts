import { paymentAgentPrompt } from "../../prompts/agents.prompt";
import { createAgentNode } from "../createAgent";
import type { StructuredToolInterface } from "@langchain/core/tools";

const TOOL_NAMES = ["create_payment", "get_payment_status", "get_payment_history"];

export const createPaymentAgent = (allTools: StructuredToolInterface[]) =>
  createAgentNode("payment_agent", paymentAgentPrompt, TOOL_NAMES, allTools);
