import { describe, expect, it } from "vitest";
import { shouldAutoReply } from "./reply-policy";

const target = {
  chatType: "direct",
  conversationId: "cid-linyutao",
  senderOpenDingTalkId: "open-linyutao",
};

describe("shouldAutoReply", () => {
  it("requires the master switch", () => {
    expect(shouldAutoReply(target, { enabled: false, allowlist: ["all"] })).toBe(false);
  });

  it("only replies to direct conversations", () => {
    expect(
      shouldAutoReply(
        { ...target, chatType: "group" },
        { enabled: true, allowlist: ["open-linyutao"] },
      ),
    ).toBe(false);
  });

  it("requires an explicit allowlist", () => {
    expect(shouldAutoReply(target, { enabled: true, allowlist: [] })).toBe(false);
  });

  it("matches by sender openDingTalkId or conversationId", () => {
    expect(shouldAutoReply(target, { enabled: true, allowlist: ["open-linyutao"] })).toBe(true);
    expect(shouldAutoReply(target, { enabled: true, allowlist: ["cid-linyutao"] })).toBe(true);
    expect(shouldAutoReply(target, { enabled: true, allowlist: ["someone-else"] })).toBe(false);
  });

  it("supports an explicit all allowlist", () => {
    expect(shouldAutoReply(target, { enabled: true, allowlist: ["all"] })).toBe(true);
  });
});
