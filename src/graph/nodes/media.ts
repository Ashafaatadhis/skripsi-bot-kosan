import { ToolMessage } from "@langchain/core/messages";
import { GraphStateType } from "../state.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("node-media");

/**
 * Node untuk mengekstrak URL gambar dari hasil pemanggilan tool.
 */
export const mediaExtractorNode = async (
  state: GraphStateType,
): Promise<Partial<GraphStateType>> => {
  const { messages } = state;
  const urls: string[] = [];

  // Fungsi rekursif buat cari semua 'imageUrls'
  const findImageUrls = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return;

    // Cek apakah di level ini ada IMAGE_URLS
    const currentObj = obj as Record<string, unknown>;
    let foundAtThisLevel = false;

    for (const [key, value] of Object.entries(currentObj)) {
      if (key === "imageUrls" && Array.isArray(value)) {
        value.forEach((url) => {
          if (typeof url === "string" && !urls.includes(url)) {
            urls.push(url);
            foundAtThisLevel = true;
          }
        });
      }
    }

    // Jika sudah nemu gambar di level ini, JANGAN masuk lebih dalam (deep search)
    // Ini mencegah foto gedung kosan kecampur sama foto kamar-kamar di dalamnya.
    if (foundAtThisLevel) return;

    // Jika belum nemu, baru cari ke properti lain secara rekursif
    for (const value of Object.values(currentObj)) {
      if (Array.isArray(value)) {
        value.forEach((item) => findImageUrls(item));
      } else if (typeof value === "object") {
        findImageUrls(value);
      }
    }
  };

  // Kita cari di pesan-pesan terbaru (dari turn ini saja)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    
    // Jika ketemu pesan dari User, berarti kita sudah melewati turn saat ini
    if (msg.getType() === "human") break;

    if (msg instanceof ToolMessage && typeof msg.content === "string") {
      try {
        const jsonStr = msg.content.replace(/^(Result|Output):\s*/i, "");
        const content = JSON.parse(jsonStr) as unknown;
        
        findImageUrls(content);

        // Jika sudah nemu gambar di tool ini, berhenti!
        if (urls.length > 0) break;
      } catch (e) {
        log.warn({ 
          error: e instanceof Error ? e.message : String(e),
          contentSnippet: msg.content.slice(0, 100) 
        }, "Failed to parse tool content as JSON for media extraction");
      }
    }
  }

  // Kita timpa (overwrite) imageUrls biar gak numpuk sama history lama
  return { imageUrls: urls.slice(0, 10) };
};
