import { StateGraph, START, END } from "@langchain/langgraph";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { AIMessage } from "@langchain/core/messages";

import { GraphState } from "./state";
import { summarizeNode } from "./nodes/summarize";
import { supervisorNode } from "./nodes/supervisor";
import { confirmToolNode, needsConfirmation } from "./nodes/confirmTool";

import { createSearchAgent } from "../agents/tenant/searchAgent";
import { createBookingAgent } from "../agents/tenant/bookingAgent";
import { createPaymentAgent } from "../agents/tenant/paymentAgent";
import { createComplaintAgent } from "../agents/tenant/complaintAgent";
import { createPropertyAgent } from "../agents/owner/propertyAgent";
import { createBookingMgmtAgent } from "../agents/owner/bookingMgmtAgent";
import { createReportAgent } from "../agents/owner/reportAgent";

function routeAfterSupervisor(state: typeof GraphState.State) {
  return state.next || END;
}

function routeAfterAgent(state: typeof GraphState.State) {
  if (state.forceSupervisorReroute) return "supervisor";

  const lastMessage = state.messages[state.messages.length - 1];
  if (!(lastMessage instanceof AIMessage)) return END;
  if (!lastMessage.tool_calls?.length) return END;

  return needsConfirmation(lastMessage.tool_calls[0].name)
    ? "confirm_tool"
    : END;
}

function routeAfterConfirm(state: typeof GraphState.State) {
  return state.confirmationDecision === "confirmed" ? "tool_executor" : END;
}

export function buildGraph(
  checkpointer: PostgresSaver,
  mcpTools: StructuredToolInterface[]
) {
  const graph = new StateGraph(GraphState)
    .addNode("summarize", summarizeNode)
    .addNode("supervisor", supervisorNode)
    .addNode("confirm_tool", confirmToolNode)
    .addNode("search_agent", createSearchAgent(mcpTools))
    .addNode("booking_agent", createBookingAgent(mcpTools))
    .addNode("payment_agent", createPaymentAgent(mcpTools))
    .addNode("complaint_agent", createComplaintAgent(mcpTools))
    .addNode("property_agent", createPropertyAgent(mcpTools))
    .addNode("booking_mgmt_agent", createBookingMgmtAgent(mcpTools))
    .addNode("report_agent", createReportAgent(mcpTools))
    .addEdge(START, "summarize")
    .addEdge("summarize", "supervisor")
    .addConditionalEdges("supervisor", routeAfterSupervisor)
    .addConditionalEdges("confirm_tool", routeAfterConfirm);

  for (const agentName of [
    "search_agent",
    "booking_agent",
    "payment_agent",
    "complaint_agent",
    "property_agent",
    "booking_mgmt_agent",
    "report_agent",
  ]) {
    graph.addConditionalEdges(agentName as any, routeAfterAgent);
  }

  return graph.compile({ checkpointer });
}
