import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommandResult,
  createGatewayServer,
  type DwsRunner,
  type GatewayConfig,
  loadGatewayConfig,
} from "./index";

const servers: Server[] = [];

const config: GatewayConfig = {
  host: "127.0.0.1",
  port: 0,
  token: "test-token",
  dwsBin: "dws",
  allowedGroups: new Set(["cid-good", "cid-partial", "cid-empty"]),
  sendGroups: new Set(["cid-good"]),
  replyGroups: new Set(["cid-good"]),
  replyDms: true,
  replyDmOpenDingTalkIds: new Set(["u1"]),
  requestTimeoutMs: 5_000,
  maxItems: 1_000,
  maxConcurrent: 2,
  logRequests: false,
};

function result(stdout: unknown, code = 0, stderr = ""): CommandResult {
  return {
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    stderr,
    code,
    timedOut: false,
  };
}

const runner: DwsRunner = async (args) => {
  if (args[0] === "auth") {
    return result({
      version_check: { current: "v1.0.69" },
      success: true,
      authenticated: true,
      message: "ok",
    });
  }
  if (args[1] === "+chat-search") {
    return result({
      chats: [{ openConversationId: "cid-good", name: "测试群", type: "group" }],
      count: 1,
    });
  }
  if (args[1] === "+send-to-group" || args[1] === "+messages-reply") {
    return result({ success: true, sent: true });
  }
  const groupIndex = args.indexOf("--group");
  const groupId = groupIndex >= 0 ? args[groupIndex + 1] : "";
  if (groupId === "cid-empty") {
    return result(
      {
        contractVersion: "im.message-list.v1",
        messages: [],
        complete: false,
        hasMore: false,
        stopReason: "pagination_error",
        failedCount: 1,
        failures: [{ stage: "pagination", error: "page failed" }],
      },
      1,
      JSON.stringify({ error: { message: "page failed" } }),
    );
  }
  if (groupId === "cid-partial") {
    return result(
      {
        messages: [
          {
            messageId: "msg-partial",
            conversationId: "cid-partial",
            sender: "Alice",
            senderId: "u1",
            text: "partial",
            createTime: "2026-01-01 00:00:00",
          },
        ],
        complete: false,
        hasMore: false,
        stopReason: "pagination_error",
        failedCount: 1,
        failures: [{ stage: "pagination", error: "page failed" }],
        pagesFetched: 1,
      },
      1,
      "partial failure",
    );
  }
  return result({
    messages: [
      {
        messageId: "msg-1",
        conversationId: "cid-good",
        sender: "Alice",
        senderId: "u1",
        senderType: "user",
        messageType: "text",
        text: "hello",
        createTime: "2026-01-01 00:00:00",
      },
      { messageId: "bad", text: "" },
    ],
    complete: true,
    hasMore: false,
    pagesFetched: 1,
    failedCount: 0,
    failures: [],
  });
};

async function start(
  run: DwsRunner = runner,
  overrides: Partial<GatewayConfig> = {},
): Promise<{ server: Server; baseUrl: string }> {
  const server = createGatewayServer({
    config: { ...config, ...overrides },
    runner: run,
    logger: () => undefined,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function headers(token = "test-token"): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("dws gateway", () => {
  it("reports health without authentication and auth status with it", async () => {
    const { baseUrl } = await start();

    const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
    expect(health).toMatchObject({
      success: true,
      data: { service: "dws-gateway", authenticated: true },
    });

    const unauthorized = await fetch(`${baseUrl}/v1/auth/status`);
    expect(unauthorized.status).toBe(401);

    const auth = (await fetch(`${baseUrl}/v1/auth/status`, {
      headers: headers(),
    }).then((response) => response.json())) as { data: { authenticated: boolean } };
    expect(auth.data.authenticated).toBe(true);
  });

  it("returns normalized messages and enforces the group allowlist", async () => {
    const { baseUrl } = await start();

    const response = await fetch(`${baseUrl}/v1/chat/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        groupId: "cid-good",
        start: "2026-01-01 00:00:00",
        end: "2026-01-02 00:00:00",
        pageAll: true,
        pageLimit: 50,
        maxItems: 100,
      }),
    });
    const payload = (await response.json()) as {
      data: {
        complete: boolean;
        hasMore: boolean;
        count: number;
        skipped: number;
        failedCount: number;
        messages: Array<Record<string, unknown>>;
      };
    };
    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({
      complete: true,
      hasMore: false,
      count: 1,
      skipped: 1,
      failedCount: 0,
    });
    expect(payload.data.messages[0]).toMatchObject({
      messageId: "msg-1",
      conversationId: "cid-good",
      text: "hello",
    });

    const denied = await fetch(`${baseUrl}/v1/chat/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ groupId: "cid-other" }),
    });
    expect(denied.status).toBe(403);
  });

  it("passes through partial DWS results without claiming completeness", async () => {
    const { baseUrl } = await start();

    const response = await fetch(`${baseUrl}/v1/chat/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ groupId: "cid-partial", pageAll: true }),
    });
    const payload = (await response.json()) as {
      data: {
        complete: boolean;
        stopReason: string;
        failures: unknown[];
        messages: unknown[];
      };
    };
    expect(response.status).toBe(200);
    expect(payload.data.complete).toBe(false);
    expect(payload.data.stopReason).toBe("pagination_error");
    expect(payload.data.failures).toHaveLength(1);
    expect(payload.data.messages).toHaveLength(1);
  });

  it("returns structured partial results with zero messages", async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/v1/chat/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ groupId: "cid-empty", pageAll: true }),
    });
    const payload = (await response.json()) as {
      data: { complete: boolean; count: number; failures: unknown[] };
    };
    expect(response.status).toBe(200);
    expect(payload.data.complete).toBe(false);
    expect(payload.data.count).toBe(0);
    expect(payload.data.failures).toHaveLength(1);
  });

  it("sends only to allowlisted blackboard groups", async () => {
    const { baseUrl } = await start();
    const sent = await fetch(`${baseUrl}/v1/chat/send`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ groupId: "cid-good", text: "blackboard" }),
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ success: true, data: { sent: true } });

    const denied = await fetch(`${baseUrl}/v1/chat/send`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ groupId: "cid-other", text: "blackboard" }),
    });
    expect(denied.status).toBe(403);
  });

  it("replies to allowlisted groups and direct messages", async () => {
    const { baseUrl } = await start();
    const groupReply = await fetch(`${baseUrl}/v1/chat/reply`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        conversationId: "cid-good",
        messageId: "msg-1",
        chatType: "group",
        text: "收到",
      }),
    });
    expect(groupReply.status).toBe(200);
    expect(await groupReply.json()).toMatchObject({ success: true, data: { sent: true } });

    const directReply = await fetch(`${baseUrl}/v1/chat/reply`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        conversationId: "cid-dm",
        messageId: "msg-2",
        chatType: "direct",
        senderOpenDingTalkId: "u1",
        text: "收到",
      }),
    });
    expect(directReply.status).toBe(200);
  });

  it("replies only to allowlisted direct senders when replyDms is off", async () => {
    const { baseUrl } = await start(runner, {
      replyDms: false,
      replyDmOpenDingTalkIds: new Set(["u-allowed"]),
    });

    const allowed = await fetch(`${baseUrl}/v1/chat/reply`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        conversationId: "cid-dm",
        messageId: "msg-allowed",
        chatType: "direct",
        senderOpenDingTalkId: "u-allowed",
        text: "收到",
      }),
    });
    expect(allowed.status).toBe(200);

    const denied = await fetch(`${baseUrl}/v1/chat/reply`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        conversationId: "cid-dm",
        messageId: "msg-denied",
        chatType: "direct",
        senderOpenDingTalkId: "u-other",
        text: "收到",
      }),
    });
    expect(denied.status).toBe(403);
  });

  it("parses the selective direct reply allowlist", () => {
    const parsed = loadGatewayConfig({
      DWS_GATEWAY_TOKEN: "test-token",
      DWS_REPLY_DM_OPEN_DINGTALK_IDS: "u1, u2",
    });
    expect(parsed.replyDmOpenDingTalkIds).toEqual(new Set(["u1", "u2"]));
  });

  it("searches conversations", async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/v1/chat/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ query: "测试" }),
    });
    const payload = (await response.json()) as {
      data: { chats: Array<Record<string, unknown>> };
    };
    expect(payload.data.chats[0]).toMatchObject({
      openConversationId: "cid-good",
      name: "测试群",
    });
  });
});
