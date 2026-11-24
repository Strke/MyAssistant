import { connect, type Socket } from "node:net";
import {
  type ControlEvent,
  type ControlMessage,
  type ControlRequest,
  isControlMessage,
} from "./control-protocol";

export interface ControlClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  onEvent?: (event: ControlEvent) => void;
  timer?: NodeJS.Timeout;
}

type RequestPayload =
  | { type: "ping" }
  | { type: "status" }
  | { type: "chat"; text: string; conversationId?: string }
  | { type: "task.list"; status?: string }
  | { type: "task.check"; taskId: string }
  | { type: "task.cancel"; taskId: string }
  | { type: "shutdown" };

export class ControlClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private socket: Socket | undefined;
  private buffer = "";
  private counter = 0;

  constructor(options: ControlClientOptions) {
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  connect(): Promise<void> {
    if (this.socket) {
      return Promise.resolve();
    }
    return new Promise((resolvePromise, reject) => {
      const socket = connect({ path: this.socketPath });
      this.socket = socket;
      socket.setEncoding("utf8");
      socket.setNoDelay(true);
      socket.once("connect", () => resolvePromise());
      socket.once("error", (error) => {
        this.socket = undefined;
        reject(
          new Error(
            `Cannot connect to assistant at ${this.socketPath}: ${error.message}. Is the daemon running?`,
          ),
        );
      });
      socket.on("data", (chunk: string) => this.handleData(chunk));
      socket.on("close", () => {
        this.socket = undefined;
        for (const pending of this.pending.values()) {
          pending.reject(new Error("The assistant closed the control connection."));
          this.clearTimer(pending);
        }
        this.pending.clear();
      });
    });
  }

  request<T = unknown>(
    payload: RequestPayload,
    onEvent?: (event: ControlEvent) => void,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    if (!this.socket) {
      return Promise.reject(new Error("Control client is not connected."));
    }
    this.counter += 1;
    const id = `req-${this.counter}`;
    return new Promise<T>((resolvePromise, reject) => {
      const pending: PendingRequest = {
        resolve: (data) => resolvePromise(data as T),
        reject,
        onEvent,
      };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Request timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.pending.set(id, pending);
      this.send({ id, ...payload } as ControlRequest);
    });
  }

  close(): void {
    this.socket?.end();
    this.socket = undefined;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Control client closed."));
      this.clearTimer(pending);
    }
    this.pending.clear();
  }

  private send(request: ControlRequest): void {
    this.socket?.write(`${JSON.stringify(request)}\n`);
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        this.handleMessage(line);
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleMessage(line: string): void {
    let parsed: ControlMessage;
    try {
      const value = JSON.parse(line) as unknown;
      if (!isControlMessage(value)) {
        return;
      }
      parsed = value;
    } catch {
      return;
    }

    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }
    if (parsed.type === "event") {
      pending.onEvent?.(parsed);
      return;
    }

    this.pending.delete(parsed.id);
    this.clearTimer(pending);
    if (parsed.ok) {
      pending.resolve(parsed.data);
    } else {
      pending.reject(new Error(parsed.error ?? "Unknown assistant error."));
    }
  }

  private clearTimer(pending: PendingRequest): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
  }
}
