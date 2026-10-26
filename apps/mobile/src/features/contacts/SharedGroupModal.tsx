import { useAtomValue } from "@effect/atom-react";
import { minesAccountEnvironmentIdsAtom } from "@t3tools/client-runtime/catalog";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { contactGroupMembershipInvitationId } from "@t3tools/shared/minesContacts";
import type { ContactProfile, SharedContactGroup } from "@t3tools/contracts/contacts";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { GroupMemberInput, GroupSnapshot } from "@t3tools/contracts/groupChat";
import { useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { Menu } from "../../components/ui/Menu";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useThreadShells } from "../../state/entities";
import {
  sharedGroupAccountState,
  sharedGroupAddChats,
  sharedGroupLeave,
  sharedGroupRemoveChats,
  sharedGroupSend,
  sharedGroupSubscription,
} from "../../state/sharedGroups";
import { useGroupDraft } from "../../catalog/useGroupDraft";
import { nextGroupAlias } from "../../catalog/groupParticipants";
import { uuidv4 } from "../../lib/uuid";
import { ContactAvatar } from "./ContactAvatar";
import type { useContacts } from "./useContacts";
import { checkSharedGroupHost } from "./sharedGroupHost";

export function SharedGroupModal({
  environmentId,
  group,
  profile,
  contacts,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly group: SharedContactGroup;
  readonly profile: ContactProfile;
  readonly contacts: ReturnType<typeof useContacts>;
  readonly onClose: () => void;
}) {
  const address = { groupKey: group.key, coordinatorDeviceId: group.coordinatorDeviceId };
  const query = useEnvironmentQuery(sharedGroupSubscription({ environmentId, input: address }));
  const send = useAtomCommand(sharedGroupSend, { reportFailure: false });
  const leave = useAtomCommand(sharedGroupLeave, { reportFailure: false });
  const sendAllowed = useAtomValue(sharedGroupSend.permissionAtom(environmentId));
  const leaveAllowed = useAtomValue(sharedGroupLeave.permissionAtom(environmentId));
  const addAllowed = useAtomValue(sharedGroupAddChats.permissionAtom(environmentId));
  const loadHostAccount = useAtomQueryRunner(sharedGroupAccountState, {
    refresh: true,
    reportFailure: false,
  });
  const { store, draft, error: draftError } = useGroupDraft(environmentId, `shared:${group.key}`);
  const [askAi, setAskAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = query.data;
  const snapshot = view?.snapshot;
  const online = view?.status === "online" && !!snapshot;
  const archived = snapshot?.group.archivedAt != null;
  const canAskAi = !!snapshot?.members.length;
  const membershipId = contactGroupMembershipInvitationId(
    group,
    profile.friendId,
    contacts.data?.invitations ?? [],
  );
  const submit = async () => {
    if (busy || !online || archived || !store || !draft.text.trim() || !sendAllowed) return;
    setBusy(true);
    setError(null);
    const sent = store.markAttempted();
    try {
      await store.flush();
      await checkSharedGroupHost(environmentId, contacts.accountId, loadHostAccount);
      const result = await send({
        environmentId,
        input: {
          ...address,
          message: sent.text,
          clientRequestId: sent.requestId,
          requestAiResponse: askAi && canAskAi,
        },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      store.acknowledge(sent.requestId);
      setAskAi(false);
      query.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message could not be sent.");
    } finally {
      setBusy(false);
    }
  };
  const leaveGroup = async () => {
    if (busy || !membershipId || !leaveAllowed) return;
    setBusy(true);
    setError(null);
    try {
      await checkSharedGroupHost(environmentId, contacts.accountId, loadHostAccount);
      const result = await leave({ environmentId, input: address });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      if (await contacts.run((client) => client.respond(membershipId, "leave"))) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The group could not be left.");
    } finally {
      setBusy(false);
    }
  };
  if (adding && snapshot)
    return (
      <SharedGroupMinesPicker
        accountId={contacts.accountId}
        environmentId={environmentId}
        group={group}
        snapshot={snapshot}
        selectedThreadIds={view?.selectedThreadIds ?? []}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          query.refresh();
        }}
      />
    );
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView className="flex-1 bg-screen">
        <KeyboardAvoidingView
          className="flex-1"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View className="flex-row items-center gap-3 border-b border-border px-4 py-3">
            <Button label="Close" tone="text" onPress={onClose} />
            <Text className="min-w-0 flex-1 text-lg font-mines-bold" numberOfLines={1}>
              {group.groupName}
            </Text>
            {membershipId ? (
              <Menu
                actions={[
                  {
                    id: "leave",
                    title: "Leave group",
                    image: "rectangle.portrait.and.arrow.right",
                    attributes: { destructive: true, disabled: busy || !leaveAllowed },
                  },
                ]}
                onPressAction={({ nativeEvent }) => {
                  if (nativeEvent.event === "leave") void leaveGroup();
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Group options"
                  className="p-2"
                >
                  <SymbolView name="ellipsis" size={20} tintColorClassName="accent-icon" />
                </Pressable>
              </Menu>
            ) : null}
          </View>
          <View className="flex-row items-center gap-2 px-4 py-3">
            {group.members.slice(0, 6).map((member) => (
              <ContactAvatar key={member.friendId} profile={member} size={28} />
            ))}
            <View className="flex-1" />
            <Button
              label="Your mines"
              icon="plus"
              disabled={!online || archived || busy || !addAllowed}
              onPress={() => setAdding(true)}
            />
          </View>
          {!online ? (
            <View className="gap-2 px-4 pb-3">
              <Text className="text-foreground-muted">
                {query.isPending
                  ? "Connecting to the group…"
                  : "The coordinator is offline. Your draft stays on this phone."}
              </Text>
              <Button label="Reconnect" tone="text" onPress={query.refresh} />
            </View>
          ) : null}
          {archived ? (
            <Text className="px-4 pb-3 text-foreground-muted">This group is archived.</Text>
          ) : null}
          {error || query.error || draftError || contacts.error ? (
            <Text accessibilityRole="alert" className="px-4 text-danger-foreground">
              {error ?? query.error ?? draftError ?? contacts.error}
            </Text>
          ) : null}
          <FlatList
            data={snapshot?.messages ?? []}
            keyExtractor={(message) => message.id}
            contentContainerStyle={{ padding: 16, gap: 16 }}
            renderItem={({ item }) => {
              const author =
                item.authorFriendId === profile.friendId
                  ? profile
                  : group.members.find((member) => member.friendId === item.authorFriendId);
              const mine = snapshot?.members.find((member) => member.id === item.memberId);
              return (
                <View className="gap-2">
                  <View className="flex-row items-center gap-2">
                    {author && item.kind === "user" ? (
                      <ContactAvatar profile={author} size={24} />
                    ) : null}
                    <Text className="text-xs text-foreground-muted">
                      {item.kind === "user"
                        ? (author?.displayName ?? "Member")
                        : (mine?.alias ?? "Group")}
                    </Text>
                  </View>
                  <Text selectable>{item.text}</Text>
                </View>
              );
            }}
          />
          <View className="gap-3 border-t border-border p-4">
            <AppTextInput
              accessibilityLabel="Shared group message"
              multiline
              value={draft.text}
              onChangeText={(value) => store?.setText(value)}
              placeholder="Message the group"
              editable={!busy && !!store}
              maxLength={120_000}
            />
            <View className="flex-row items-center gap-2">
              <SymbolView name="brain" size={18} tintColorClassName="accent-icon" />
              <Text className="flex-1 font-mines-medium">Ask AI</Text>
              <ThemedSwitch
                accessibilityLabel="Ask AI"
                value={askAi && canAskAi}
                disabled={busy || !canAskAi}
                onValueChange={setAskAi}
              />
            </View>
            <Text className="text-xs text-foreground-muted">
              {canAskAi
                ? "Turn on Ask AI when you want a mine to respond."
                : "Bring a mine to the group to enable Ask AI."}
            </Text>
            <Button
              label="Send"
              disabled={busy || !online || archived || !store || !draft.text.trim() || !sendAllowed}
              loading={busy}
              onPress={() => void submit()}
            />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function SharedGroupMinesPicker({
  accountId,
  environmentId,
  group,
  snapshot,
  selectedThreadIds,
  onClose,
  onSaved,
}: {
  readonly accountId: string | null;
  readonly environmentId: EnvironmentId;
  readonly group: SharedContactGroup;
  readonly snapshot: GroupSnapshot;
  readonly selectedThreadIds: readonly ThreadId[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const owned = useAtomValue(minesAccountEnvironmentIdsAtom);
  const threads = useThreadShells().filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.lineage.relationshipToParent !== "subagent" &&
      (thread.archivedAt === null || selectedThreadIds.includes(thread.id)),
  );
  const [selected, setSelected] = useState(() => new Set(selectedThreadIds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(uuidv4());
  const add = useAtomCommand(sharedGroupAddChats, { reportFailure: false });
  const remove = useAtomCommand(sharedGroupRemoveChats, { reportFailure: false });
  const addAllowed = useAtomValue(sharedGroupAddChats.permissionAtom(environmentId));
  const removeAllowed = useAtomValue(sharedGroupRemoveChats.permissionAtom(environmentId));
  const loadHostAccount = useAtomQueryRunner(sharedGroupAccountState, {
    refresh: true,
    reportFailure: false,
  });
  const additions = threads.filter(
    (thread) => selected.has(thread.id) && !selectedThreadIds.includes(thread.id),
  );
  const removals = selectedThreadIds.filter((id) => !selected.has(id));
  const valid =
    owned.has(environmentId) &&
    (!additions.length || addAllowed) &&
    (!removals.length || removeAllowed) &&
    snapshot.members.length - removals.length + additions.length <= 12;
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const address = { groupKey: group.key, coordinatorDeviceId: group.coordinatorDeviceId };
    try {
      if (removals.length) {
        await checkSharedGroupHost(environmentId, accountId, loadHostAccount);
        const result = await remove({ environmentId, input: { ...address, threadIds: removals } });
        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      }
      if (additions.length) {
        await checkSharedGroupHost(environmentId, accountId, loadHostAccount);
        const aliases = snapshot.members.map((member) => ({ alias: member.alias }));
        const members: Array<typeof GroupMemberInput.Type> = additions.map((thread) => {
          const alias = nextGroupAlias(thread.title, aliases);
          aliases.push({ alias });
          return { threadId: thread.id, alias };
        });
        const result = await add({
          environmentId,
          input: { ...address, members, clientRequestId: requestId.current },
        });
        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The selected mines could not be updated.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView className="flex-1 bg-screen">
        <View className="flex-row items-center gap-3 p-4">
          <Button label="Cancel" tone="text" disabled={busy} onPress={onClose} />
          <Text accessibilityRole="header" className="flex-1 text-lg font-mines-bold">
            Your mines
          </Text>
          <Button label="Save" loading={busy} disabled={!valid} onPress={() => void save()} />
        </View>
        <Text className="px-4 pb-4 text-foreground-muted">
          Only mines on your selected computer can be added. They keep their workspace and
          permissions.
        </Text>
        {error ? (
          <Text accessibilityRole="alert" className="px-4 text-danger-foreground">
            {error}
          </Text>
        ) : null}
        <FlatList
          data={owned.has(environmentId) ? threads : []}
          keyExtractor={(thread) => thread.id}
          contentContainerStyle={{ padding: 16, gap: 8 }}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel={item.title}
              accessibilityState={{ checked: selected.has(item.id) }}
              disabled={busy}
              onPress={() => {
                requestId.current = uuidv4();
                setSelected((current) => {
                  const next = new Set(current);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  return next;
                });
              }}
              className="flex-row items-center gap-3 rounded-xl bg-subtle p-4"
            >
              <Text className="flex-1">{item.title}</Text>
              {selected.has(item.id) ? (
                <SymbolView name="checkmark" size={20} tintColorClassName="accent-icon" />
              ) : null}
            </Pressable>
          )}
          ListEmptyComponent={
            <Text className="text-foreground-muted">No existing mines on this computer.</Text>
          }
        />
      </SafeAreaView>
    </Modal>
  );
}
