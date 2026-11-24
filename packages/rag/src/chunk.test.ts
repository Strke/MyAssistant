import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk";

describe("chunkText", () => {
  it("returns no chunks for blank text", () => {
    expect(chunkText("   \n ")).toEqual([]);
  });

  it("keeps short text as a single chunk", () => {
    expect(chunkText("hello world")).toEqual(["hello world"]);
  });

  it("splits long text into bounded overlapping chunks", () => {
    const text = "句子一。".repeat(200);
    const chunks = chunkText(text, { maxChars: 50, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
    expect(chunks.join("")).toContain("句子一");
  });
});
