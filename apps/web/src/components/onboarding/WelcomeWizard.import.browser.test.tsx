import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ProjectId,
  type AgentSessionProjectCandidate,
  type AgentSessionSourceReport,
  type AgentSessionScanInput,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../../test/render";
import {
  BackgroundImportQueue,
  type NewBackgroundImportJob,
} from "../../onboarding/backgroundImports.logic";
import { readEnvironmentScope } from "../../state/session";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
type Project = { id: ProjectId; environmentId: EnvironmentId; workspaceRoot: string };
type CreateProjectInput = {
  environmentId: EnvironmentId;
  input: { projectId: ProjectId; workspaceRoot: string };
};
const state = vi.hoisted(() => ({
  queue: null as unknown,
  selectedEnvironment: "primary",
  sessions: new Map<string, unknown>(),
  projects: null as unknown,
  providers: null as unknown,
  config: null as unknown,
  candidates: [] as AgentSessionProjectCandidate[],
  sourceReports: [] as AgentSessionSourceReport[],
  createProject: vi.fn(),
  importThreads: vi.fn(),
  refreshProviders: vi.fn(),
  connectPairing: vi.fn(),
  completeOnboarding: vi.fn(),
  onDone: vi.fn(),
  scan: vi.fn(),
  refreshScan: vi.fn(),
}));

vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((runtime: never) => ({
      ...actual.createEnvironmentSessionAtoms(runtime),
      sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id),
    })) as never,
  };
});
vi.mock(import("../../cloud/publicConfig"), async (original) => ({
  ...(await original()),
  hasCloudPublicConfig: () => false,
  hasMinesIdentityConfig: () => false,
}));
vi.mock(import("../../onboarding/firstRun"), async (original) => ({
  ...(await original()),
  completeOnboarding: state.completeOnboarding,
}));
vi.mock(import("../../state/environments"), async (original) => {
  const environment = (environmentId: string) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
    entry: { enabled: true, target: { _tag: "DirectConnectionTarget" } },
  });
  const primary = environment("primary");
  return {
    ...(await original()),
    usePrimaryEnvironment: (() => primary) as never,
    useEnvironments: (() => ({ environments: [environment(state.selectedEnvironment)] })) as never,
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
      refreshProviders: "refreshProviders" as never,
    },
  };
});
vi.mock(import("../../state/entities"), async (original) => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...(await original()),
    useProjects: (() => useAtomValue(state.projects as Atom.Atom<Project[]>)) as never,
    readProjects: (() => appAtomRegistry.get(state.projects as Atom.Atom<Project[]>)) as never,
  };
});
vi.mock(import("../../state/backgroundImports"), () => ({
  backgroundImports: {
    enqueue: (jobs: readonly NewBackgroundImportJob[]) =>
      (state.queue as BackgroundImportQueue).enqueue(jobs),
  } as never,
  useBackgroundImports: () => ({ jobs: [], storageError: null }),
}));
vi.mock(import("../../state/projects"), async (original) => ({
  ...(await original()),
  projectEnvironment: { create: "createProject" } as never,
}));
vi.mock(import("../../state/agentSessions"), async (original) => ({
  ...(await original()),
  agentSessionImport: "importThreads" as never,
}));
vi.mock(import("../../onboarding/useProjectScans"), async (original) => ({
  ...(await original()),
  useProjectScans: (ids: readonly EnvironmentId[], input: AgentSessionScanInput = {}) =>
    ids.map((environmentId) => {
      state.scan({ environmentId });
      return {
        environmentId,
        data: {
          candidates: state.candidates.filter((candidate) =>
            candidate.sources.some((source) => input.sources?.includes(source) ?? true),
          ),
          truncated: false,
          sourceReports: state.sourceReports,
        } as never,
        isPending: false,
        error: null,
        refresh: state.refreshScan,
      };
    }),
}));
vi.mock(import("../../connection/onboarding"), async (original) => ({
  ...(await original()),
  connectPairing: "connectPairing" as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((
    command: "createProject" | "importThreads" | "refreshProviders" | "connectPairing",
  ) => state[command]) as never,
}));
vi.mock(import("../settings/ChatGptWelcomeCoordinator"), async (original) => ({
  ...(await original()),
  ChatGptWelcomeCoordinator: () => <></>,
}));

import { appAtomRegistry } from "../../rpc/atomRegistry";
vi.mock("../settings/MinesPeerSettings", () => ({ MinesPeerSettings: () => null }));

import { WelcomeWizard } from "./WelcomeWizard";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const permissionMessage = "This connection cannot import projects or mine history.";

function session(scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState {
  return {
    authenticated: true,
    scopes: [AuthOrchestrationReadScope, ...scopes],
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    },
  };
}

function sessionAtom(environmentId: EnvironmentId) {
  return state.sessions.get(environmentId) as Atom.Writable<SessionResult>;
}

function projectsAtom() {
  return state.projects as Atom.Writable<ReadonlyArray<Project>>;
}

function setGrant(environmentId: EnvironmentId, allowed: boolean) {
  appAtomRegistry.set(
    sessionAtom(environmentId),
    AsyncResult.success(session(allowed ? [AuthOrchestrationOperateScope] : [])),
  );
}

// Candidate timestamps stay stable across runs.
const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function candidate(path: string): AgentSessionProjectCandidate {
  return {
    path,
    title: path.split("/").at(-1)!,
    sources: ["codex"],
    threadCount: 10,
    lastActiveAt: new Date(NOW - 60_000).toISOString(),
    alreadyImported: false,
  };
}

function recordProject({ environmentId, input }: CreateProjectInput) {
  appAtomRegistry.set(projectsAtom(), [
    ...appAtomRegistry.get(projectsAtom()),
    { id: input.projectId, environmentId, workspaceRoot: input.workspaceRoot },
  ]);
  return AsyncResult.success(undefined);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function pageText() {
  return document.body.textContent ?? "";
}

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(label: string) {
  const target = button(label);
  expect(target.disabled).toBe(false);
  await act(async () => target.click());
}

async function mountImport(remote = false) {
  state.selectedEnvironment = remote ? "remote" : "primary";
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <WelcomeWizard localAvailable={!remote} onDone={state.onDone} />
      </RegistryContext.Provider>,
    ),
  );
  await click("Continue");
  await click("Continue");
  expect(pageText()).toContain("Import conversations");
  stack.move();
  return screen;
}

// The mocked modules read `state`, so every test starts by replacing all of it.
// Returns the clock spy so each test can `using` it; the spy would otherwise outlive the test.
function setup() {
  window.localStorage.removeItem("mines:onboarding:v1");
  const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
  state.sessions.clear();
  for (const id of [primaryId, remoteId]) {
    state.sessions.set(
      id,
      Atom.make<SessionResult>(AsyncResult.success(session([AuthOrchestrationOperateScope]))).pipe(
        Atom.keepAlive,
      ),
    );
  }
  state.projects = Atom.make<ReadonlyArray<Project>>([]).pipe(Atom.keepAlive);
  state.providers = Atom.make<ReadonlyArray<never>>([]).pipe(Atom.keepAlive);
  state.config = Atom.make(null).pipe(Atom.keepAlive);
  state.candidates = [candidate("/projects/first"), candidate("/projects/second")];
  state.sourceReports = [];
  state.createProject
    .mockReset()
    .mockImplementation(async (input: CreateProjectInput) => recordProject(input));
  state.importThreads
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ importedCount: 1, skippedCount: 0 }));
  state.refreshProviders.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.connectPairing.mockReset().mockResolvedValue(AsyncResult.success(remoteId));
  state.completeOnboarding.mockReset().mockResolvedValue(undefined);
  state.onDone.mockReset();
  state.scan.mockReset();
  state.refreshScan.mockReset();
  state.queue = new BackgroundImportQueue({
    load: () => null,
    save: () => {},
    checkAccess: (job) =>
      readEnvironmentScope(job.environmentId, AuthOrchestrationOperateScope)
        ? null
        : permissionMessage,
    createProject: async (job) => {
      await state.createProject({
        environmentId: job.environmentId,
        input: { projectId: job.projectId, workspaceRoot: job.workspaceRoot },
      });
    },
    importPage: async () => (await state.importThreads()).value,
  });
  return now;
}

it("finishes onboarding while history continues independently in the saved queue", async () => {
  using _now = setup();
  state.candidates = state.candidates.slice(0, 1);
  const imported = deferred<{ importedCount: number; skippedCount: number }>();
  state.importThreads.mockImplementationOnce(async () =>
    AsyncResult.success(await imported.promise),
  );
  await using _screen = await mountImport();
  await click("Import selected conversations");
  expect(pageText()).toContain("Your work, on your phone");
  expect((state.queue as BackgroundImportQueue).getSnapshot().jobs[0]?.status).toBe("running");
  await click("Start using mines");
  expect(state.onDone).toHaveBeenCalledOnce();
  await act(async () => {
    imported.resolve({ importedCount: 1, skippedCount: 0 });
    await (state.queue as BackgroundImportQueue).whenIdle();
  });
  expect((state.queue as BackgroundImportQueue).getSnapshot().jobs[0]?.status).toBe("complete");
});

it("keeps onboarding usable when a queued import loses permission", async () => {
  using _now = setup();
  const creation = deferred<void>();
  state.createProject.mockImplementationOnce(async (input: CreateProjectInput) => {
    await creation.promise;
    return recordProject(input);
  });
  await using _screen = await mountImport();
  await click("Import selected conversations");
  await act(async () => {
    setGrant(primaryId, false);
    creation.resolve();
    await (state.queue as BackgroundImportQueue).whenIdle();
  });
  expect(state.importThreads).not.toHaveBeenCalled();
  expect(
    (state.queue as BackgroundImportQueue)
      .getSnapshot()
      .jobs.every((job) => job.status === "paused"),
  ).toBe(true);
  await click("Start using mines");
  expect(state.onDone).toHaveBeenCalledOnce();
});

it("queues only selected mines from real section previews, including existing projects", async () => {
  using _now = setup();
  const project = candidate("/projects/app");
  state.candidates = [
    {
      ...project,
      projectId: ProjectId.make("existing"),
      alreadyImported: true,
      sourceSection: { id: "work", title: "Work" },
      threads: [
        { key: "one", title: "First retained mine", source: "codex", lastActiveAt: null },
        { key: "two", title: "Second retained mine", source: "codex", lastActiveAt: null },
      ],
    },
  ];
  await using screen = await mountImport();
  await expect.element(screen.getByText("Work", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Show mines in app" }).click();
  await screen.getByRole("checkbox", { name: "Import mine First retained mine" }).click();
  await click("Import selected conversations");
  await (state.queue as BackgroundImportQueue).whenIdle();
  const job = (state.queue as BackgroundImportQueue).getSnapshot().jobs[0];
  expect(job?.projectId).toBe("existing");
  expect(job?.sourceSection).toEqual({ id: "work", title: "Work" });
  expect(job?.options.threadKeys).toEqual(["two"]);
  expect(state.createProject).not.toHaveBeenCalled();
});

it("keeps routine source coverage out of the picker and collapses real import issues", async () => {
  using _now = setup();
  const routine =
    "All retained history in configured profiles and archives is scanned regardless of age.";
  const missingWorkspace =
    "Workspace /old/work is unavailable. Its history can be imported into a separate history project; the original directory is not recreated.";
  const unreadableExport =
    "Could not read saved-export.json as an OpenCode or Antigravity transcript export.";
  state.sourceReports = [
    { source: "codex", status: "available", message: routine },
    { source: "codex", status: "unavailable", message: routine },
    { source: "antigravity", status: "unsupported", message: "Native formats are unsupported." },
    { source: "opencode", status: "partial", message: missingWorkspace },
    { source: "opencode", status: "partial", message: missingWorkspace },
    { source: "antigravity", status: "unsupported", message: unreadableExport },
  ];
  await using screen = await mountImport();
  await expect.element(screen.getByText(new RegExp(routine))).not.toBeInTheDocument();
  const issues = screen.getByText("Import issues (2)", { exact: true });
  await expect.element(issues).toBeVisible();
  await expect.element(screen.getByText(new RegExp("Workspace /old/work"))).not.toBeVisible();
  await issues.click();
  await expect.element(screen.getByText(new RegExp("Workspace /old/work"))).toBeVisible();
  await expect.element(screen.getByText(new RegExp("Could not read saved-export"))).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Import selected conversations" }))
    .toBeEnabled();
});

it("shows only discovered history sources and keeps an unchecked source available after rescan", async () => {
  using _now = setup();
  state.sourceReports = [
    { source: "antigravity", status: "available", message: "Exports are supported." },
  ];
  await using screen = await mountImport();
  const codex = screen.getByRole("checkbox", { name: "Codex", exact: true });
  await expect.element(codex).toBeChecked();
  await expect
    .element(screen.getByRole("checkbox", { name: "Antigravity", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("checkbox", { name: "T3 Code", exact: true }))
    .not.toBeInTheDocument();
  await codex.click();
  await expect.element(codex).toBeVisible();
  await expect.element(codex).not.toBeChecked();
  await expect
    .element(screen.getByText("No retained projects found for these sources."))
    .toBeVisible();
  await codex.click();
  await expect
    .element(screen.getByRole("button", { name: "Import selected conversations" }))
    .toBeEnabled();
  await expect.element(screen.getByText("Add exported history", { exact: true })).toBeVisible();
});
