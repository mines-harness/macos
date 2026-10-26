import { describe, expect, it } from "vite-plus/test";

import { providerClients } from "../components/settings/providerDriverMeta";
import { searchOnboardingProviders } from "./providerSearch.logic";

const drivers = (query: string) =>
  searchOnboardingProviders(providerClients.definitions, query).map(
    (provider) => provider.driverKind,
  );

describe("onboarding provider search", () => {
  it("features Codex and Claude before every other supported integration", () => {
    const definitions = providerClients.definitions.toReversed();
    const result = searchOnboardingProviders(definitions, "");
    expect(result.slice(0, 2).map((provider) => provider.driverKind)).toEqual([
      "codex",
      "claudeAgent",
    ]);
    expect(new Set(result.map((provider) => provider.driverKind))).toEqual(
      new Set(providerClients.definitions.map((provider) => provider.driverKind)),
    );
  });

  it("finds the existing Codex integration by ChatGPT, OpenAI, and GPT", () => {
    for (const query of ["ChatGPT", " openai ", "GPT"]) expect(drivers(query)).toEqual(["codex"]);
  });

  it("routes Gemini subscription searches to Antigravity", () => {
    for (const query of ["Gemini", "Google", "Google AI Pro", "Google AI Ultra"])
      expect(drivers(query)).toEqual(["antigravity"]);
  });

  it("searches other supported integrations without inventing a provider", () => {
    expect(drivers("open code")).toEqual(["opencode"]);
    expect(drivers("cursor")).toEqual(["cursor"]);
    expect(drivers("unlisted-agent")).toEqual([]);
  });
});
