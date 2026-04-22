import { GraphStateType } from "../state.js";
import { llm } from "../../llm/index.js";
import { buildRuntimeContext, profilePrompt } from "../../prompts/index.js";
import { getTimeContext } from "../../lib/time.js";
import { createLogger } from "../../lib/logger.js";
import { toTextOnlyMessages } from "../../lib/formatter.js";
import { getProfileTools } from "../tools.js";

const log = createLogger("profile-agent");

export const profileNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const { messages, summary, userId } = state;
  const time = getTimeContext();
  const textMessages = toTextOnlyMessages(messages);

  const tools = await getProfileTools();
  const runtimeContext = buildRuntimeContext([
    ["WAKTU", `${time.currentDate} ${time.currentTime} (${time.currentTimezone})`],
    ["USER_ID", userId],
    ["SUMMARY", summary ? `Konteks percakapan:\n${summary}` : ""],
  ]);

  log.info(
    { toolCount: tools.length, toolNames: tools.map((t) => t.name) },
    "Profile tools loaded",
  );

  if (tools.length === 0) {
    log.warn("No profile tools available, responding without tools");
    const prompt = await profilePrompt.invoke({
      runtimeContext,
      messages: textMessages,
    });
    const response = await llm.invoke(prompt);
    return { messages: [response] };
  }

  const llmWithTools = llm.bindTools(tools);
  const prompt = await profilePrompt.invoke({
    runtimeContext,
    messages: textMessages,
  });

  const response = await llmWithTools.invoke(prompt);

  log.info(
    {
      hasToolCalls: !!(response.tool_calls && response.tool_calls.length > 0),
      toolCalls: response.tool_calls?.map((t) => t.name),
    },
    "Profile agent responded",
  );

  return {
    messages: [response],
  };
};
