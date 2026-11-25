import { describe, expect, it } from "vitest";
import { isAcknowledgement, shouldAutoReply } from "./reply-policy";

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

describe("isAcknowledgement", () => {
  it("recognizes common acknowledgements and thanks", () => {
    for (const text of ["好的", "收到", "嗯嗯", "谢谢老板", "辛苦了", "OK", "好的，辛苦了"]) {
      expect(isAcknowledgement(text)).toBe(true);
    }
  });

  it("does not swallow new requests or corrections", () => {
    for (const text of [
      "好的，但是还有个问题",
      "谢谢，帮我再看下日志",
      "收到，明天处理",
      "嗯，那就这样",
    ]) {
      expect(isAcknowledgement(text)).toBe(false);
    }
  });
});
