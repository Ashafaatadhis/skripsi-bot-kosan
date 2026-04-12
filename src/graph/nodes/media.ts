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
  const extractedUrls: string[] = [];

  // Cari ToolMessage terbaru yang belum diproses dari turn ini
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    
    // Berhenti jika ketemu HumanMessage (akhir dari turn ini)
    if (msg.getType() === "human") break;

    if (msg instanceof ToolMessage && typeof msg.content === "string") {
      try {
        const jsonStr = msg.content.replace(/^(Result|Output):\s*/i, "");
        const content = JSON.parse(jsonStr);

        const extractAllFromItem = (item: any) => {
          if (!item || !item.imageUrls || !Array.isArray(item.imageUrls)) return;
          item.imageUrls.forEach((url: string) => {
            if (typeof url === "string" && !extractedUrls.includes(url)) {
              extractedUrls.push(url);
            }
          });
        };

        const extractMainFromItem = (item: any) => {
          if (item?.imageUrls?.[0]) {
            const url = item.imageUrls[0];
            if (!extractedUrls.includes(url)) {
              extractedUrls.push(url);
            }
          }
        };

        // --- PROSES KONTEN ---
        if (Array.isArray(content)) {
          // Kasus: Tool mengembalikan array [item, item, ...]
          if (content.length === 1) extractAllFromItem(content[0]);
          else content.forEach(extractMainFromItem);
        } else if (content && typeof content === "object") {
          // Kasus: Tool mengembalikan objek { ... }
          
          // CRITICAL FIX: 
          // Jika objek ini Punya Gambar Langsung (berarti ini Detail Kosan atau Detail Kamar)
          if (content.imageUrls && Array.isArray(content.imageUrls) && content.imageUrls.length > 0) {
            extractAllFromItem(content);
            // STOP! Jangan ambil gambar kamar di dalamnya kalau ini adalah Detail Kosan
          } 
          // Jika tidak punya gambar tapi punya list (berarti ini Wrapper Pencarian seperti { rooms: [...] })
          else {
            const wrappedList = content.rooms || content.kosan || content.houses || content.data;
            if (Array.isArray(wrappedList)) {
              if (wrappedList.length === 1) extractAllFromItem(wrappedList[0]);
              else wrappedList.forEach(extractMainFromItem);
            } else {
              // Fallback: Siapa tahu detail kamar tidak punya foto sama sekali, ambil punya bangunan kosannya
              if (content.kosan?.imageUrls) {
                extractAllFromItem(content.kosan);
              }
            }
          }
        }
      } catch (e) {
        log.warn({ content: msg.content.slice(0, 50) }, "Failed to parse tool content as JSON");
      }
    }
  }

  const currentImages = state.imageUrls || [];
  const combined = [...new Set([...currentImages, ...extractedUrls])].slice(0, 10);

  if (extractedUrls.length > 0) {
    log.info({ total: combined.length, added: extractedUrls.length }, "Media extraction successful");
    return { imageUrls: combined };
  }

  return {};
};
