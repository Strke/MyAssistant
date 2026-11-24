import type { AgentTask, TaskExecutor } from "../types";

export interface HttpTaskExecutorOptions {
  baseUrl: string;
  pollIntervalMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

interface RemoteTaskPayload {
  id?: string;
  status?: string;
  output?: string;
  error?: string;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("HTTP task backend requires an http(s) URL.");
  }
  return url.toString().replace(/\/$/, "");
}

function abortError(): Error {
  const error = new Error("Task aborted.");
  error.name = "AbortError";
  return error;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readPayload(response: Response): Promise<RemoteTaskPayload> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Remote task backend returned HTTP ${response.status}: ${text.slice(0, 500) || "(empty)"}`,
    );
  }
  if (!text.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("not an object");
    }
    return parsed as RemoteTaskPayload;
  } catch {
    throw new Error("Remote task backend returned invalid JSON.");
  }
}

/**
 * Minimal HTTP/A2A-style backend:
 * - POST <baseUrl> with the task description to create a task.
 * - GET  <baseUrl>/<remoteId> to poll it.
 * - DELETE <baseUrl>/<remoteId> is sent best-effort when the task is cancelled.
 *
 * The remote side may return a terminal result immediately or report
 * `pending` / `running` and be polled. This keeps the contract usable with a
 * plain webhook service while leaving room for a fuller A2A adapter later.
 */
export class HttpTaskExecutor implements TaskExecutor {
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpTaskExecutorOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 2_000);
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async run(task: AgentTask, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const created = await this.request(this.baseUrl, {
      method: "POST",
      signal,
      body: JSON.stringify({
        id: task.id,
        description: task.description,
        target: task.target,
        metadata: task.metadata,
      }),
    });

    if (created.status && TERMINAL.has(created.status)) {
      return this.finish(created);
    }

    const remoteId = created.id ?? task.id;
    const pollUrl = `${this.baseUrl}/${encodeURIComponent(remoteId)}`;
    const onAbort = () => {
      void this.fetchImpl(pollUrl, { method: "DELETE", headers: this.headers }).catch(
        () => undefined,
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      while (true) {
        await sleep(this.pollIntervalMs, signal);
        const payload = await this.request(pollUrl, { method: "GET", signal });
        if (payload.status && TERMINAL.has(payload.status)) {
          return this.finish(payload);
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async request(url: string, init: RequestInit): Promise<RemoteTaskPayload> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...this.headers,
      },
    });
    return readPayload(response);
  }

  private finish(payload: RemoteTaskPayload): string {
    if (payload.status === "failed") {
      throw new Error(
        payload.error ? `Remote task failed: ${payload.error}` : "Remote task failed.",
      );
    }
    if (payload.status === "cancelled") {
      throw new Error("Remote task was cancelled.");
    }
    return payload.output ?? "";
  }
}

export function createHttpTaskExecutor(options: HttpTaskExecutorOptions): HttpTaskExecutor {
  return new HttpTaskExecutor(options);
}
