import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { render } from "../../../test/render";
import { composerTargetKey, useComposerDraftStore } from "../../composerDraftStore";
import { getLocalStorageItem } from "../../hooks/useLocalStorage";
import { RetainedWorkflowLauncher } from "./RetainedWorkflowLauncher";
import { requestWorkflowLauncher } from "./WorkflowPicker";
import { WorkflowTargetDraft } from "./workflowTargets";

const state = vi.hoisted(() => ({
  providers: new Map<string, ReadonlyArray<ServerProvider>>(),
  calls: vi.fn(),
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      {
        environmentId: "mac",
        label: "Mac",
        entry: {
          target: { _tag: "PrimaryConnectionTarget", httpBaseUrl: "http://localhost:3773" },
        },
        connection: { phase: "connected" },
      },
      {
        environmentId: "linux",
        label: "Linux",
        entry: { target: { _tag: "BearerConnectionTarget", connectionId: "linux" } },
        connection: { phase: "connected" },
      },
    ],
  })) as never,
  useEnvironmentProviders: (() => state.providers) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [
    { environmentId: "mac", id: "work", title: "Mac work", workspaceRoot: "/work/mac" },
    { environmentId: "linux", id: "work", title: "Linux work", workspaceRoot: "/work/linux" },
  ]) as never,
  useQuietThreadShell: (() => ({ id: "existing", projectId: "work", branch: "main" })) as never,
}));
vi.mock(import("../../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: (() => state.calls) as never,
}));
vi.mock(import("./ComposerDevicePicker"), () => ({
  ComposerDevicePicker: ({ onConfigureWorkflow }: { onConfigureWorkflow?: () => void }) => (
    <button onClick={onConfigureWorkflow}>Device workflows</button>
  ),
}));
const environmentId = EnvironmentId.make("mac");
const source = { environmentId, threadId: ThreadId.make("existing") };
const routeKey = "workflow-browser-existing";
const account = ProviderInstanceId.make("codex-work");
const selections = [
  { instanceId: account, model: "alpha", options: [{ id: "effort", value: "high" }] },
  { instanceId: account, model: "beta", options: [{ id: "effort", value: "high" }] },
];
function setup() {
  state.calls.mockReset();
  state.calls.mockRejectedValue(new Error("This regression must not start provider work"));
  const provider: ServerProvider = {
    instanceId: account,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Work account",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-01T00:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: ["alpha", "beta"].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "high", label: "High" },
              { id: "low", label: "Low" },
            ],
          },
        ],
      },
    })),
  };
  state.providers = new Map([
    ["mac", [provider]],
    ["linux", [provider]],
  ]);
  localStorage.removeItem(`mines:workflow-targets:${composerTargetKey(source)}`);
  localStorage.removeItem(`mines:workflow-launch:${composerTargetKey(source)}`);
  useComposerDraftStore.getState().setPrompt(source, "Review the current implementation");
}
function ExistingChat({ generation }: { generation: number }) {
  return (
    <>
      <button onClick={() => requestWorkflowLauncher(routeKey)}>Send to selected models</button>
      <RetainedWorkflowLauncher
        key={generation}
        environmentId={environmentId}
        composerTarget={source}
        routeThreadKey={routeKey}
        selections={selections}
        runtimeMode="approval-required"
        interactionMode="default"
        size="sm"
        disabled={false}
      />
    </>
  );
}

it("keeps workflow sending available without its dedicated control and retains each device/account/model/options when remounted", async () => {
  setup();
  await using screen = await render(<ExistingChat generation={1} />);
  await expect
    .element(screen.getByRole("button", { name: "Choose models and devices" }))
    .not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Send to selected models" }));
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect
    .element(page.getByRole("heading", { name: "Run a workflow across devices" }))
    .toBeVisible();
  const second = page.getByRole("group", { name: "Workflow target 2" });
  await userEvent.selectOptions(
    second.getByRole("combobox", { name: "Device", exact: true }),
    "linux",
  );
  await expect
    .element(second.getByRole("combobox", { name: "Account", exact: true }))
    .toHaveValue("");
  await userEvent.selectOptions(
    second.getByRole("combobox", { name: "Workspace", exact: true }),
    "work",
  );
  await userEvent.selectOptions(
    second.getByRole("combobox", { name: "Account", exact: true }),
    "codex-work",
  );
  await userEvent.selectOptions(
    second.getByRole("combobox", { name: "Model", exact: true }),
    "beta",
  );
  await userEvent.selectOptions(
    second.getByRole("combobox", { name: "Reasoning", exact: true }),
    "low",
  );
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await screen.rerender(<ExistingChat generation={2} />);
  await userEvent.click(screen.getByRole("button", { name: "Send to selected models" }));
  const first = page.getByRole("group", { name: "Workflow target 1" });
  await expect
    .element(first.getByRole("combobox", { name: "Device", exact: true }))
    .toHaveValue("mac");
  await expect
    .element(first.getByRole("combobox", { name: "Model", exact: true }))
    .toHaveValue("alpha");
  await expect
    .element(first.getByRole("combobox", { name: "Reasoning", exact: true }))
    .toHaveValue("high");
  await expect
    .element(second.getByRole("combobox", { name: "Device", exact: true }))
    .toHaveValue("linux");
  await expect
    .element(second.getByRole("combobox", { name: "Account", exact: true }))
    .toHaveValue("codex-work");
  await expect
    .element(second.getByRole("combobox", { name: "Model", exact: true }))
    .toHaveValue("beta");
  await expect
    .element(second.getByRole("combobox", { name: "Reasoning", exact: true }))
    .toHaveValue("low");
  const saved = getLocalStorageItem(
    `mines:workflow-targets:${composerTargetKey(source)}`,
    WorkflowTargetDraft,
  );
  expect(saved?.targets[1]?.projectId).toBe(ProjectId.make("work"));
  expect(useComposerDraftStore.getState().getComposerDraft(source)?.prompt).toBe(
    "Review the current implementation",
  );
  expect(state.calls).not.toHaveBeenCalled();
});
