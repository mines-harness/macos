import type { ContactsSnapshot } from "@t3tools/contracts/contacts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { createContext, use } from "react";
import "~/index.css";
import { act, render } from "../../../test/render";
import { useMinesAuth } from "../../cloud/MinesAuthProvider";
import { ContactsPage } from "./ContactsPage";
import { ContactsProvider, useContacts } from "./ContactsProvider";

vi.mock("../../cloud/MinesAuthProvider", () => ({ useMinesAuth: vi.fn() }));
vi.mock("../../cloud/publicConfig", () => ({
  minesControlUrl: () => "https://contacts.example.test",
  hasMinesIdentityConfig: () => true,
}));
const profile = { friendId: "mines-11111111111111111111", displayName: "Alice", avatar: null };
const friend = { friendId: "mines-22222222222222222222", displayName: "Bob", avatar: null };
const invitation = {
  id: "invite-1",
  groupKey: "friend_group_key_01",
  groupId: "group-1",
  groupName: "Our group",
  coordinatorEnvironmentId: "home",
  coordinatorDeviceId: "a".repeat(43),
  inviter: friend,
  invitee: profile,
  status: "pending" as const,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};
function setup(accountId = "alice") {
  const auth = {
    isLoaded: true,
    isSignedIn: true,
    userId: accountId,
    user: {
      id: accountId,
      name: accountId,
      email: `${accountId}@example.test`,
      emailVerified: true,
    },
    error: null,
    getToken: vi.fn(async () => `token-${accountId}`),
    signIn: vi.fn(async () => {}),
    signUp: vi.fn(async () => true),
    signOut: vi.fn(async () => {}),
    requestPasswordReset: vi.fn(async () => {}),
    sendVerificationEmail: vi.fn(async () => {}),
    refreshSession: vi.fn(async () => {}),
    openAccount: vi.fn(),
  };
  const context = createContext(auth);
  vi.mocked(useMinesAuth).mockImplementation(() => use(context));
  return { auth, context };
}
function MembershipCount() {
  const { data } = useContacts();
  return <output aria-label="Joined groups">{data?.groups.length ?? 0}</output>;
}
function Harness() {
  return (
    <ContactsProvider>
      <ContactsPage />
      <MembershipCount />
    </ContactsProvider>
  );
}

it("adds a pasted friend ID and joins a group only after explicitly accepting its invitation", async () => {
  const session = setup();
  let data: ContactsSnapshot = { profile, contacts: [], invitations: [invitation], groups: [] };
  using fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/contacts/add") data = { ...data, contacts: [friend] };
    if (path.endsWith("/accept"))
      data = {
        ...data,
        invitations: [{ ...invitation, status: "accepted" }],
        groups: [
          {
            key: invitation.groupKey,
            groupId: invitation.groupId,
            groupName: invitation.groupName,
            coordinatorEnvironmentId: invitation.coordinatorEnvironmentId,
            coordinatorDeviceId: invitation.coordinatorDeviceId,
            owner: friend,
            members: [friend, profile],
            memberships: [{ invitationId: invitation.id, friendId: profile.friendId }],
          },
        ],
      };
    if (init?.method === "POST" && path === "/v1/contacts/add")
      expect(JSON.parse(String(init.body))).toEqual({ friendId: friend.friendId });
    return Response.json(data);
  });
  await using screen = await render(
    <session.context value={session.auth}>
      <Harness />
    </session.context>,
  );
  await expect.element(screen.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
  expect(fetcher.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
  await expect
    .element(screen.getByRole("status", { name: "Joined groups" }))
    .toHaveTextContent("0");
  await userEvent.type(
    screen.getByRole("textbox", { name: "Friend ID", exact: true }),
    `  ${friend.friendId}  `,
  );
  await screen.getByRole("button", { name: "Add friend", exact: true }).click();
  await expect
    .element(
      screen.getByRole("region", { name: "Your contacts" }).getByText("Bob", { exact: true }),
    )
    .toBeVisible();
  await screen.getByRole("button", { name: "Accept", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "Accept", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("status", { name: "Joined groups" }))
    .toHaveTextContent("1");
});

it("declines an invitation without joining and refreshes the account menu after saving a profile", async () => {
  const session = setup();
  const { auth } = session;
  let data: ContactsSnapshot = { profile, contacts: [], invitations: [invitation], groups: [] };
  using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/decline"))
      data = { ...data, invitations: [{ ...invitation, status: "declined" }] };
    if (path === "/v1/contacts/profile")
      data = { ...data, profile: { ...profile, ...JSON.parse(String(init?.body)) } };
    return Response.json(data);
  });
  await using screen = await render(
    <session.context value={session.auth}>
      <Harness />
    </session.context>,
  );
  await screen.getByRole("button", { name: "Decline", exact: true }).click();
  await expect.element(screen.getByText("No pending invitations.")).toBeVisible();
  await expect
    .element(screen.getByRole("status", { name: "Joined groups" }))
    .toHaveTextContent("0");
  await screen.getByRole("textbox", { name: "Display name" }).fill("Alice Updated");
  await screen.getByRole("button", { name: "Save profile" }).click();
  await vi.waitFor(() => expect(auth.refreshSession).toHaveBeenCalledOnce());
  await expect
    .element(screen.getByRole("textbox", { name: "Display name" }))
    .toHaveValue("Alice Updated");
});

it("does not display a previous account's delayed contact response after switching accounts", async () => {
  const session = setup();
  let finish!: (value: Response) => void;
  const oldResponse = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const next = { ...profile, friendId: "mines-33333333333333333333", displayName: "Carol" };
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_input, init) =>
      new Headers(init?.headers).get("authorization") === "Bearer token-alice"
        ? oldResponse
        : Response.json({ profile: next, contacts: [], invitations: [], groups: [] }),
    );
  await using screen = await render(
    <session.context value={session.auth}>
      <Harness />
    </session.context>,
  );
  await expect.element(screen.getByText("Loading contacts…")).toBeVisible();
  const nextAuth = { ...session.auth, userId: "carol", getToken: vi.fn(async () => "token-carol") };
  await screen.rerender(
    <session.context value={nextAuth}>
      <Harness />
    </session.context>,
  );
  await expect.element(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("Carol");
  await act(() =>
    finish(Response.json({ profile, contacts: [friend], invitations: [invitation], groups: [] })),
  );
  await expect.element(screen.getByText(next.friendId)).toBeVisible();
  await expect.element(screen.getByText(profile.friendId)).not.toBeInTheDocument();
  await expect.element(screen.getByText("Bob", { exact: true })).not.toBeInTheDocument();
});

it("uploads a bounded 64px profile thumbnail and adopts its canonical saved URL", async () => {
  const session = setup();
  let data: ContactsSnapshot = { profile, contacts: [], invitations: [], groups: [] };
  let uploaded: string | undefined;
  using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (new URL(String(input)).pathname === "/v1/contacts/profile") {
      const body: { displayName: string; avatar: string } = JSON.parse(String(init?.body));
      uploaded = body.avatar;
      data = {
        ...data,
        profile: {
          ...profile,
          avatar: "https://contacts.example.test/v1/contacts/avatars/me/version",
        },
      };
    }
    return Response.json(data);
  });
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.fillStyle = "#0088cc";
  context.fillRect(0, 0, 512, 256);
  const original = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Image encoding failed"))),
      "image/png",
    ),
  );
  await using screen = await render(
    <session.context value={session.auth}>
      <Harness />
    </session.context>,
  );
  await expect.element(screen.getByRole("textbox", { name: "Display name" })).toBeVisible();
  await userEvent.upload(
    screen.getByLabelText("Profile photo"),
    new File([original], "photo.png", { type: "image/png" }),
  );
  await expect.element(screen.getByRole("button", { name: "Save profile" })).toBeEnabled();
  await screen.getByRole("button", { name: "Save profile" }).click();
  await vi.waitFor(() => expect(uploaded).toMatch(/^data:image\/jpeg;base64,/));
  expect(uploaded!.length).toBeLessThanOrEqual(16_384);
  const bytes = Uint8Array.from(atob(uploaded!.split(",")[1]!), (character) =>
    character.charCodeAt(0),
  );
  const image = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  expect([image.width, image.height]).toEqual([64, 64]);
  image.close();
  await expect.element(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
  await expect.element(screen.getByText(profile.friendId)).toBeVisible();
});
