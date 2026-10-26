import type { ProviderClientDefinition } from "@t3tools/provider-core/client";

const aliases: Readonly<Record<string, readonly string[]>> = {
  codex: ["ChatGPT", "OpenAI", "GPT"],
  claudeAgent: ["Anthropic", "Claude Code"],
  antigravity: ["Gemini", "Google", "Google AI Pro", "Google AI Ultra"],
  opencode: ["Open Code"],
};

export function searchOnboardingProviders<
  Definition extends Pick<ProviderClientDefinition, "driverKind" | "label">,
>(definitions: readonly Definition[], query: string): Definition[] {
  const words = query.trim().toLowerCase().split(/\s+/);
  const priority = (driver: string) => (driver === "codex" ? 0 : driver === "claudeAgent" ? 1 : 2);
  return definitions
    .filter((provider) => {
      const names = [provider.label, provider.driverKind, ...(aliases[provider.driverKind] ?? [])];
      return names.some((name) => words.every((word) => name.toLowerCase().includes(word)));
    })
    .toSorted((left, right) => priority(left.driverKind) - priority(right.driverKind));
}
