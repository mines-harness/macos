import { describe, expect, it } from "@effect/vitest";
import {
  BODY_WINDOW_BYTES,
  bodyWindow,
  boundMessageBody,
  earlierBodyWindow,
} from "./threadBodyRanges.ts";

describe("message body ranges", () => {
  it("returns the latest bytes without modifying authoritative text", () => {
    const original = { text: "earlier\n" + "x".repeat(BODY_WINDOW_BYTES) };
    const bounded = boundMessageBody(original);
    expect(bounded.text).toBe("x".repeat(BODY_WINDOW_BYTES));
    expect(original.text.startsWith("earlier\n")).toBe(true);
    expect(boundMessageBody(bounded)).toBe(bounded);
  });

  it("reconstructs large multilingual messages without splitting characters", () => {
    const text = "é🖤文字\n".repeat(12_000);
    let window = bodyWindow(text, "text");
    let restored = window.text;
    while (window.range.startByte > 0) {
      expect(Buffer.byteLength(window.text)).toBeLessThanOrEqual(BODY_WINDOW_BYTES);
      window = earlierBodyWindow(text, "text", window.range.startByte, window.range.revision)!;
      restored = window.text + restored;
    }
    expect(restored).toBe(text);
    expect(restored).not.toContain("�");
  });

  it("rejects stale revisions, oversized offsets and split characters", () => {
    const text = "😀".repeat(20_000);
    const current = bodyWindow(text, "text");
    expect(
      earlierBodyWindow(text + "new", "text", current.range.startByte, current.range.revision),
    ).toBeNull();
    expect(
      earlierBodyWindow(text, "text", current.range.totalBytes + 1, current.range.revision),
    ).toBeNull();
    expect(earlierBodyWindow(text, "text", 5, current.range.revision)).toBeNull();
  });
});
