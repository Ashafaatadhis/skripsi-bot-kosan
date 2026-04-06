import { ChatGroq } from "@langchain/groq";

export const llm = new ChatGroq({
  model: "openai/gpt-oss-20b",
  temperature: 0,
});
