import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";

/**
 * Telegram Formatter
 * Mengonversi Markdown standar dari LLM ke format HTML yang didukung Telegram.
 * Menggunakan HTML karena lebih stabil daripada MarkdownV2 yang sangat ketat soal escaping.
 */
export const formatTelegramMessage = (text: string): string => {
  if (!text) return "";

  const normalizedText = text
    .replaceAll("&nbsp;", " ")
    .replaceAll("&#160;", " ")
    .replaceAll("<br>", "\n")
    .replaceAll("<br/>", "\n")
    .replaceAll("<br />", "\n");

  return normalizedText
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

const toTextContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
};

const humanContentToText = (content: unknown): string => {
  const text = toTextContent(content).trim();
  if (text) {
    return text;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const hasImage = content.some(
    (part): part is { type: string } =>
      typeof part === "object" && part !== null && part.type === "image_url",
  );

  return hasImage ? "[User mengirim gambar]" : "";
};

export const toTextOnlyMessage = (message: BaseMessage): BaseMessage => {
  if (message instanceof HumanMessage) {
    return new HumanMessage(humanContentToText(message.content));
  }

  if (message instanceof AIMessage) {
    return new AIMessage({
      content: toTextContent(message.content),
      tool_calls: message.tool_calls,
      invalid_tool_calls: message.invalid_tool_calls,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
      id: message.id,
      name: message.name,
    });
  }

  if (message instanceof SystemMessage) {
    return new SystemMessage(toTextContent(message.content));
  }

  if (message instanceof ToolMessage) {
    return new ToolMessage({
      content: toTextContent(message.content),
      tool_call_id: message.tool_call_id,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
      id: message.id,
      name: message.name,
    });
  }

  return message;
};

export const toTextOnlyMessages = (messages: BaseMessage[]): BaseMessage[] =>
  messages.map(toTextOnlyMessage);
