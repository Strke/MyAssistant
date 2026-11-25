import { describe, expect, it } from "vitest";
import { parseDecision } from "./review";

const base = {
  related: true,
  alreadyDone: false,
  confidence: 0.9,
  reason: "需要回复",
  evidence: [],
  suggestedReply: "收到。",
  blackboardAction: "none",
  blackboardItem: null,
  completedTaskId: null,
};

describe("parseDecision", () => {
  it("parses a normal decision", () => {
    const decision = parseDecision(JSON.stringify({ ...base, coveredByPreviousReply: false }));
    expect(decision.related).toBe(true);
    expect(decision.coveredByPreviousReply).toBe(false);
    expect(decision.suggestedReply).toBe("收到。");
  });

  it("treats covered messages as already handled", () => {
    const decision = parseDecision(
      JSON.stringify({
        ...base,
        related: true,
        coveredByPreviousReply: true,
        blackboardAction: "add",
        blackboardItem: { title: "不应新增", details: "" },
      }),
    );
    expect(decision.coveredByPreviousReply).toBe(true);
    expect(decision.related).toBe(false);
    expect(decision.blackboardAction).toBe("none");
    expect(decision.blackboardItem).toBeUndefined();
    expect(decision.suggestedReply).toBeUndefined();
  });

  it("defaults coveredByPreviousReply to false", () => {
    const decision = parseDecision(JSON.stringify(base));
    expect(decision.coveredByPreviousReply).toBe(false);
  });
});
