import { supervisorPrompt } from "../../prompts/supervisor.prompt";
import { llm } from "../../config/llm";
import type { GraphStateType } from "../state";

const TENANT_AGENTS = ["search_agent", "booking_agent", "payment_agent", "complaint_agent"];
const OWNER_AGENTS = ["property_agent", "booking_mgmt_agent", "report_agent"];

const chain = supervisorPrompt.pipe(llm);

export async function supervisorNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const { role, summary, messages, forceSupervisorReroute, rerouteReason } = state;

  const availableAgents = role === "tenant" ? TENANT_AGENTS : OWNER_AGENTS;
  const lastHuman = [...messages].reverse().find((m) => m.getType() === "human");

  const response = await chain.invoke({
    role: role === "tenant" ? "PENYEWA" : "PEMILIK",
    agents: availableAgents.join(", "),
    summary: summary ? `Konteks percakapan: ${summary}` : "",
    rerouteWarning: forceSupervisorReroute
      ? `PERHATIAN - Reroute karena: ${rerouteReason}`
      : "",
    input: String(lastHuman?.content ?? ""),
  });

  const next = String(response.content).trim().toLowerCase();
  const validNext = availableAgents.includes(next) ? next : availableAgents[0];

  return {
    next: validNext,
    forceSupervisorReroute: false,
    rerouteReason: "",
  };
}
