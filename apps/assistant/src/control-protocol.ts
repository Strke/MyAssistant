export type ControlRequest =
  | { id: string; type: "ping" }
  | { id: string; type: "status" }
  | { id: string; type: "chat"; text: string; conversationId?: string }
  | { id: string; type: "task.list"; status?: string }
  | { id: string; type: "task.check"; taskId: string }
  | { id: string; type: "task.cancel"; taskId: string }
  | { id: string; type: "shutdown" };

export interface ControlResponse {
  id: string;
  type: "response";
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ControlEvent {
  id: string;
  type: "event";
  event: "delta" | "status";
  text: string;
}

export type ControlMessage = ControlResponse | ControlEvent;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function parseControlRequest(line: string): ControlRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("Request is not valid JSON.");
  }
  const record = asRecord(parsed);
  if (!record) {
    throw new Error("Request must be a JSON object.");
  }
  const id = typeof record.id === "string" && record.id.trim() ? record.id : undefined;
  if (!id) {
    throw new Error("Request is missing a string id.");
  }

  switch (record.type) {
    case "ping":
      return { id, type: "ping" };
    case "status":
      return { id, type: "status" };
    case "shutdown":
      return { id, type: "shutdown" };
    case "chat": {
      const text = typeof record.text === "string" ? record.text.trim() : "";
      if (!text) {
        throw new Error("Chat request is missing text.");
      }
      if (text.length > 20_000) {
        throw new Error("Chat request is too long (max 20000 characters).");
      }
      const conversationId =
        typeof record.conversationId === "string" && record.conversationId.trim()
          ? record.conversationId.trim()
          : undefined;
      return { id, type: "chat", text, conversationId };
    }
    case "task.list": {
      const status =
        typeof record.status === "string" && record.status.trim()
          ? record.status.trim()
          : undefined;
      return { id, type: "task.list", status };
    }
    case "task.check": {
      const taskId = typeof record.taskId === "string" ? record.taskId.trim() : "";
      if (!taskId) {
        throw new Error("task.check is missing taskId.");
      }
      return { id, type: "task.check", taskId };
    }
    case "task.cancel": {
      const taskId = typeof record.taskId === "string" ? record.taskId.trim() : "";
      if (!taskId) {
        throw new Error("task.cancel is missing taskId.");
      }
      return { id, type: "task.cancel", taskId };
    }
    default:
      throw new Error(`Unknown request type: ${String(record.type)}`);
  }
}

export function encodeControlMessage(message: ControlMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function response(id: string, data?: unknown): ControlResponse {
  return { id, type: "response", ok: true, data };
}

export function errorResponse(id: string, error: string): ControlResponse {
  return { id, type: "response", ok: false, error };
}

export function event(id: string, name: ControlEvent["event"], text: string): ControlEvent {
  return { id, type: "event", event: name, text };
}

export function isControlMessage(value: unknown): value is ControlMessage {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      (record.type === "response" || record.type === "event"),
  );
}
