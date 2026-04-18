import { SystemMessage } from "@langchain/core/messages";
import { GraphStateType, VisionResult } from "../state.js";
import { visionLLM } from "../../llm/index.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("node-vision");

const UNKNOWN_VISION_RESULT: VisionResult = {
  kind: "unknown",
  confidence: 0,
  summary: "",
};

const clampConfidence = (value: unknown): number => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
};

const extractJsonObject = (value: string): string | null => {
  const match = value.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
};

const parseVisionResult = (raw: string): VisionResult => {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    return {
      ...UNKNOWN_VISION_RESULT,
      summary: raw.trim(),
    };
  }

  try {
    const parsed = JSON.parse(jsonText) as Partial<VisionResult>;
    const kind =
      parsed.kind === "payment_proof" ||
      parsed.kind === "non_payment" ||
      parsed.kind === "unknown"
        ? parsed.kind
        : "unknown";

    return {
      kind,
      confidence: clampConfidence(parsed.confidence),
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      amount: typeof parsed.amount === "number" ? parsed.amount : undefined,
      bank: typeof parsed.bank === "string" ? parsed.bank.trim() : undefined,
      transferDate:
        typeof parsed.transferDate === "string"
          ? parsed.transferDate.trim()
          : undefined,
      recipient:
        typeof parsed.recipient === "string" ? parsed.recipient.trim() : undefined,
    };
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to parse structured vision result",
    );
    return {
      ...UNKNOWN_VISION_RESULT,
      summary: raw.trim(),
    };
  }
};

/**
 * Node untuk memproses gambar di awal flow menggunakan model Vision.
 * Hasil analisis disimpan di state agar bisa dipakai node berikutnya.
 */
export const visionProcessorNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const { messages } = state;
  const lastMessage = messages[messages.length - 1];

  const hasImage =
    Array.isArray(lastMessage.content) &&
    lastMessage.content.some((contentPart: any) => contentPart.type === "image_url");

  if (!hasImage) {
    return { visionAnalysis: "", visionResult: null };
  }

  log.info("Vision model is analyzing the image...");

  try {
    const visionResponse = await visionLLM.invoke([
      new SystemMessage(
        `Kamu adalah ahli OCR dan klasifikasi gambar untuk bot pembayaran kos.
Balas HANYA JSON valid dengan format:
{
  "kind": "payment_proof" | "non_payment" | "unknown",
  "confidence": 0.0-1.0,
  "summary": "ringkasan singkat dalam bahasa Indonesia",
  "amount": number | null,
  "bank": string | null,
  "transferDate": "YYYY-MM-DD" | null,
  "recipient": string | null
}

Aturan:
- kind=payment_proof jika gambar terlihat seperti struk, bukti transfer, atau screenshot transaksi bank/e-wallet.
- kind=non_payment jika jelas bukan bukti pembayaran.
- kind=unknown jika tidak cukup yakin.
- summary harus singkat, spesifik, dan fokus pada isi visual utama yang benar-benar terlihat.
- Jika kind=payment_proof, summary ringkas isi bukti pembayaran yang penting.
- Jika kind=non_payment, JANGAN tulis kalimat generik seperti "Gambar bukan bukti pembayaran".
  Sebaliknya, jelaskan subjek utama gambar secara konkret, misalnya orang/hewan/objek/tempat/aktivitas yang terlihat.
- Jika user menyertakan teks/caption pada pesan yang sama, gunakan itu hanya sebagai konteks tambahan. Tetap utamakan apa yang benar-benar terlihat di gambar.
- Jika gambar tidak jelas, jelaskan keterbatasannya secara singkat di summary, jangan mengarang detail.`,
      ),
      lastMessage,
    ]);

    const rawContent = String(visionResponse.content).trim();
    const visionResult = parseVisionResult(rawContent);
    const summary = visionResult.summary || rawContent;

    log.info(
      {
        kind: visionResult.kind,
        confidence: visionResult.confidence,
        descriptionSnippet: summary.slice(0, 50),
      },
      "Vision analysis complete",
    );

    return {
      visionAnalysis: summary,
      visionResult,
    };
  } catch (err) {
    log.error({ err }, "Vision analysis failed");
    return {
      visionAnalysis: "",
      visionResult: null,
    };
  }
};
