import {
  AuthProvidersManageScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  providers: null as Atom.Atom<readonly ServerProvider[]> | null,
  config: null as Atom.Atom<Pick<ServerConfig, "settings"> | null> | null,
  canManage: true,
  refresh: vi.fn(),
  persist: vi.fn(),
}));

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  usePersistEnvironmentProviderInstanceMutation: (() => state.persist) as never,
}));

vi.mock(import("../../state/environments"), async (original) => {
  const environment = {
    environmentId: EnvironmentId.make("onboarding-host"),
    label: "This computer",
    entry: { enabled: true },
    connection: { phase: "connected" },
  };
  return {
    ...(await original()),
    usePrimaryEnvironment: (() => environment) as never,
    useEnvironments: (() => ({ environments: [environment] })) as never,
  };
});
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: (() => state.providers) as never,
      configValueAtom: (() => state.config) as never,
      refreshProviders: "refresh" as never,
    },
  };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (_: unknown, scope: string) =>
    scope === AuthProvidersManageScope && state.canManage,
  readEnvironmentScope: (_: unknown, scope: string) =>
    scope === AuthProvidersManageScope && state.canManage,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.refresh) as never,
}));
vi.mock(import("../../onboarding/useProjectScans"), async (original) => ({
  ...(await original()),
  useProjectScans: () => [],
}));
vi.mock(import("../settings/ChatGptWelcomeCoordinator"), async (original) => ({
  ...(await original()),
  ChatGptWelcomeCoordinator: () => <></>,
}));

import { WelcomeWizard } from "./WelcomeWizard";

function setup() {
  window.localStorage.removeItem("mines:onboarding:v1");
  state.providers = Atom.make<readonly ServerProvider[]>([]);
  state.config = Atom.make(null);
  state.canManage = true;
  state.refresh.mockReset().mockResolvedValue({ _tag: "Success", value: [] });
  state.persist.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
}

function provider(instanceId: string, driver: string, enabled = false): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled,
    installed: true,
    version: "2.1.3",
    status: enabled ? "ready" : "disabled",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-26T00:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

it("uses every detected account even when another provider is filtered out", async () => {
  setup();
  state.providers = Atom.make([
    provider("opencode", "opencode"),
    provider("opencode_work", "opencode"),
    provider("cursor", "cursor"),
    { ...provider("grok", "grok"), auth: { status: "unknown" as const } },
  ]);
  await using screen = await render(wizard());
  await userEvent.fill(page.getByRole("searchbox", { name: "Search providers" }), "OpenCode");
  state.config = Atom.make({
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        opencode: {
          driver: ProviderDriverKind.make("opencode"),
          enabled: false,
          displayName: "Personal",
          config: { enabled: false, binaryPath: "/native/opencode" },
        },
      },
    },
  });
  await screen.rerender(wizard());
  await vi.waitFor(() => expect(state.persist).toHaveBeenCalledTimes(3));
  expect(state.persist.mock.calls.map(([mutation]) => mutation.instanceId).toSorted()).toEqual([
    "cursor",
    "opencode",
    "opencode_work",
  ]);
  expect(state.persist).toHaveBeenCalledWith(
    expect.objectContaining({
      instanceId: "opencode",
      instance: expect.objectContaining({
        enabled: true,
        displayName: "Personal",
        config: { enabled: true, binaryPath: "/native/opencode" },
      }),
    }),
  );
  await screen.rerender(wizard());
  expect(state.persist).toHaveBeenCalledTimes(3);
});

it("respects removal when a stale snapshot still reports a saved account", async () => {
  setup();
  state.providers = Atom.make([provider("codex", "codex"), provider("opencode", "opencode")]);
  state.config = Atom.make({
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        codex: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          removed: true,
        },
      },
    },
  });
  await using _screen = await render(wizard());
  await vi.waitFor(() =>
    expect(state.persist).toHaveBeenCalledWith(expect.objectContaining({ instanceId: "opencode" })),
  );
  expect(state.persist.mock.calls.map(([mutation]) => mutation.instanceId)).toEqual(["opencode"]);
});

it("shows ready accounts without asking for setup again", async () => {
  setup();
  state.providers = Atom.make([provider("opencode", "opencode", true)]);
  await using _screen = await render(wizard());
  await userEvent.fill(page.getByRole("searchbox", { name: "Search providers" }), "OpenCode");
  await expect.element(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Set up OpenCode" }))
    .not.toBeInTheDocument();
});

const wizard = () => (
  <WelcomeWizard
    localAvailable
    resumeEnvironmentId={EnvironmentId.make("onboarding-host")}
    onDone={vi.fn()}
  />
);

it("keeps featured agents first and finds Gemini and OpenCode through provider search", async () => {
  setup();
  await using _screen = await render(wizard());
  const text = document.body.textContent ?? "";
  expect(text.indexOf("Codex")).toBeLessThan(text.indexOf("Claude Code"));
  expect(text.indexOf("Claude Code")).toBeLessThan(text.indexOf("Cursor"));

  await userEvent.fill(page.getByRole("searchbox", { name: "Search providers" }), "Gemini");
  await expect.element(page.getByRole("button", { name: "Set up Antigravity" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Set up Cursor" })).not.toBeInTheDocument();
  await expect.element(page.getByText("Codex", { exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "More providers" })).toBeVisible();

  await userEvent.fill(page.getByRole("searchbox", { name: "Search providers" }), "open code");
  await expect.element(page.getByRole("button", { name: "Set up OpenCode" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Set up Antigravity" }))
    .not.toBeInTheDocument();
});

it("allows discovery without granting provider setup", async () => {
  setup();
  state.canManage = false;
  await using _screen = await render(wizard());
  await userEvent.fill(page.getByRole("searchbox", { name: "Search providers" }), "google");
  await expect.element(page.getByRole("button", { name: "Set up Antigravity" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "More providers" })).toBeDisabled();
});
