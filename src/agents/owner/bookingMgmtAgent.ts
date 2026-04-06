import { bookingMgmtAgentPrompt } from "../../prompts/agents.prompt";
import { createAgentNode } from "../createAgent";
import type { StructuredToolInterface } from "@langchain/core/tools";

const TOOL_NAMES = ["list_pending_bookings", "confirm_booking", "reject_booking"];

export const createBookingMgmtAgent = (allTools: StructuredToolInterface[]) =>
  createAgentNode("booking_mgmt_agent", bookingMgmtAgentPrompt, TOOL_NAMES, allTools);
