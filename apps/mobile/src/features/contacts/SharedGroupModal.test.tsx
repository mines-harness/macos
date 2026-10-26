import { act, type ReactNode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { GroupId } from "@t3tools/contracts/groupChat";
import type { SharedGroupView } from "@t3tools/contracts/sharedGroups";
import { openGroupDraft } from "../../catalog/groupDraft";

const state = vi.hoisted(() => ({
  view: null as SharedGroupView | null,
  store: null as Awaited<ReturnType<typeof openGroupDraft>> | null,
  send: vi.fn(async (_target: { input: { requestAiResponse?: boolean } }) =>
    AsyncResult.success(state.view!),
  ),
}));
vi.mock("react-native", () => {
  const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Modal: Container,
    SafeAreaView: Container,
    KeyboardAvoidingView: Container,
    View: Container,
    Platform: { OS: "ios" },
    FlatList: () => null,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: () => null,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/ThemedSwitch", () => ({
  ThemedSwitch: ({
    value,
    disabled,
    onValueChange,
  }: {
    value: boolean;
    disabled: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      aria-label="Ask AI"
      type="checkbox"
      checked={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.checked)}
    />
  ),
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./ContactAvatar", () => ({ ContactAvatar: () => null }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "selection-request" }));
vi.mock("./sharedGroupHost", () => ({ checkSharedGroupHost: async () => {} }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.view,
    isPending: false,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("../../state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("../../state/sharedGroups", () => {
  const command = { permissionAtom: () => true };
  return {
    sharedGroupSubscription: () => null,
    sharedGroupSend: command,
    sharedGroupLeave: command,
    sharedGroupAddChats: command,
    sharedGroupRemoveChats: command,
    sharedGroupAccountState: {},
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.send }));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => async () => {} }));
vi.mock("../../catalog/useGroupDraft", () => ({
  useGroupDraft: () => {
    const snapshot = useSyncExternalStore(
      state.store!.subscribe,
      state.store!.getSnapshot,
      state.store!.getSnapshot,
    );
    return { store: state.store, draft: snapshot.draft, error: snapshot.error };
  },
}));

import { SharedGroupModal } from "./SharedGroupModal";

async function setup(withMine = true) {
  const environmentId = EnvironmentId.make("local");
  const groupId = GroupId.make("group");
  const now = IsoDateTime.make("2026-10-27T00:00:00.000Z");
  const profile = { friendId: "mines-00000000000000000000", displayName: "Me", avatar: null };
  const group = {
    key: "shared-group-key-1",
    groupId,
    groupName: "Friends",
    coordinatorEnvironmentId: environmentId,
    coordinatorDeviceId: "a".repeat(43),
    owner: profile,
    members: [profile],
    memberships: [],
  };
  state.view = {
    status: "online",
    selectedThreadIds: [],
    snapshot: {
      group: {
        id: groupId,
        name: "Friends",
        workflow: "team",
        leadMemberId: "mine",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        visibility: "shared",
      },
      members: withMine
        ? [
            {
              id: "mine",
              groupId,
              threadId: ThreadId.make("mine"),
              projectId: ProjectId.make("project"),
              environmentId,
              alias: "helper",
              role: "",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
              joinedAt: now,
            },
          ]
        : [],
      messages: [],
      rounds: [],
      hasMoreMessages: false,
    },
  };
  let id = 0;
  state.store = await openGroupDraft({
    environmentId,
    groupId: group.key,
    createId: () => `request-${++id}`,
    storage: { read: async () => null, write: async () => {} },
  });
  state.store.setText("@everyone a note for friends");
  await state.store.flush();
  state.send.mockClear();
  const acknowledged = Promise.withResolvers<void>();
  const unsubscribe = state.store.subscribe(() => {
    if (state.store!.getSnapshot().draft.text === "") acknowledged.resolve();
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  act(() =>
    root.render(
      <SharedGroupModal
        environmentId={environmentId}
        group={group}
        profile={profile}
        contacts={{
          accountId: "account",
          data: { profile, contacts: [], groups: [group], invitations: [] },
          pending: false,
          error: null,
          isLoaded: true,
          isSignedIn: true,
          configured: true,
          refresh: async () => true,
          run: async () => false,
        }}
        onClose={() => {}}
      />,
    ),
  );
  const toggle = () => container.querySelector<HTMLInputElement>('input[aria-label="Ask AI"]')!;
  return {
    toggle,
    async send() {
      const button = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Send",
      )!;
      await act(async () => {
        button.click();
        await acknowledged.promise;
        await state.store!.flush();
      });
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      unsubscribe();
      state.store = null;
      globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
    },
  };
}

it("keeps mentions as human messages until Ask AI is explicitly enabled", async () => {
  using ui = await setup();
  expect(state.send).not.toHaveBeenCalled();
  expect(ui.toggle().checked).toBe(false);
  await ui.send();
  expect(state.send.mock.calls[0]?.[0].input.requestAiResponse).toBe(false);
});

it("sends an explicit AI request once and resets Ask AI after acknowledgement", async () => {
  using ui = await setup();
  act(() => ui.toggle().click());
  expect(ui.toggle().checked).toBe(true);
  await ui.send();
  expect(state.send.mock.calls[0]?.[0].input.requestAiResponse).toBe(true);
  expect(ui.toggle().checked).toBe(false);
});

it("allows human notes while Ask AI stays disabled in an empty group", async () => {
  using ui = await setup(false);
  expect(ui.toggle().disabled).toBe(true);
  await ui.send();
  expect(state.send.mock.calls[0]?.[0].input.requestAiResponse).toBe(false);
});
