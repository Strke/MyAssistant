import { describe, expect, it, vi } from "vitest";
import { DwsGatewayClient, DwsGatewayError } from "./client";

function fakeFetch(
  response: Response,
  calls: Array<{ url: string; init?: RequestInit }>,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return response;
  }) as typeof fetch;
}

describe("DwsGatewayClient", () => {
  it("sends the bearer token and message query body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = fakeFetch(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            messages: [],
            complete: true,
            hasMore: false,
            count: 0,
            skipped: 0,
            failedCount: 0,
            failures: [],
          },
        }),
        { status: 200 },
      ),
      calls,
    );
    const client = new DwsGatewayClient({
      baseUrl: "https://dws-b.example",
      token: "gateway-token",
      fetchImpl,
    });

    const page = await client.listMessages({
      groupId: "cid-1",
      start: "2026-01-01 00:00:00",
      pageAll: true,
      pageLimit: 50,
    });

    expect(page.complete).toBe(true);
    expect(calls[0]?.url).toBe("https://dws-b.example/v1/chat/messages");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer gateway-token");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      groupId: "cid-1",
      start: "2026-01-01 00:00:00",
      pageAll: true,
      pageLimit: 50,
    });
  });

  it("throws a typed error on gateway failure", async () => {
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({ success: false, error: "Unauthorized." }), { status: 401 }),
      [],
    );
    const client = new DwsGatewayClient({ baseUrl: "http://127.0.0.1:8787", fetchImpl });

    await expect(client.listMessages({ groupId: "cid" })).rejects.toBeInstanceOf(DwsGatewayError);
  });

  it("rejects invalid gateway URLs", () => {
    expect(() => new DwsGatewayClient({ baseUrl: "file:///tmp/dws" })).toThrow("http");
  });

  it("times out hung requests", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    ) as unknown as typeof fetch;
    const client = new DwsGatewayClient({
      baseUrl: "http://127.0.0.1:8787",
      timeoutMs: 20,
      fetchImpl,
    });

    await expect(client.listMessages({ groupId: "cid" })).rejects.toThrow("timed out");
  });
});
