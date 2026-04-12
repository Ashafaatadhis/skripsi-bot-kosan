/**
 * Telegram Formatter
 * Mengonversi Markdown standar dari LLM ke format HTML yang didukung Telegram.
 * Menggunakan HTML karena lebih stabil daripada MarkdownV2 yang sangat ketat soal escaping.
 */
export const formatTelegramMessage = (text: string): string => {
  if (!text) return "";

  return text
    // 1. Escape karakter & agar valid HTML
    .replace(/&/g, "&amp;")
    
    // 2. Konversi Bold: **text** atau __text__ -> <b>text</b>
    .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
    
    // 3. Konversi Italic: *text* atau _text_ -> <i>text</i>
    // Gunakan regex yang lebih hati-hati agar tidak memakan tag <b>
    .replace(/(^|[^\\])\*(?!\*)(.*?)\*/g, "$1<i>$2</i>")
    .replace(/(^|[^\\])_(?!_)(.*?)_/g, "$1<i>$2</i>")

    // 4. Konversi Monospace/Code: `text` -> <code>text</code>
    .replace(/`(.*?)`/g, "<code>$1</code>")
    
    // 5. Konversi Code Block: ```text``` -> <pre>text</pre>
    .replace(/```(?:[a-z]+)?\n?([\s\S]*?)```/g, "<pre>$1</pre>")

    // 6. Konversi Link: [text](url) -> <a href="url">text</a>
    .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>');
};
