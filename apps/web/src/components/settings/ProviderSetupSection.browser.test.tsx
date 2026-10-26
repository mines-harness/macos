import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";

const setup = vi.hoisted(() => ({
  auth: null as ProviderAuthState | null,
  providersAtom: null as Atom.Atom<ReadonlyArray<ServerProvider>> | null,
  settings: null as { providerInstances: Record<string, ProviderInstanceConfig> } | null,
  mutate: vi.fn(),
  installation: null as ProviderInstallState | null,
  authState: vi.fn(() => "auth"),
  installState: vi.fn(() => "installation"),
  startAuth: vi.fn(),
  completeAuth: vi.fn(),
  respondAuth: vi.fn(),
  cancelAuth: vi.fn(),
  logoutAuth: vi.fn(),
  startInstall: vi.fn(),
  cancelInstall: vi.fn(),
  removeInstall: vi.fn(),
  confirm: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: (() => setup.providersAtom) as never,
      providerAuthState: setup.authState as never,
      providerInstallState: setup.installState as never,
      startProviderAuth: setup.startAuth as never,
      completeProviderAuth: setup.completeAuth as never,
      respondProviderAuth: setup.respondAuth as never,
      cancelProviderAuth: setup.cancelAuth as never,
      logoutProviderAuth: setup.logoutAuth as never,
      startProviderInstall: setup.startInstall as never,
      cancelProviderInstall: setup.cancelInstall as never,
      removeProviderInstallation: setup.removeInstall as never,
    },
  };
});
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => setup.settings) as never,
  usePersistEnvironmentProviderInstanceMutation: (() => setup.mutate) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
const queryListeners = vi.hoisted(() => new Set<() => void>());
vi.mock(import("../../state/query"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    queryListeners.add(listener);
    return () => queryListeners.delete(listener);
  };
  return {
    ...(await original()),
    useEnvironmentQuery: ((atom: string) => ({
      data: useSyncExternalStore(subscribe, () =>
        atom === "auth" ? setup.auth : setup.installation,
      ),
      error: null,
      isPending: false,
      refresh: vi.fn(),
    })) as never,
  };
});
const publish = () =>
  act(async () => {
    for (const listener of queryListeners) listener();
  });
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: () =>
    ({
      dialogs: { confirm: setup.confirm },
      shell: { openExternal: setup.openExternal },
    }) as never,
}));

import { ProviderSetupSection } from "./ProviderSetupSection";
import { ProviderWizardAuthenticationStep } from "./ProviderWizardAuthenticationStep";

const environmentId = EnvironmentId.make("remote-google");
const instanceId = ProviderInstanceId.make("antigravity_work");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("antigravity"),
  installed: true,
  enabled: true,
  version: "test-version",
  status: "error",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-09-02T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
  setup: { canAuthenticate: true, canInstall: true },
};

function authState(patch: Partial<ProviderAuthState> = {}): ProviderAuthState {
  return {
    instanceId,
    phase: "waiting",
    flowId: "flow-1",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test-only",
    expiresAt: "2026-09-02T00:05:00.000Z",
    message: null,
    ...patch,
  };
}

interface SectionOptions {
  readOnly?: boolean;
  provider?: ServerProvider;
  enabled?: boolean;
  binaryPath?: string;
}

function section(options: SectionOptions = {}) {
  return (
    <ProviderSetupSection
      environmentId={environmentId}
      environmentLabel="Remote Google device"
      instanceId={instanceId}
      provider={options.provider ?? provider}
      binaryPath={options.binaryPath}
      enabled={options.enabled ?? true}
      readOnly={options.readOnly ?? false}
      onEnable={vi.fn()}
    />
  );
}

async function renderSetup(options: SectionOptions = {}) {
  const screen = await render(section(options));
  const { container } = screen;
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (element) => element.textContent === label || element.getAttribute("aria-label") === label,
    ) ?? null;
  return Object.assign(screen, {
    button,
    async click(label: string) {
      const target = button(label);
      expect(target, `button ${label}`).not.toBeNull();
      expect(target!.disabled, `${label} disabled`).toBe(false);
      await act(async () => target!.click());
    },
    occurrences: (text: string) => (container.textContent ?? "").split(text).length - 1,
    callbackInput: () =>
      container.querySelector<HTMLInputElement>(`[id="provider-callback-${instanceId}"]`)!,
  });
}

function resetSetup() {
  vi.clearAllMocks();
  setup.auth = authState();
  setup.providersAtom = Atom.make([provider]);
  setup.settings = {
    providerInstances: { [instanceId]: { driver: provider.driver, enabled: true } },
  };
  setup.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  setup.installation = {
    driver: ProviderDriverKind.make("antigravity"),
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: null,
    version: null,
    installedVersion: null,
    canRemove: false,
    message: null,
  };
  for (const command of [
    setup.startAuth,
    setup.completeAuth,
    setup.respondAuth,
    setup.cancelAuth,
    setup.logoutAuth,
    setup.startInstall,
    setup.cancelInstall,
    setup.removeInstall,
  ]) {
    command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  }
  setup.confirm.mockReset().mockResolvedValue(false);
  setup.openExternal.mockReset().mockResolvedValue(undefined);
}

describe("Antigravity setup", () => {
  it("does not reopen an existing sign-in flow when the account view mounts", async () => {
    resetSetup();
    using _desktop = stubGlobal("desktopBridge", {});
    await using screen = await renderSetup();
    expect(setup.openExternal).not.toHaveBeenCalled();
    await screen.click("Open browser");
    expect(setup.openExternal).toHaveBeenCalledExactlyOnceWith(setup.auth?.authorizationUrl);
  });

  it("opens the browser once per requested sign-in and keeps the manual retry", async () => {
    resetSetup();
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    using _desktop = stubGlobal("desktopBridge", {});
    await using screen = await renderSetup();
    await screen.click("Sign in");
    expect(setup.startAuth).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId },
    });
    expect(setup.openExternal).not.toHaveBeenCalled();

    setup.auth = authState();
    await publish();
    expect(setup.openExternal).toHaveBeenCalledExactlyOnceWith(setup.auth.authorizationUrl);

    setup.auth = authState({ message: "Finish signing in." });
    await publish();
    await screen.rerender(section());
    expect(setup.openExternal).toHaveBeenCalledOnce();

    await screen.click("Open browser");
    expect(setup.openExternal).toHaveBeenCalledTimes(2);

    setup.auth = authState({ phase: "cancelled", authorizationUrl: null });
    await publish();
    await screen.click("Retry sign-in");
    setup.auth = authState({
      flowId: "flow-2",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=another-attempt",
    });
    await publish();
    expect(setup.openExternal).toHaveBeenCalledTimes(3);
    expect(setup.openExternal).toHaveBeenLastCalledWith(setup.auth.authorizationUrl);
  });

  it("opens a requested consent link only after the provider accepts consent", async () => {
    resetSetup();
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    let acceptConsent = () => {};
    const consent = new Promise<{ _tag: "Success"; value: undefined }>((resolve) => {
      acceptConsent = () => resolve({ _tag: "Success", value: undefined });
    });
    const url = "https://accounts.google.com/o/oauth2/v2/auth?state=consent";
    setup.respondAuth.mockReturnValueOnce(consent);
    using _desktop = stubGlobal("desktopBridge", {});
    await using screen = await renderSetup();
    await screen.click("Sign in");
    setup.auth = authState({
      interaction: {
        type: "browser",
        id: "browser-consent",
        url,
        requiresConsent: true,
      },
    });
    await publish();
    expect(setup.respondAuth).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        instanceId,
        flowId: "flow-1",
        interactionId: "browser-consent",
        response: { type: "browser", action: "accept" },
      },
    });
    expect(setup.openExternal).not.toHaveBeenCalled();

    await act(async () => acceptConsent());
    expect(setup.openExternal).toHaveBeenCalledExactlyOnceWith(url);
  });

  it("reuses the tab reserved by the sign-in click when the URL arrives", async () => {
    resetSetup();
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    await using screen = await renderSetup();
    const tab = { opener: window, location: { href: "about:blank" }, close: vi.fn() };
    using open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    await screen.click("Sign in");
    expect(open).toHaveBeenCalledExactlyOnceWith("", "_blank");
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe("about:blank");

    setup.auth = authState();
    await publish();
    expect(tab.location.href).toBe(setup.auth.authorizationUrl);
    expect(open).toHaveBeenCalledOnce();
    expect(setup.openExternal).not.toHaveBeenCalled();
    await screen.unmount();
    expect(tab.close).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled"] as const)(
    "closes the reserved tab when sign-in is %s before producing a URL",
    async (phase) => {
      resetSetup();
      setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
      await using screen = await renderSetup();
      const tab = { opener: window, location: { href: "about:blank" }, close: vi.fn() };
      using _open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
      await screen.click("Sign in");
      setup.auth = authState({ phase, authorizationUrl: null });
      await publish();
      expect(tab.close).toHaveBeenCalledOnce();

      setup.auth = authState();
      await publish();
      expect(tab.location.href).toBe("about:blank");
      expect(setup.openExternal).not.toHaveBeenCalled();
    },
  );

  it("closes the reserved tab when starting sign-in fails", async () => {
    resetSetup();
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.startAuth.mockRejectedValueOnce(new Error("Provider could not start."));
    await using screen = await renderSetup();
    const tab = { opener: window, location: { href: "about:blank" }, close: vi.fn() };
    using _open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    await screen.click("Sign in");
    expect(tab.close).toHaveBeenCalledOnce();
    await expect
      .element(screen.getByText("Provider sign-in failed. Try again.", { exact: true }))
      .toBeVisible();
  });

  it("closes the reserved tab when sign-in needs credentials or the view closes", async () => {
    resetSetup();
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    await using screen = await renderSetup();
    const tab = { opener: window, location: { href: "about:blank" }, close: vi.fn() };
    using _open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    await screen.click("Sign in");
    setup.auth = authState({
      authorizationUrl: null,
      interaction: { type: "credentials", id: "credentials", fields: [] },
    });
    await publish();
    expect(tab.close).toHaveBeenCalledOnce();

    setup.auth = authState({ phase: "cancelled", authorizationUrl: null });
    await publish();
    await screen.click("Retry sign-in");
    await screen.unmount();
    expect(tab.close).toHaveBeenCalledTimes(2);
  });

  it("keeps a manual browser retry when the browser blocks the reserved tab", async () => {
    resetSetup();
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    await using screen = await renderSetup();
    using _open = vi.spyOn(window, "open").mockReturnValue(null);
    await screen.click("Sign in");
    setup.auth = authState();
    await publish();
    await expect
      .element(
        screen.getByText(
          "Could not open the sign-in page. Copy the link and open it in your browser.",
          { exact: true },
        ),
      )
      .toBeVisible();
    await screen.click("Open browser");
    expect(setup.openExternal).toHaveBeenCalledExactlyOnceWith(setup.auth.authorizationUrl);
  });

  it("offers the existing Antigravity installation action after onboarding creates its profile", async () => {
    resetSetup();
    setup.auth = authState({ phase: "idle", authorizationUrl: null });
    setup.providersAtom = Atom.make([{ ...provider, installed: false }]);
    await using screen = await render(
      <ProviderWizardAuthenticationStep
        environmentId={environmentId}
        environmentLabel="Remote Google device"
        instanceId={instanceId}
        driverKind={provider.driver}
        onFinish={vi.fn()}
      />,
    );
    await screen.getByRole("button", { name: "Install Antigravity", exact: true }).click();
    expect(setup.startInstall).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
  });

  it("waits for verified auth after submitting a callback to the selected environment", async () => {
    resetSetup();
    const callbackUrl = "http://127.0.0.1:5555/?state=test-only&code=test-only";
    await using screen = await renderSetup();
    await userEvent.fill(screen.callbackInput(), callbackUrl);
    await screen.click("Continue");

    expect(setup.completeAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, flowId: "flow-1", callbackUrl },
    });
    expect(screen.occurrences("Signed in.")).toBe(0);
    expect(screen.callbackInput().value).toBe("");

    setup.auth = authState({ phase: "verifying", authorizationUrl: null });
    await publish();
    expect(screen.occurrences("Signed in.")).toBe(0);
    setup.auth = authState({ phase: "succeeded", authorizationUrl: null });
    await screen.rerender(
      section({
        provider: { ...provider, status: "ready", auth: { status: "authenticated" } },
      }),
    );
    expect(screen.occurrences("Signed in.")).toBe(1);
  });

  it("does not send a callback left over from a replaced sign-in flow", async () => {
    resetSetup();
    const interaction = {
      type: "browser" as const,
      id: "same-interaction",
      url: "https://example.com/login",
      requiresConsent: false,
      acceptsCallback: true,
    };
    setup.auth = authState({ interaction });
    await using screen = await renderSetup();
    await userEvent.fill(
      screen.callbackInput(),
      "http://127.0.0.1:5555/?state=old-flow&code=test-only",
    );
    setup.auth = authState({ flowId: "flow-2", interaction });
    await publish();
    expect(screen.callbackInput().value).toBe("");
    await act(async () => screen.callbackInput().form!.requestSubmit());

    expect(setup.completeAuth).not.toHaveBeenCalled();
    expect(setup.authState).toHaveBeenLastCalledWith({ environmentId, input: { instanceId } });
  });

  it("does not let a shared managed install hide an invalid custom binary path", async () => {
    resetSetup();
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      installedVersion: "test-version",
      canRemove: true,
    };
    await using screen = await renderSetup({
      provider: { ...provider, installed: false },
      binaryPath: "/missing/antigravity",
    });
    expect(screen.button("Sign in")?.disabled).toBe(true);
    expect(setup.startAuth).not.toHaveBeenCalled();
  });
});

it("prioritizes a detected account over an unavailable sign-in flow and keeps the signed-out fallback", async () => {
  resetSetup();
  const unavailable = "This provider does not support sign-in in mines.";
  const detected: ServerProvider = {
    ...provider,
    driver: ProviderDriverKind.make("opencode"),
    status: "ready",
    auth: { status: "authenticated" },
    setup: { canAuthenticate: false, canInstall: false },
  };
  setup.providersAtom = Atom.make([detected]);
  setup.settings = {
    providerInstances: { [instanceId]: { driver: detected.driver, enabled: true } },
  };
  setup.auth = authState({
    phase: "failed",
    flowId: null,
    authorizationUrl: null,
    methods: [],
    message: unavailable,
  });
  const onFinish = vi.fn();
  const wizard = () => (
    <ProviderWizardAuthenticationStep
      environmentId={environmentId}
      environmentLabel="Remote device"
      instanceId={instanceId}
      onFinish={onFinish}
    />
  );
  await using screen = await render(wizard());
  await expect.element(screen.getByText("Signed in.", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(unavailable, { exact: true })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Done", exact: true }).click();
  expect(onFinish).toHaveBeenCalledOnce();

  setup.providersAtom = Atom.make([{ ...detected, auth: { status: "unauthenticated" } }]);
  await screen.rerender(wizard());
  await expect.element(screen.getByText(unavailable, { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
});
