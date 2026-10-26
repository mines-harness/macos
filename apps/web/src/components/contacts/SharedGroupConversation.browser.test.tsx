import {
  EnvironmentId,
  GroupId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { SharedContactGroup } from "@t3tools/contracts/contacts";
import type { SharedGroupView } from "@t3tools/contracts/sharedGroups";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useContacts } from "./ContactsProvider";
import { SharedGroupConversation } from "./SharedGroupConversation";

vi.mock("../../cloud/MinesAuthProvider", () => ({ useMinesAuth: () => ({ userId: "alice" }) }));
vi.mock("./sharedGroupHost", () => ({ checkSharedGroupHost: async () => {} }));
vi.mock("../../state/peers", () => ({ readPeerConnectionState: {} }));
vi.mock("../../state/entities", () => ({ useQuietThreadShells: () => [] }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("./ContactsProvider", () => ({ useContacts: vi.fn() }));
vi.mock("../../state/sharedGroups", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    sharedGroupSubscription: () => null,
    sharedGroupSend: { permissionAtom: () => allowed },
    sharedGroupAddChats: { permissionAtom: () => allowed },
    sharedGroupRemoveChats: { permissionAtom: () => allowed },
  };
});
const environmentId = EnvironmentId.make("my-computer");
const profile = { friendId: "mines-11111111111111111111", displayName: "Alice", avatar: null };
const friend = { friendId: "mines-22222222222222222222", displayName: "Bob", avatar: null };
const group: SharedContactGroup = {
  key: "friends_group_key_01",
  groupId: "friends",
  groupName: "Friends",
  coordinatorEnvironmentId: "friend-computer",
  coordinatorDeviceId: "a".repeat(43),
  owner: friend,
  members: [friend, profile],
  memberships: [{ invitationId: "invite-1", friendId: profile.friendId }],
};
function setup(hasChats = true) {
  localStorage.removeItem(
    `mines:shared-group-message:${JSON.stringify(["alice", environmentId, group.key])}`,
  );
  const view: SharedGroupView = {
    status: "online",
    selectedThreadIds: [],
    snapshot: {
      group: {
        id: GroupId.make(group.groupId),
        name: group.groupName,
        workflow: "team",
        leadMemberId: "",
        createdAt: "2026-10-26T00:00:00Z",
        updatedAt: "2026-10-26T00:00:00Z",
        archivedAt: null,
        visibility: "shared",
      },
      members: hasChats
        ? [
            {
              id: "mine-1",
              groupId: GroupId.make(group.groupId),
              threadId: ThreadId.make("mine-1"),
              projectId: ProjectId.make("project"),
              environmentId: null,
              alias: "helper",
              role: "",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
              joinedAt: "2026-10-26T00:00:00Z",
            },
          ]
        : [],
      messages: [
        {
          id: "human-message",
          groupId: GroupId.make(group.groupId),
          roundId: null,
          memberId: null,
          authorFriendId: friend.friendId,
          kind: "user",
          text: "Hello Alice",
          createdAt: "2026-10-26T00:00:00Z",
          truncated: false,
        },
      ],
      rounds: [],
      hasMoreMessages: false,
    },
  };
  const run = vi
    .fn<(_input: unknown) => Promise<AtomCommandResult<SharedGroupView, Error>>>()
    .mockResolvedValue(AsyncResult.success(view));
  vi.mocked(useAtomCommand).mockReturnValue(run);
  vi.mocked(useEnvironmentQuery).mockReturnValue({
    data: view,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: vi.fn(),
  });
  vi.mocked(useContacts).mockReturnValue({
    data: { profile, contacts: [friend], invitations: [], groups: [group] },
    error: null,
    pending: false,
    busy: false,
    signedIn: true,
    refresh: vi.fn(),
    mutate: vi.fn(async () => null),
  });
  return run;
}

it("sends mentions as human notes until Ask AI is explicitly enabled and resets that choice after sending", async () => {
  const run = setup();
  await using screen = await render(
    <SharedGroupConversation group={group} environmentId={environmentId} />,
  );
  await expect.element(screen.getByText("Bob", { exact: true })).toBeVisible();
  await screen.getByRole("textbox", { name: "Message your group" }).fill("@everyone hello");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(run).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ message: "@everyone hello", requestAiResponse: false }),
    }),
  );
  await expect.element(screen.getByRole("textbox", { name: "Message your group" })).toHaveValue("");
  await screen.getByRole("button", { name: "Ask AI", exact: true }).click();
  await screen
    .getByRole("textbox", { name: "Message your group" })
    .fill("Please compare these ideas");
  await screen.getByRole("button", { name: "Send and ask AI" }).click();
  await vi.waitFor(() =>
    expect(run).toHaveBeenLastCalledWith({
      environmentId,
      input: expect.objectContaining({ requestAiResponse: true }),
    }),
  );
  await expect
    .element(screen.getByRole("button", { name: "Ask AI", exact: true }))
    .toHaveAttribute("aria-pressed", "false");
  await screen.getByRole("textbox", { name: "Message your group" }).fill("A follow-up note");
  await screen.getByRole("button", { name: "Send message", exact: true }).click();
  await vi.waitFor(() =>
    expect(run).toHaveBeenLastCalledWith({
      environmentId,
      input: expect.objectContaining({ message: "A follow-up note", requestAiResponse: false }),
    }),
  );
});

it("allows human conversation with no AI chats and explains why Ask AI is disabled", async () => {
  const run = setup(false);
  await using screen = await render(
    <SharedGroupConversation group={group} environmentId={environmentId} />,
  );
  await expect.element(screen.getByRole("button", { name: "Ask AI", exact: true })).toBeDisabled();
  await expect.element(screen.getByText("Bring a chat to enable Ask AI.")).toBeVisible();
  await screen.getByRole("textbox", { name: "Message your group" }).fill("Just us for now");
  await screen.getByRole("button", { name: "Send message", exact: true }).click();
  await vi.waitFor(() =>
    expect(run).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ message: "Just us for now", requestAiResponse: false }),
    }),
  );
});

it("keeps a failed message retry id but gives edited text a new id", async () => {
  const run = setup();
  const failure = AsyncResult.failure<SharedGroupView, Error>(
    Cause.fail(new Error("Message not confirmed")),
  );
  run.mockResolvedValueOnce(failure).mockResolvedValueOnce(failure);
  const decode = Schema.decodeUnknownSync(
    Schema.Struct({ input: Schema.Struct({ clientRequestId: Schema.String }) }),
  );
  await using screen = await render(
    <SharedGroupConversation group={group} environmentId={environmentId} />,
  );
  await screen.getByRole("textbox", { name: "Message your group" }).fill("Original note");
  await screen.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Message not confirmed");
  const originalId = decode(run.mock.calls[0]?.[0]).input.clientRequestId;
  await screen.getByRole("button", { name: "Send message", exact: true }).click();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(decode(run.mock.calls[1]?.[0]).input.clientRequestId).toBe(originalId);
  await screen.getByRole("textbox", { name: "Message your group" }).fill("Edited note");
  await screen.getByRole("button", { name: "Send message", exact: true }).click();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  expect(decode(run.mock.calls[2]?.[0]).input.clientRequestId).not.toBe(originalId);
});
