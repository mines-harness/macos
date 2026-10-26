import { useAtomValue } from "@effect/atom-react";
import {
  minesAccountEnvironmentIdsAtom,
  minesAccountIdAtom,
} from "@t3tools/client-runtime/catalog";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { contactGroupMembershipInvitationId } from "@t3tools/shared/minesContacts";
import type { SharedContactGroup } from "@t3tools/contracts/contacts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { GroupSnapshot } from "@t3tools/contracts/groupChat";
import { useRef, useState } from "react";
import { Modal, Pressable, RefreshControl, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useWorkspaceState } from "../../state/workspace";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { groupCreate } from "../../state/groups";
import {
  sharedGroupCoordinator,
  sharedGroupAccountState,
  sharedGroupLeave,
} from "../../state/sharedGroups";
import { useEnvironmentQuery } from "../../state/query";
import { appAtomRegistry } from "../../state/atom-registry";
import { uuidv4 } from "../../lib/uuid";
import { ContactAvatar } from "./ContactAvatar";
import { ContactsAccountNotice } from "./ContactsRouteScreen";
import { useContacts } from "./useContacts";
import { SharedGroupModal } from "./SharedGroupModal";
import { checkSharedGroupHost, sharedGroupHostMatches } from "./sharedGroupHost";

export function SharedGroupsScreen() {
  const contacts = useContacts("threads");
  return <SharedGroupsContent key={contacts.accountId ?? "signed-out"} contacts={contacts} />;
}

function SharedGroupsContent({ contacts }: { readonly contacts: ReturnType<typeof useContacts> }) {
  const owned = useAtomValue(minesAccountEnvironmentIdsAtom);
  const { environments } = useWorkspaceState();
  const bottom = useWorkspaceTabs()?.bottomClearance ?? 24;
  const hosts = environments.filter(
    (host) => owned.has(host.environmentId) && host.connectionState === "connected",
  );
  const [selectedHost, setSelectedHost] = useState<EnvironmentId | null>(null);
  const host = hosts.find((host) => host.environmentId === selectedHost) ?? hosts[0];
  const hostAccount = useEnvironmentQuery(
    host ? sharedGroupAccountState({ environmentId: host.environmentId, input: {} }) : null,
  );
  const hostReady =
    hostAccount.isSuccess &&
    !hostAccount.isPending &&
    sharedGroupHostMatches(hostAccount.data, contacts.accountId);
  const [creating, setCreating] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const cleanup = useAtomCommand(sharedGroupLeave, { reportFailure: false });
  const loadHostAccount = useAtomQueryRunner(sharedGroupAccountState, {
    refresh: true,
    reportFailure: false,
  });
  const data = contacts.data;
  const openGroup = data?.groups.find((group) => group.key === openKey);
  if (!contacts.isSignedIn || !contacts.configured)
    return <ContactsAccountNotice configured={contacts.configured} title="Shared groups" />;
  return (
    <View className="flex-1 bg-screen">
      <ScrollView
        contentContainerClassName="gap-5 p-4"
        contentContainerStyle={{ paddingBottom: bottom + 24 }}
        refreshControl={
          <RefreshControl
            refreshing={contacts.pending && data !== null}
            onRefresh={() => void contacts.refresh()}
          />
        }
      >
        <View className="flex-row items-center justify-between gap-3">
          <Text accessibilityRole="header" className="text-xl font-mines-bold">
            Shared groups
          </Text>
          <Button
            label="New group"
            icon="plus"
            disabled={!hostReady || contacts.pending || !data}
            onPress={() => setCreating(true)}
          />
        </View>
        <Text className="text-foreground-muted">
          Chat with friends. Each person chooses which of their mines to bring.
        </Text>
        <Menu
          actions={hosts.map((host) => ({
            id: host.environmentId,
            title: host.environmentLabel,
            image: "desktopcomputer",
            state: host.environmentId === selectedHost ? "on" : "off",
          }))}
          onPressAction={({ nativeEvent }) => {
            const next = hosts.find((host) => host.environmentId === nativeEvent.event);
            if (next) {
              setSelectedHost(next.environmentId);
              setOpenKey(null);
            }
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Shared groups computer"
            className="flex-row items-center gap-2 self-start py-2"
          >
            <SymbolView name="desktopcomputer" size={18} tintColorClassName="accent-icon" />
            <Text>{host?.environmentLabel ?? "Connect a computer"} ▾</Text>
          </Pressable>
        </Menu>
        {contacts.error ? (
          <Text accessibilityRole="alert" className="text-danger-foreground">
            {contacts.error}
          </Text>
        ) : null}
        {!host ? (
          <Text className="text-foreground-muted">
            Connect one of your computers to open a group or bring a mine.
          </Text>
        ) : null}
        {host && !hostReady ? (
          <Text className="text-foreground-muted">
            {hostAccount.isPending
              ? "Checking this computer’s account…"
              : (hostAccount.error ??
                "Connect this computer to your current mines account to use shared groups.")}
          </Text>
        ) : null}
        {data?.groups.length === 0 ? (
          <Text className="text-foreground-muted">
            Create a group, or accept an invitation in Contacts.
          </Text>
        ) : null}
        {data?.groups.map((group) => (
          <SharedGroupCard
            key={group.key}
            group={group}
            contacts={contacts}
            canOpen={hostReady}
            onOpen={() => setOpenKey(group.key)}
            onLeave={async (invitationId) => {
              if (
                hostReady &&
                host &&
                appAtomRegistry.get(sharedGroupLeave.permissionAtom(host.environmentId))
              ) {
                try {
                  await checkSharedGroupHost(
                    host.environmentId,
                    contacts.accountId,
                    loadHostAccount,
                  );
                  await cleanup({
                    environmentId: host.environmentId,
                    input: { groupKey: group.key, coordinatorDeviceId: group.coordinatorDeviceId },
                  });
                } catch {
                  /* Membership can be left while this computer is unavailable. */
                }
              }
              if (await contacts.run((client) => client.respond(invitationId, "leave")))
                setOpenKey(null);
            }}
          />
        ))}
      </ScrollView>
      {creating && hostReady && host && contacts.accountId ? (
        <CreateSharedGroupModal
          key={`${contacts.accountId}:${host.environmentId}`}
          environmentId={host.environmentId}
          accountId={contacts.accountId}
          contacts={contacts}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {openGroup && hostReady && host && data ? (
        <SharedGroupModal
          key={`${contacts.accountId}:${host.environmentId}:${openGroup.key}`}
          environmentId={host.environmentId}
          group={openGroup}
          profile={data.profile}
          contacts={contacts}
          onClose={() => setOpenKey(null)}
        />
      ) : null}
    </View>
  );
}

function SharedGroupCard({
  group,
  contacts,
  canOpen,
  onOpen,
  onLeave,
}: {
  readonly group: SharedContactGroup;
  readonly contacts: ReturnType<typeof useContacts>;
  readonly canOpen: boolean;
  readonly onOpen: () => void;
  readonly onLeave: (invitationId: string) => Promise<void>;
}) {
  const [leaving, setLeaving] = useState(false);
  const data = contacts.data;
  if (!data) return null;
  const available = data.contacts.filter(
    (friend) => !group.members.some((member) => member.friendId === friend.friendId),
  );
  const pending = data.invitations.filter(
    (invite) =>
      invite.groupKey === group.key &&
      invite.status === "pending" &&
      invite.inviter.friendId === data.profile.friendId,
  );
  const membershipId = contactGroupMembershipInvitationId(
    group,
    data.profile.friendId,
    data.invitations,
  );
  const removable = group.members
    .filter((member) => member.friendId !== group.owner.friendId)
    .flatMap((member) => {
      const invitationId = contactGroupMembershipInvitationId(
        group,
        member.friendId,
        data.invitations,
      );
      return invitationId ? [{ member, invitationId }] : [];
    });
  return (
    <View className="gap-3 rounded-2xl border border-border p-4">
      <Pressable
        accessibilityRole="button"
        disabled={!canOpen}
        onPress={onOpen}
        className="flex-row items-center gap-3"
      >
        <SymbolView name="person.2" size={24} tintColorClassName="accent-icon" />
        <View className="min-w-0 flex-1 gap-1">
          <Text className="font-mines-bold">{group.groupName}</Text>
          <Text className="text-sm text-foreground-muted">
            {group.members.length} {group.members.length === 1 ? "person" : "people"}
          </Text>
        </View>
        <SymbolView name="chevron.right" size={14} tintColorClassName="accent-icon-muted" />
      </Pressable>
      <View className="flex-row items-center gap-2">
        {group.members.slice(0, 5).map((member) => (
          <ContactAvatar key={member.friendId} profile={member} size={28} />
        ))}
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={2}>
          {group.members.map((member) => member.displayName).join(", ")}
        </Text>
      </View>
      {group.owner.friendId === data.profile.friendId ? (
        <Menu
          actions={
            available.length
              ? available.map((friend) => ({
                  id: friend.friendId,
                  title: friend.displayName,
                  image: "person.badge.plus",
                  attributes: {
                    disabled:
                      contacts.pending ||
                      pending.some((invite) => invite.invitee.friendId === friend.friendId),
                  },
                }))
              : [{ id: "empty", title: "Add a contact first", attributes: { disabled: true } }]
          }
          onPressAction={({ nativeEvent }) => {
            if (!available.some((friend) => friend.friendId === nativeEvent.event)) return;
            void contacts.run((client) =>
              client.invite({
                clientRequestId: uuidv4(),
                friendId: nativeEvent.event,
                groupId: group.groupId,
                groupName: group.groupName,
                coordinatorEnvironmentId: group.coordinatorEnvironmentId,
                coordinatorDeviceId: group.coordinatorDeviceId,
              }),
            );
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Invite a friend to ${group.groupName}`}
            className="flex-row items-center gap-2 self-start py-2"
          >
            <SymbolView name="person.badge.plus" size={18} tintColorClassName="accent-icon" />
            <Text>Invite a friend</Text>
          </Pressable>
        </Menu>
      ) : null}
      {pending.map((invite) => (
        <View key={invite.id} className="flex-row items-center gap-3">
          <Text className="flex-1 text-sm text-foreground-muted">
            Invited {invite.invitee.displayName}
          </Text>
          <Button
            label="Revoke"
            tone="text"
            disabled={contacts.pending}
            onPress={() => void contacts.run((client) => client.respond(invite.id, "revoke"))}
          />
        </View>
      ))}
      {group.owner.friendId === data.profile.friendId && removable.length ? (
        <Menu
          actions={removable.map(({ member, invitationId }) => ({
            id: invitationId,
            title: `Remove ${member.displayName}`,
            image: "person.badge.minus",
            attributes: { destructive: true, disabled: contacts.pending },
          }))}
          onPressAction={({ nativeEvent }) => {
            if (removable.some((membership) => membership.invitationId === nativeEvent.event))
              void contacts.run((client) => client.respond(nativeEvent.event, "revoke"));
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Manage members of ${group.groupName}`}
            className="flex-row items-center gap-2 self-start py-2"
          >
            <SymbolView name="person.2" size={18} tintColorClassName="accent-icon" />
            <Text>Manage members</Text>
          </Pressable>
        </Menu>
      ) : null}
      {membershipId ? (
        <Button
          label="Leave group"
          tone="text"
          disabled={contacts.pending || leaving}
          onPress={() => {
            setLeaving(true);
            void onLeave(membershipId).finally(() => setLeaving(false));
          }}
        />
      ) : null}
    </View>
  );
}

function CreateSharedGroupModal({
  environmentId,
  accountId,
  contacts,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly accountId: string;
  readonly contacts: ReturnType<typeof useContacts>;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(uuidv4());
  const [created, setCreated] = useState<GroupSnapshot | null>(null);
  const create = useAtomCommand(groupCreate, { reportFailure: false });
  const permitted = useAtomValue(groupCreate.permissionAtom(environmentId));
  const coordinator = useAtomQueryRunner(sharedGroupCoordinator, {
    refresh: true,
    reportFailure: false,
  });
  const loadHostAccount = useAtomQueryRunner(sharedGroupAccountState, {
    refresh: true,
    reportFailure: false,
  });
  const current = () =>
    appAtomRegistry.get(minesAccountIdAtom) === accountId &&
    appAtomRegistry.get(minesAccountEnvironmentIdsAtom).has(environmentId);
  const submit = async () => {
    if (busy || !name.trim() || !permitted || !current()) return;
    setBusy(true);
    setError(null);
    try {
      const peer = await coordinator({ environmentId, input: {} });
      if (peer._tag !== "Success") throw squashAtomCommandFailure(peer);
      if (!current()) return;
      await checkSharedGroupHost(environmentId, accountId, loadHostAccount);
      let snapshot = created;
      if (!snapshot) {
        const result = await create({
          environmentId,
          input: {
            visibility: "shared",
            name: name.trim(),
            workflow: "team",
            members: [],
            clientRequestId: requestId.current,
          },
        });
        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
        snapshot = result.value;
        setCreated(snapshot);
      }
      if (!current()) return;
      const group = snapshot.group;
      const registered = await contacts.run((client) =>
        client.registerGroup({
          clientRequestId: requestId.current,
          groupId: group.id,
          groupName: group.name,
          coordinatorEnvironmentId: environmentId,
          coordinatorDeviceId: peer.value.device.deviceId,
        }),
      );
      if (registered) onClose();
      else setError("The group was created. Retry to finish sharing it.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The group could not be created.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView className="flex-1 gap-5 bg-screen p-5">
        <Text accessibilityRole="header" className="text-xl font-mines-bold">
          New shared group
        </Text>
        <AppTextInput
          accessibilityLabel="Shared group name"
          placeholder="Group name"
          value={name}
          onChangeText={setName}
          maxLength={120}
          editable={!busy && created === null}
        />
        <Text className="text-foreground-muted">
          Start with people. Everyone can bring their own mines later.
        </Text>
        {error || contacts.error ? (
          <Text accessibilityRole="alert" className="text-danger-foreground">
            {error ?? contacts.error}
          </Text>
        ) : null}
        <Button
          label="Create group"
          loading={busy}
          disabled={!name.trim() || !permitted}
          onPress={() => void submit()}
        />
        <Button label="Cancel" tone="text" disabled={busy} onPress={onClose} />
      </SafeAreaView>
    </Modal>
  );
}
