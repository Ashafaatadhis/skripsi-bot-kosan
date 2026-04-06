import { AIMessage } from "@langchain/core/messages";
import type { ChatPromptTemplate } from "@langchain/core/prompts";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { llm } from "../config/llm";
import { createTraceLogger } from "../logging/logger";
import { needsConfirmation } from "../graph/nodes/confirmTool";
import type { GraphStateType } from "../graph/state";

export function createAgentNode(
  agentName: string,
  prompt: ChatPromptTemplate,
  toolNames: string[],
  allTools: StructuredToolInterface[],
) {
  const tools = allTools.filter((tool) => toolNames.includes(tool.name));

  if (tools.length === 0) {
    createTraceLogger("agent-factory").warn(
      {
        event: "agent_tools_missing",
        agentName,
        expectedToolNames: toolNames,
      },
      "No MCP tools matched for agent",
    );
  }

  const llmWithTools = llm.bindTools(tools);
  const toolNode = new ToolNode(tools);
  const chain = prompt.pipe(llmWithTools);

  return async function agentNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const trace = {
      requestId: undefined,
      chatId: undefined,
      telegramId: undefined,
      userId: state.userId,
      role: state.role,
    };
    const log = createTraceLogger(`agent:${agentName}`, trace);
    const { messages, summary } = state;

    log.info(
      {
        event: "agent_invoke_start",
        agentName,
        toolNames: tools.map((tool) => tool.name),
      },
      "Invoking agent",
    );

    const response = (await chain.invoke({
      messages,
      summary: summary ? `Konteks percakapan: ${summary}` : "",
    })) as AIMessage;

    if (!response.tool_calls?.length) {
      log.info(
        {
          event: "agent_response_without_tool",
          agentName,
        },
        "Agent responded without tool call",
      );
      return { messages: [response] };
    }

    const toolCall = response.tool_calls[0];

    log.info(
      {
        event: "agent_tool_selected",
        agentName,
        toolName: toolCall.name,
      },
      "Agent selected tool",
    );

    if (needsConfirmation(toolCall.name)) {
      log.info(
        {
          event: "agent_tool_requires_confirmation",
          agentName,
          toolName: toolCall.name,
        },
        "Tool requires confirmation",
      );
      return { messages: [response] };
    }

    const toolResult = await toolNode.invoke({ messages: [...messages, response] });
    const toolMessages = toolResult.messages;

    log.info(
      {
        event: "agent_tool_executed",
        agentName,
        toolName: toolCall.name,
        toolMessageCount: toolMessages.length,
      },
      "Tool executed successfully",
    );

    if (toolMessages.length === 0) {
      log.error(
        {
          event: "agent_tool_empty_result",
          agentName,
          toolName: toolCall.name,
        },
        "Tool execution returned no tool messages",
      );

      return {
        messages: [
          new AIMessage(
            "Maaf, saya gagal memproses hasil dari tool. Coba lagi ya.",
          ),
        ],
      };
    }

    const finalResponse = (await chain.invoke({
      messages: [...messages, response, ...toolMessages],
      summary: summary ? `Konteks percakapan: ${summary}` : "",
    })) as AIMessage;

    log.info(
      {
        event: "agent_invoke_success",
        agentName,
      },
      "Agent completed successfully",
    );

    return { messages: [response, ...toolMessages, finalResponse] };
  };
}
