interface SourceReport {
  readonly source: string;
  readonly status: string;
  readonly message: string;
}

export function importIssueReports<T extends SourceReport>(reports: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  return reports.filter((report) => {
    const coverageSummary =
      report.source === "antigravity" &&
      report.message.startsWith("Antigravity transcript exports are supported.");
    const readFailure =
      /\b(?:could not|failed(?: to)?|unreadable|invalid|permission denied|access denied|unable to)\b|\b(?:export|database|file)\b.*\bnot found\b/i.test(
        report.message,
      );
    if (
      coverageSummary ||
      (report.status !== "failed" && report.status !== "partial" && !readFailure)
    )
      return false;
    const key = `${report.source}:${report.message.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function importSourceLabel(source: string): string {
  switch (source) {
    case "codex":
      return "Codex";
    case "claudeAgent":
      return "Claude Code";
    case "opencode":
      return "OpenCode";
    case "antigravity":
      return "Antigravity";
    case "t3code":
      return "T3 Code";
    default:
      return source;
  }
}
