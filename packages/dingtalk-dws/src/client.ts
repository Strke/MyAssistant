import type { DwsAuthStatus, DwsChat, DwsHealth, DwsMessagePage, ListMessagesInput } from "./types";

export interface DwsGatewayClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface GatewayResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export class DwsGatewayError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "DwsGatewayError";
    this.status = status;
    this.body = body;
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("DWS gateway URL must use http or https.");
  }
  return url.toString().replace(/\/$/, "");
}

export class DwsGatewayClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DwsGatewayClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<DwsHealth> {
    return this.get<DwsHealth>("/health", 10_000);
  }

  async authStatus(): Promise<DwsAuthStatus> {
    return this.get<DwsAuthStatus>("/v1/auth/status", 30_000);
  }

  async searchChats(query: string): Promise<DwsChat[]> {
    const data = await this.post<{ chats: DwsChat[] }>("/v1/chat/search", { query });
    return data.chats;
  }

  async listMessages(input: ListMessagesInput): Promise<DwsMessagePage> {
    return this.post<DwsMessagePage>("/v1/chat/messages", input);
  }

  private async get<T>(path: string, timeoutMs = this.timeoutMs): Promise<T> {
    return this.request<T>(path, { method: "GET" }, timeoutMs);
  }

  private async post<T>(path: string, body: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    return this.request<T>(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
  }

  private async request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: GatewayResponse<T> | undefined;
      try {
        payload = text ? (JSON.parse(text) as GatewayResponse<T>) : undefined;
      } catch {
        throw new DwsGatewayError("DWS gateway returned invalid JSON.", response.status, text);
      }
      if (!response.ok || !payload?.success) {
        throw new DwsGatewayError(
          payload?.error ?? `DWS gateway request failed with HTTP ${response.status}.`,
          response.status,
          text,
        );
      }
      return payload.data as T;
    } catch (error) {
      if (error instanceof DwsGatewayError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`DWS gateway request timed out after ${timeoutMs} ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createDwsGatewayClient(options: DwsGatewayClientOptions): DwsGatewayClient {
  return new DwsGatewayClient(options);
}
