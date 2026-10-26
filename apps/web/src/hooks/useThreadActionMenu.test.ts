import { MinesCatalog, catalogHostId } from "@t3tools/client-runtime/catalog";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  type ContextMenuItem,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  catalog: null as MinesCatalog | null,
  owned: new Set<string>(),
  granted: new Set<string>(),
  effects: [] as string[],
  completed: deferred<void>(),
  show: vi.fn<
    (
      items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
      position: { x: number; y: number },
    ) => Promise<ThreadActionMenuId | null>
  >(),
}));

function recordEffect(action: string) {
  state.effects.push(action);
  state.completed.resolve();
}

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.owned }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => state.owned } }));
vi.mock("../catalog/useMinesCatalog", () => ({
  useMinesCatalog: () => ({ catalog: state.catalog }),
}));
vi.mock("../components/CustomSnoozeDialog", () => ({ requestCustomSnooze: vi.fn() }));
vi.mock("../components/chat/mineTransferAvailability", () => ({
  canTransferMineAtom: () => "transfer-available",
}));
vi.mock("../components/chat/mineTransferDialogState", () => ({
  openMineTransferDialog: () => recordEffect("transfer-mine"),
}));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: async () => recordEffect("project-settings") }),
}));
vi.mock("../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.granted.has(environmentId),
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsAutoSettleOptOut: () => true,
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readEnvironmentSupportsTitleRegeneration: () => true,
  readThreadShell: () => ({
    id: "thread",
    environmentId: "secondary",
    projectId: "project",
    title: "Thread",
    branch: "main",
    worktreePath: null,
    runtime: null,
    latestRun: null,
  }),
  useProjects: () => [{ id: "project", environmentId: "secondary" }],
}));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "primary" }));
vi.mock("../state/threads", () => ({ threadEnvironment: { updateMetadata: "metadata" } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => {
    recordEffect("metadata");
    return AsyncResult.success(undefined);
  },
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: state.show, close: () => {} },
    dialogs: {
      confirm: async () => {
        recordEffect("confirm");
        return false;
      },
    },
  }),
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "project",
  derivePhysicalProjectKey: () => "project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../sidebarProjectGrouping", () => ({
  buildPhysicalToLogicalProjectKeyMap: () => new Map(),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadUnread: () => recordEffect("mark-unread"),
    }),
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: () => state.completed.resolve() },
}));
vi.mock("../components/Sidebar.snooze", () => ({
  resolveSnoozePresets: () => [
    { id: "hour", label: "In 1 hour", whenLabel: "3 PM", snoozedUntil: "2099-01-01T00:00:00Z" },
  ],
  snoozeWakeDescription: () => "later",
}));
vi.mock("./useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: () => recordEffect("copy") }),
}));
vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => recordEffect("draft"),
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      confirmThreadDelete: true,
      confirmThreadArchive: true,
      timestampFormat: "12-hour",
    }),
}));
vi.mock("./useThreadActions", () => ({
  useThreadActions: () =>
    Object.fromEntries(
      [
        "markThreadUnread",
        "settleThread",
        "unsettleThread",
        "snoozeThread",
        "unsnoozeThread",
        "pinThread",
        "confirmAndUnpinThread",
        "archiveThread",
        "deleteThread",
      ].map((action) => [
        action,
        async () => {
          recordEffect(action === "markThreadUnread" ? "mark-unread" : action);
          return AsyncResult.success(undefined);
        },
      ]),
    ),
}));

import { useThreadActionMenu } from "./useThreadActionMenu";

const target = {
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
};
const position = { x: 10, y: 20 };
const createMenu = () =>
  useThreadActionMenu({
    threadRef: target,
    projectCwd: "/project",
    onStartRename: () => recordEffect("rename"),
    canShareWithGuest: false,
  });

beforeEach(() => {
  state.catalog?.destroy();
  state.catalog = new MinesCatalog();
  state.owned = new Set(["secondary"]);
  state.granted = new Set(["primary"]);
  state.effects = [];
  state.completed = deferred<void>();
  state.show.mockReset().mockResolvedValue(null);
});

describe("thread menu permissions", () => {
  it.each(["rename", "regenerate-title", "delete", "settle", "archive", "transfer-mine"] as const)(
    "%s rechecks after the native menu closes",
    async (action) => {
      state.granted.add("secondary");
      const choice = deferred<ThreadActionMenuId | null>();
      state.show.mockReturnValue(choice.promise);
      createMenu().openMenu(position);
      state.granted.delete("secondary");
      choice.resolve(action);
      await state.completed.promise;
      expect(state.effects).toEqual([]);
    },
  );
});

it("pins and unpins the same local Library catalog without mutating the owning host", async () => {
  const catalog = state.catalog!;
  const id = catalogHostId("thread", target.environmentId, target.threadId);
  const changed = () =>
    new Promise<void>((resolve) => {
      const stop = catalog.subscribe(() => {
        stop();
        resolve();
      });
    });
  const pinned = changed();
  state.show.mockResolvedValue("pin");
  createMenu().openMenu(position);
  await pinned;
  expect(state.effects).toEqual([]);
  expect(catalog.getSnapshot().pins.map((entry) => entry.entity.id)).toEqual([id]);
  expect(state.show.mock.calls[0]![0].find((item) => item.id === "pin")?.disabled).not.toBe(true);
  const unpinned = changed();
  state.show.mockResolvedValue("unpin");
  createMenu().openMenu(position);
  await unpinned;
  expect(catalog.getSnapshot().pins).toEqual([]);
  expect(catalog.has(id)).toBe(true);
  expect(state.effects).toEqual([]);
});

it("does not copy a remote title into the catalog after account ownership changes", async () => {
  const choice = deferred<ThreadActionMenuId | null>();
  state.show.mockReturnValue(choice.promise);
  const completed = createMenu().openMenu(position);
  state.owned = new Set();
  choice.resolve("pin");
  await completed;
  expect(state.catalog!.getSnapshot().entities).toEqual([]);
  expect(state.effects).toEqual([]);
});
