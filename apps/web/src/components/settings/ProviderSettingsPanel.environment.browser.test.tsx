import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { AsyncResult, type Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  providers: null as unknown as Atom.Writable<ReadonlyArray<ServerProvider>>,
  settings: null as unknown as UnifiedSettings,
  canManageProviders: true,
  canWriteSettings: true,
  searchTargetId: null as string | null,
  readEnvironmentIds: [] as string[],
  updateEnvironmentIds: [] as string[],
  mutationEnvironmentIds: [] as string[],
  refresh: vi.fn(),
  updateProvider: vi.fn(),
  uninstall: vi.fn(),
  acceptUrlAuth: vi.fn(),
  updateSettings: vi.fn(),
  updateModelPreferences: vi.fn(),
  toggleFavorite: vi.fn(),
  mutateProviderInstance: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const providers = Atom.make<ReadonlyArray<ServerProvider>>([]).pipe(Atom.keepAlive);
  state.providers = providers;
  const config = Atom.make(null);
  const commandLabels = {
    refreshProviders: "refresh",
    updateProvider: "update",
    uninstallAcpRegistryManagedBinary: "uninstall",
    acceptAcpRegistryUrlAuth: "accept-url-auth",
  } as const;
  const labelled = Object.fromEntries(
    Object.entries(commandLabels).map(([key, label]) => [
      key,
      { ...actual.serverEnvironment[key as keyof typeof commandLabels], label },
    ]),
  );
  return {
    ...actual,
    providersIgnoringCheckedAtAtom: (() => providers) as never,
    serverEnvironment: {
      ...actual.serverEnvironment,
      ...labelled,
      configValueAtom: (() => config) as never,
      providersValueAtom: (() => providers) as never,
    } as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) =>
    ({
      refresh: state.refresh,
      update: state.updateProvider,
      uninstall: state.uninstall,
      "accept-url-auth": state.acceptUrlAuth,
    })[command.label ?? ""] ?? vi.fn()) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((environmentId: string) => {
    state.readEnvironmentIds.push(environmentId);
    return state.settings;
  }) as never,
  useUpdateEnvironmentSettings: ((environmentId: string) => {
    state.updateEnvironmentIds.push(environmentId);
    return state.updateSettings;
  }) as never,
  useUpdateEnvironmentModelPreferences: (() => state.updateModelPreferences) as never,
  useToggleEnvironmentModelFavorite: (() => state.toggleFavorite) as never,
  usePersistEnvironmentProviderInstanceMutation: ((environmentId: string) => {
    state.mutationEnvironmentIds.push(environmentId);
    return state.mutateProviderInstance;
  }) as never,
}));
vi.mock(import("../../state/session"), async (original) => {
  const scope = (environmentId: string, requested: string) =>
    environmentId === "remote-device" &&
    (requested === "providers:manage"
      ? state.canManageProviders
      : requested === "settings:write"
        ? state.canWriteSettings
        : requested === "orchestration:read");
  return {
    ...(await original()),
    useEnvironmentScope: scope as never,
    readEnvironmentScope: scope as never,
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => []) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  useSettingsSearchTargetId: () => state.searchTargetId,
  SettingsRow: (({
    id,
    title,
    description,
    status,
    control,
    children,
  }: {
    id?: string;
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div id={id}>
      <h4>{title}</h4>
      {description}
      {status}
      {control}
      {children}
    </div>
  )) as never,
}));
vi.mock(import("./UsageProviderSettings"), async (original) => ({
  ...(await original()),
  UsageProviderSettings: (() => null) as never,
}));
vi.mock(import("../ProviderUpdatesAction"), async (original) => ({
  ...(await original()),
  ProviderUpdatesAction: (() => null) as never,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";

const environmentId = EnvironmentId.make("remote-device");
const codexId = ProviderInstanceId.make("codex");
const customId = ProviderInstanceId.make("codex_work");

function provider(): ServerProvider {
  return {
    instanceId: codexId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-24T12:00:00.000Z",
    models: [{ slug: "chosen", name: "Chosen", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "pnpm add -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-07-24T12:00:00.000Z",
      message: "Update available.",
    },
  };
}

const setProviders = (providers: ReadonlyArray<ServerProvider>) =>
  act(async () => appAtomRegistry.set(state.providers, providers));

function panel(options?: {
  readonly readOnly?: boolean;
  readonly targetInstanceId?: ProviderInstanceId;
}) {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <div className="@container/providers">
        <EnvironmentProviderSettings
          environmentId={environmentId}
          environmentLabel="Remote device"
          {...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly })}
          {...(options?.targetInstanceId === undefined
            ? {}
            : { targetInstanceId: options.targetInstanceId })}
        />
      </div>
    </RegistryContext.Provider>
  );
}

// The section header and the end of the provider list both offer Add provider.

async function setup() {
  await page.viewport(1280, 900);
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  state.canManageProviders = true;
  state.canWriteSettings = true;
  state.searchTargetId = null;
  state.readEnvironmentIds = [];
  state.updateEnvironmentIds = [];
  state.mutationEnvironmentIds = [];
  state.updateSettings.mockReset();
  state.updateModelPreferences.mockReset();
  state.toggleFavorite.mockReset();
  state.mutateProviderInstance.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.refresh.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateProvider.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.uninstall.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.acceptUrlAuth.mockReset().mockResolvedValue(AsyncResult.success({ accepted: true }));
  await setProviders([]);
}

describe("EnvironmentProviderSettings routing", () => {
  it("does not add an unauthenticated implicit Claude slot but retains an explicit choice", async () => {
    await setup();
    const claudeId = ProviderInstanceId.make("claudeAgent");
    await setProviders([
      {
        ...provider(),
        instanceId: claudeId,
        driver: ProviderDriverKind.make("claudeAgent"),
        auth: { status: "unauthenticated" },
        status: "error",
      },
    ]);
    await using screen = await render(panel());
    await expect
      .element(screen.getByRole("button", { name: "Select Claude", exact: true }))
      .not.toBeInTheDocument();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [claudeId]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: true },
      },
    };
    await screen.rerender(panel());
    await expect
      .element(screen.getByRole("button", { name: "Select Claude", exact: true }))
      .toBeVisible();
  });

  it("offers duplicate through the row context menu without copying redacted settings in the client", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Work",
          environment: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }],
        },
      },
    };
    await using screen = await render(panel());
    const row = screen.getByRole("button", { name: "Select Work", exact: true }).element();
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 60,
      clientY: 80,
    });
    await act(() => row.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    await userEvent.click(screen.getByRole("menuitem", { name: "Duplicate", exact: true }));
    expect(state.mutateProviderInstance).toHaveBeenCalledWith({
      operation: "duplicate",
      sourceInstanceId: customId,
      instanceId: "codex_work_copy",
      displayName: "Work copy",
    });
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("removes a default provider through its actions and selects the remaining provider", async () => {
    await setup();
    const openCodeId = ProviderInstanceId.make("opencode");
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [openCodeId]: { driver: ProviderDriverKind.make("opencode"), enabled: true },
      },
    };
    await setProviders([
      provider(),
      { ...provider(), instanceId: openCodeId, driver: ProviderDriverKind.make("opencode") },
    ]);
    state.mutateProviderInstance.mockImplementation(async (mutation) => {
      state.settings = {
        ...state.settings,
        providerInstances: {
          ...state.settings.providerInstances,
          [mutation.instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            removed: true,
          },
        },
      };
      return AsyncResult.success({});
    });
    await using screen = await render(panel());
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Codex", exact: true }).first(),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove", exact: true }));
    expect(state.mutateProviderInstance).toHaveBeenCalledWith({
      operation: "remove",
      instanceId: codexId,
    });
    await expect
      .element(screen.getByRole("button", { name: "Select Codex", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Select OpenCode", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    expect(state.uninstall).not.toHaveBeenCalled();
  });

  it("offers a discovered saved OpenCode account without enabling it until requested", async () => {
    await setup();
    const instanceId = ProviderInstanceId.make("opencode");
    const opencode: ServerProvider = {
      ...provider(),
      instanceId,
      driver: ProviderDriverKind.make("opencode"),
      enabled: false,
      status: "disabled",
      version: "2.1.3",
      auth: { status: "authenticated", type: "oauth", label: "OpenAI" },
      models: [],
    };
    await setProviders([provider(), opencode]);
    await using _screen = await render(panel());
    const enable = page.getByRole("switch", { name: "Enable OpenCode" }).first();
    await expect.element(enable).toBeVisible();
    await expect.element(enable).not.toBeChecked();
    expect(state.mutateProviderInstance).not.toHaveBeenCalled();
    await userEvent.click(enable);
    expect(state.mutateProviderInstance).toHaveBeenCalledWith(
      { operation: "upsert", instanceId, instance: { driver: "opencode", enabled: true } },
      {},
    );
  });

  it("does not substitute another account when the requested instance was removed", async () => {
    await setup();
    await setProviders([provider()]);
    await using _screen = await render(panel({ targetInstanceId: customId }));
    await expect
      .element(page.getByText("This provider instance is no longer available on this device."))
      .toBeVisible();
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("updates one provider instance without sending a stale whole map", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Work",
        },
      },
    };
    await using _screen = await render(panel());
    await userEvent.click(page.getByRole("switch", { name: "Enable Work" }).first());

    expect(state.mutateProviderInstance).toHaveBeenCalledWith(
      {
        operation: "upsert",
        instanceId: customId,
        instance: { driver: ProviderDriverKind.make("codex"), enabled: false, displayName: "Work" },
      },
      {},
    );
  });

  it("routes explicit ACP browser authentication consent to the selected environment", async () => {
    await setup();
    const instanceId = ProviderInstanceId.make("acpRegistry_antigravity");
    const action = {
      elicitationId: "google-login-1",
      url: "https://accounts.google.com/login",
      message: "Continue with Google",
    };
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: { agentId: "antigravity" },
        },
      },
    };
    await setProviders([
      {
        ...provider(),
        instanceId,
        driver: ProviderDriverKind.make("acpRegistry"),
        auth: { status: "unauthenticated", action },
      },
    ]);
    await using _screen = await render(panel({ targetInstanceId: instanceId }));
    const link = page.getByRole("link", { name: "Continue authentication" });
    link.element().addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(link);

    expect(state.acceptUrlAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, elicitationId: action.elicitationId },
    });
  });
});
