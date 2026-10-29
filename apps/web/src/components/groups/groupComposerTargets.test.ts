import { expect, it } from "vite-plus/test";
import { groupComposerReceiptKey, groupPlanModeBlockReason } from "./groupComposerTargets";

it("checks only explicitly addressed mines for Plan mode and checks everyone for unaddressed prompts", () => {
  const members = [
    { id: "planner", alias: "planner", supportsPlanMode: true },
    { id: "builder", alias: "builder", supportsPlanMode: false },
  ];
  expect(groupPlanModeBlockReason("@planner investigate", members)).toBeNull();
  expect(groupPlanModeBlockReason("Investigate", members)).toContain("@builder");
  expect(groupPlanModeBlockReason("@everyone investigate", members)).toContain("@builder");
  expect(groupPlanModeBlockReason("`@builder` @planner investigate", members)).toBeNull();
});

it("does not invent missing capabilities for existing groups and requires a mine", () => {
  expect(groupPlanModeBlockReason("Plan this", [{ id: "old", alias: "old" }])).toBeNull();
  expect(groupPlanModeBlockReason("Plan this", [])).toBe("Bring a mine to use Plan mode.");
});

it("binds retries to send intent without saving prompt or attachment contents in the receipt", () => {
  const content = JSON.stringify({
    prompt: "private draft",
    context: "data:image/png;base64,secret",
  });
  const note = groupComposerReceiptKey(content, "human-note", false);
  expect(note).toMatch(/^[a-f0-9]{64}$/);
  expect(groupComposerReceiptKey(content, "human-note", false)).toBe(note);
  expect(groupComposerReceiptKey(content, "ask-ai", false)).not.toBe(note);
  expect(groupComposerReceiptKey(content, "human-note", true)).not.toBe(note);
  expect(groupComposerReceiptKey(`${content}edited`, "human-note", false)).not.toBe(note);
});
