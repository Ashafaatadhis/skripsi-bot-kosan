import { interrupt } from "@langchain/langgraph";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { GraphStateType } from "../state";

export const HITL_TOOLS = new Set([
  "create_booking",
  "confirm_booking",
  "reject_booking",
  "create_payment",
  "submit_complaint",
]);

const CONFIRMATION_PROMPTS: Record<string, string> = {
  create_booking: "Konfirmasi pembuatan booking kamar.",
  confirm_booking: "Konfirmasi booking penyewa.",
  reject_booking: "Tolak booking penyewa.",
  create_payment: "Buat tagihan pembayaran sewa.",
  submit_complaint: "Kirim laporan kerusakan.",
};

export function needsConfirmation(toolName: string): boolean {
  return HITL_TOOLS.has(toolName);
}

export async function confirmToolNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const lastMessage = state.messages[state.messages.length - 1];

  if (!(lastMessage instanceof AIMessage) || !lastMessage.tool_calls?.length) {
    return { confirmationDecision: "rejected" };
  }

  const toolCall = lastMessage.tool_calls[0];
  const basePrompt =
    CONFIRMATION_PROMPTS[toolCall.name] ?? `Jalankan ${toolCall.name}.`;
  const prompt = `${basePrompt}\n\nBalas "ya" untuk lanjut atau "batal" untuk membatalkan.`;

  const userResponse: string = interrupt({ type: "tool_confirmation", prompt });

  const confirmed = ["ya", "yes", "iya", "ok", "lanjut", "lanjutkan"].includes(
    userResponse.trim().toLowerCase()
  );

  if (confirmed) {
    return { confirmationDecision: "confirmed" };
  }

  // Dangling tool_calls fix — harus ada ToolMessage sebelum AIMessage cancel
  const cancelMessages = [];
  if (toolCall.id) {
    cancelMessages.push(
      new ToolMessage({
        content: "[TOOL_CANCELLED] User membatalkan aksi.",
        tool_call_id: toolCall.id,
      })
    );
  }
  cancelMessages.push(new AIMessage("Oke, aksi dibatalkan."));

  return {
    confirmationDecision: "rejected",
    messages: cancelMessages,
  };
}
