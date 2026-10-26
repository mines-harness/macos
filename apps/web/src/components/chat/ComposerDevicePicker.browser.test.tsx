import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { EnvironmentId, ProviderInstanceId, type CloudSnapshot } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { ComposerDevicePicker } from "./ComposerDevicePicker";

const state = vi.hoisted(() => ({
  connected: true,
  data: null as CloudSnapshot | null,
  error: null as string | null,
  pending: true,
  local: true,
  refresh: vi.fn(),
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironments: (() => ({
    environments: [
      {
        environmentId: "mac",
        label: "My Mac",
        entry: {
          target: state.local
            ? { _tag: "PrimaryConnectionTarget", httpBaseUrl: "http://localhost:3773" }
            : { _tag: "BearerConnectionTarget", connectionId: "remote-mac" },
        },
        connection: { phase: state.connected ? "connected" : "disconnected" },
      },
    ],
  })) as never,
}));
vi.mock(import("../../state/entities"), () => ({ useProjects: () => [] }));
vi.mock(import("../../hooks/useHandleNewThread"), () => ({
  useNewThreadHandler: (() => vi.fn()) as never,
}));
vi.mock(import("../../hooks/useScratchProject"), () => ({
  useScratchProject: (() => ({ startScratchThread: vi.fn() })) as never,
}));
vi.mock(import("../../state/cloudTasks"), () => ({ cloudSnapshot: (() => null) as never }));
vi.mock(import("../../state/query"), () => ({
  useEnvironmentQuery: (() => ({
    data: state.data,
    error: state.error,
    isPending: state.pending,
    refresh: state.refresh,
  })) as never,
}));

const environmentId = EnvironmentId.make("mac");
function setup() {
  state.connected = true;
  state.data = null;
  state.error = null;
  state.pending = true;
  state.local = true;
  state.refresh.mockReset();
}

it("shows pending discovery rather than an empty cloud heading", async () => {
  setup();
  await using screen = await render(<ComposerDevicePicker environmentId={environmentId} />);
  await expect
    .element(screen.getByRole("button", { name: "Execution device" }))
    .toHaveTextContent("Local");
  await userEvent.click(screen.getByRole("button", { name: "Execution device" }));
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Checking cloud accounts on Local…");
});

it("keeps the current remote computer’s name instead of treating the current mine as local", async () => {
  setup();
  state.local = false;
  await using screen = await render(<ComposerDevicePicker environmentId={environmentId} />);
  await expect
    .element(screen.getByRole("button", { name: "Execution device" }))
    .toHaveTextContent("My Mac");
  await userEvent.click(screen.getByRole("button", { name: "Execution device" }));
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Checking cloud accounts on My Mac…");
});

it("offers provider setup scoped to the computer when no accounts are found", async () => {
  setup();
  state.pending = false;
  state.data = { targets: [], tasks: [] };
  await using screen = await render(<ComposerDevicePicker environmentId={environmentId} />);
  using navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);
  await userEvent.click(screen.getByRole("button", { name: "Execution device" }));
  await expect.element(page.getByText("No Codex or Claude cloud accounts on Local.")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Set up a provider account" }));
  expect(navigate).toHaveBeenCalledWith({
    to: "/settings/providers",
    search: { environmentId },
  });
});

it("exposes failed discovery and retries without creating a task", async () => {
  setup();
  state.pending = false;
  state.error = "The computer does not grant access to cloud tasks.";
  await using screen = await render(<ComposerDevicePicker environmentId={environmentId} />);
  await userEvent.click(screen.getByRole("button", { name: "Execution device" }));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Could not check cloud accounts on Local.");
  await expect.element(page.getByText(state.error)).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Retry cloud connection" }));
  expect(state.refresh).toHaveBeenCalledOnce();
});

it("shows offline discovery without implying an account does not exist", async () => {
  setup();
  state.connected = false;
  await using screen = await render(<ComposerDevicePicker environmentId={environmentId} />);
  await userEvent.click(screen.getByRole("button", { name: "Execution device" }));
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Local is offline. Reconnect to check its cloud accounts.");
  await expect
    .element(page.getByRole("button", { name: "Set up a provider account" }))
    .not.toBeInTheDocument();
});

it("keeps an unavailable cloud account discoverable and explains its actual setup requirement", async () => {
  setup();
  state.pending = false;
  state.data = {
    targets: [
      {
        id: "cloud:codex-work",
        provider: "codex",
        instanceId: ProviderInstanceId.make("codex-work"),
        label: "Codex Cloud · Work",
        executionLocation: "provider-cloud",
        bridgeStatus: "unavailable",
        cliVersion: null,
        capabilities: {
          submit: false,
          list: false,
          followUp: false,
          status: false,
          diff: false,
          apply: false,
          transcript: false,
          cancel: false,
        },
        reason: "Install the provider CLI on this computer to control cloud tasks.",
      },
    ],
    tasks: [],
  };
  await using screen = await render(<ComposerDevicePicker environmentId={environmentId} />);
  using navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);
  await userEvent.click(screen.getByRole("button", { name: "Execution device" }));
  await expect.element(page.getByText(state.data.targets[0]!.reason!)).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /Codex Cloud · Work/ }));
  expect(navigate).toHaveBeenCalledWith({
    to: "/$environmentId/cloud/$targetId",
    params: { environmentId, targetId: "cloud:codex-work" },
  });
});
