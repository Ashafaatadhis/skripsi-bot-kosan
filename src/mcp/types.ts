/**
 * Interface standar untuk konten hasil dari Tool MCP
 */
export interface McpToolContent {
  type: string;
  text: string;
  [key: string]: unknown;
}

/**
 * Interface standar untuk respon JSON-RPC dari server MCP
 */
export interface JsonRpcResponse {
  result?: {
    content: McpToolContent[];
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Interface untuk registrasi user
 */
export interface RegisterResponse {
  id: string;
  telegramId: string;
  name: string;
}
