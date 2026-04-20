import { ChatGroq } from "@langchain/groq";

// Model standar untuk teks (Reasoning)
export const llm = new ChatGroq({
  model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  temperature: 0.7,
});

// Model khusus supervisor/router
export const supervisorLLM = new ChatGroq({
  model: process.env.GROQ_SUPERVISOR_MODEL || "openai/gpt-oss-120b",
  temperature: 0.7,
});

// Model khusus Vision (untuk membaca struk/gambar)
export const visionLLM = new ChatGroq({
  model: "meta-llama/llama-4-scout-17b-16e-instruct",
  temperature: 0.1, // Suhu rendah agar ekstraksi data lebih presisi
});
