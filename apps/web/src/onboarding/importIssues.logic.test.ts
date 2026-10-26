import { expect, it } from "vite-plus/test";
import { importIssueReports } from "./importIssues.logic";

it("keeps deduplicated failures and partial history without routine source coverage", () => {
  const partial = {
    source: "opencode",
    status: "partial",
    message: "Workspace /old is unavailable; retained history can still be imported.",
  };
  const unreadable = {
    source: "antigravity",
    status: "unsupported",
    message: "Could not read selected-export.json as a transcript export.",
  };
  const failed = { source: "codex", status: "failed", message: "Scan stopped." };
  expect(
    importIssueReports([
      { source: "codex", status: "available", message: "All retained history is scanned." },
      { source: "claudeAgent", status: "unavailable", message: "No history found." },
      { source: "antigravity", status: "unsupported", message: "Native formats are unsupported." },
      {
        source: "antigravity",
        status: "partial",
        message:
          "Antigravity transcript exports are supported. Native stores are not universally readable.",
      },
      partial,
      { ...partial, message: ` ${partial.message} ` },
      unreadable,
      { ...unreadable, status: "unavailable" },
      failed,
    ]),
  ).toEqual([partial, unreadable, failed]);
});
