import { bookingAgentPrompt } from "../../prompts/agents.prompt";
import { createAgentNode } from "../createAgent";
import type { StructuredToolInterface } from "@langchain/core/tools";

const TOOL_NAMES = ["create_booking", "get_booking_status", "cancel_booking"];

export const createBookingAgent = (allTools: StructuredToolInterface[]) =>
  createAgentNode("booking_agent", bookingAgentPrompt, TOOL_NAMES, allTools);
