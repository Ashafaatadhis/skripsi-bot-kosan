import { OpenAIEmbeddings } from "@langchain/openai";

let embeddings: OpenAIEmbeddings | null = null;

export const getEmbeddings = () => {
  if (!embeddings) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn("OPENAI_API_KEY tidak ditemukan, semantic search mungkin gagal atau fallback ke mock.");
    }
    
    embeddings = new OpenAIEmbeddings({
      openAIApiKey: apiKey,
      modelName: "text-embedding-3-small", // Model hemat dan akurat
    });
  }
  return embeddings;
};

export const generateEmbedding = async (text: string): Promise<number[]> => {
  const model = getEmbeddings();
  return model.embedQuery(text);
};
