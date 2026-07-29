export type RpcRawEvent = Record<string, unknown> & { type: string };

export type ToolCall = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  phase: "start" | "delta" | "end";
};

export type ChatImage = { type: "image"; data: string; mimeType: string };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  images?: ChatImage[];
  thinking?: string;
  toolCalls: ToolCall[];
  createdAt?: number;
  // streaming flags
  isStreaming?: boolean;
};

export type ApprovalRequest = {
  id: string;
  session_id: string;
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  raw: string;
};

export function parseApprovalRequest(session_id: string, raw: string): ApprovalRequest | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (j.type !== "extension_ui_request") return null;
    const id = String(j.id ?? "");
    const method = j.method as ApprovalRequest["method"];
    if (!id || !method) return null;
    if (!["select", "confirm", "input", "editor"].includes(method)) return null;
    return {
      id,
      session_id,
      method,
      title: j.title as string | undefined,
      message: j.message as string | undefined,
      options: j.options as string[] | undefined,
      placeholder: j.placeholder as string | undefined,
      prefill: j.prefill as string | undefined,
      timeout: j.timeout as number | undefined,
      raw,
    };
  } catch {
    return null;
  }
}

export function isResponse(raw: string): boolean {
  try {
    const j = JSON.parse(raw) as { type?: string };
    return j.type === "response";
  } catch {
    return false;
  }
}
