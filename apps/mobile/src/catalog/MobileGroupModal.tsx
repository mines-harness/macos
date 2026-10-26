import { useAtomValue } from "@effect/atom-react";
import { groupRecipients } from "@t3tools/client-runtime/group-chat";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { EnvironmentId } from "@t3tools/contracts";
import { GroupId } from "@t3tools/contracts/groupChat";
import { AppText as Text } from "../components/ui/AppText";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import {
  groupAddMembers,
  groupArchive,
  groupList,
  groupRetry,
  groupSend,
  groupStop,
  groupSubscription,
} from "../state/groups";
import { useSelectWorkspaceDetail } from "../features/workspace/useSelectWorkspaceDetail";
import { useGroupDraft } from "./useGroupDraft";
import { GroupParticipantsButton } from "./GroupParticipantsButton";
import { MobileGroupParticipantsModal } from "./MobileGroupParticipantsModal";

export function MobileGroupModal({
  environmentId: rawEnvironmentId,
  groupId: rawGroupId,
  onClose,
}: {
  environmentId: string;
  groupId: string;
  onClose: () => void;
}) {
  const environmentId = EnvironmentId.make(rawEnvironmentId);
  const groupId = GroupId.make(rawGroupId);
  const query = useEnvironmentQuery(groupSubscription({ environmentId, input: { groupId } }));
  const groups = useEnvironmentQuery(groupList({ environmentId, input: {} }));
  const send = useAtomCommand(groupSend, { reportFailure: false });
  const stop = useAtomCommand(groupStop, { reportFailure: false });
  const retry = useAtomCommand(groupRetry, { reportFailure: false });
  const archive = useAtomCommand(groupArchive, { reportFailure: false });
  const sendAllowed = useAtomValue(groupSend.permissionAtom(environmentId));
  const stopAllowed = useAtomValue(groupStop.permissionAtom(environmentId));
  const retryAllowed = useAtomValue(groupRetry.permissionAtom(environmentId));
  const archiveAllowed = useAtomValue(groupArchive.permissionAtom(environmentId));
  const addAllowed = useAtomValue(groupAddMembers.permissionAtom(environmentId));
  const { store, draft, error: draftError } = useGroupDraft(environmentId, groupId);
  const [busy, setBusy] = useState(false);
  const [addingParticipants, setAddingParticipants] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectDetail = useSelectWorkspaceDetail();
  const snapshot = query.data?.group.visibility === "shared" ? null : query.data;
  const archived = snapshot?.group.archivedAt != null;
  const finish = (result: Awaited<ReturnType<typeof send>>) => {
    if (result._tag === "Success") return true;
    const cause = squashAtomCommandFailure(result);
    setError(cause instanceof Error ? cause.message : "The group action could not be completed.");
    return false;
  };
  const submit = async () => {
    if (busy || !draft.text.trim() || !snapshot || !store || archived || !sendAllowed) return;
    setBusy(true);
    setError(null);
    const sent = store.markAttempted();
    try {
      await store.flush();
      const addressing = groupRecipients(sent.text, snapshot.members);
      const result = await send({
        environmentId,
        input: {
          groupId,
          message: sent.text,
          clientRequestId: sent.requestId,
          ...(addressing.mentionEveryone
            ? { mentionEveryone: true }
            : addressing.recipientMemberIds.length
              ? { recipientMemberIds: addressing.recipientMemberIds }
              : {}),
        },
      });
      if (finish(result)) store.acknowledge(sent.requestId);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Your draft could not be saved on this phone.",
      );
    } finally {
      setBusy(false);
    }
  };
  const runAction = async (action: () => ReturnType<typeof send>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      finish(await action());
    } finally {
      setBusy(false);
    }
  };
  const canSend = !busy && !!draft.text.trim() && !!snapshot && !!store && !archived && sendAllowed;
  const appendMention = (alias: string) =>
    store?.setText((text) => `${text}${text && !/\s$/.test(text) ? " " : ""}@${alias} `);
  if (addingParticipants && snapshot) {
    return (
      <MobileGroupParticipantsModal
        environmentId={environmentId}
        snapshot={snapshot}
        onClose={() => setAddingParticipants(false)}
        onSaved={() => setAddingParticipants(false)}
      />
    );
  }
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView className="flex-1 bg-background">
        <KeyboardAvoidingView
          className="flex-1"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View className="flex-row items-center gap-3 border-b border-border p-4">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close group"
              onPress={onClose}
              className="p-2"
            >
              <Text>Close</Text>
            </Pressable>
            <Text className="flex-1 text-lg font-semibold" numberOfLines={1}>
              {snapshot?.group.name ?? "Group chat"}
            </Text>
            {snapshot?.rounds.some((round) => round.status === "active") ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy || !stopAllowed}
                onPress={() => void runAction(() => stop({ environmentId, input: { groupId } }))}
                className="p-2"
              >
                <Text>Stop</Text>
              </Pressable>
            ) : null}
          </View>
          {query.data?.group.visibility === "shared" ? (
            <Text className="p-4 text-foreground-muted">
              Open this conversation from Shared groups.
            </Text>
          ) : null}
          {snapshot ? (
            <View className="flex-row items-center gap-3 px-4 py-2">
              <Text className="flex-1 text-xs text-muted-foreground">
                {archived
                  ? "Archived · member mines are available for other groups."
                  : "Archiving stops this group and releases its member mines."}
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={busy || !archiveAllowed}
                onPress={() =>
                  void runAction(async () => {
                    const result = await archive({
                      environmentId,
                      input: { groupId, archived: !archived },
                    });
                    if (result._tag === "Success") groups.refresh();
                    return result;
                  })
                }
                className="p-2"
              >
                <Text>{archived ? "Reopen" : "Archive"}</Text>
              </Pressable>
            </View>
          ) : null}
          {snapshot ? (
            <View className="px-4 py-2">
              <GroupParticipantsButton
                disabled={
                  busy ||
                  archived ||
                  !addAllowed ||
                  snapshot.members.length >= 12 ||
                  snapshot.rounds.some((round) => round.status === "active")
                }
                onPress={() => setAddingParticipants(true)}
              />
            </View>
          ) : null}
          <View className="flex-row flex-wrap gap-2 px-4 py-2">
            <Pressable
              accessibilityRole="button"
              disabled={!store || archived}
              onPress={() => appendMention("everyone")}
              className="rounded-full bg-muted px-3 py-2"
            >
              <Text className="text-xs">@everyone</Text>
            </Pressable>
            {snapshot?.members.map((member) => (
              <Pressable
                accessibilityRole="button"
                key={member.id}
                disabled={!store || archived}
                onPress={() => appendMention(member.alias)}
                className="rounded-full bg-muted px-3 py-2"
              >
                <Text className="text-xs">@{member.alias}</Text>
              </Pressable>
            ))}
          </View>
          {query.error || error || draftError ? (
            <Text accessibilityRole="alert" className="px-4 text-destructive">
              {error ?? draftError ?? query.error}
            </Text>
          ) : null}
          <FlatList
            data={snapshot?.messages ?? []}
            keyExtractor={(message) => message.id}
            contentContainerStyle={{ padding: 16, gap: 16 }}
            renderItem={({ item }) => {
              const member =
                snapshot?.rounds
                  .find((round) => round.id === item.roundId)
                  ?.members.find((candidate) => candidate.id === item.memberId) ??
                snapshot?.members.find((candidate) => candidate.id === item.memberId);
              return (
                <View>
                  <Text className="mb-1 text-xs text-muted-foreground">
                    {member?.alias ?? (item.kind === "user" ? "You" : "Group")}
                  </Text>
                  <Text selectable className="text-base leading-6">
                    {item.text}
                  </Text>
                  {member ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        onClose();
                        selectDetail({
                          name: "Thread",
                          params: {
                            environmentId: member.environmentId ?? environmentId,
                            threadId: member.threadId,
                          },
                        });
                      }}
                      className="py-2"
                    >
                      <Text className="text-xs text-primary">
                        {item.truncated
                          ? "Open complete reply in original mine"
                          : "Open original mine"}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            }}
            ListFooterComponent={
              <>
                {snapshot?.rounds.slice(-1).flatMap((round) =>
                  round.deliveries.map((delivery) => (
                    <View key={delivery.id} className="gap-2 py-2">
                      <Text className="text-xs text-muted-foreground">
                        {round.members.find((member) => member.id === delivery.memberId)?.alias} ·{" "}
                        {delivery.stage} · {delivery.status}
                      </Text>
                      {delivery.error ? (
                        <Text className="text-xs text-muted-foreground">{delivery.error}</Text>
                      ) : null}
                      {["failed", "unavailable"].includes(delivery.status) ? (
                        <Pressable
                          accessibilityRole="button"
                          disabled={busy || archived || !retryAllowed}
                          onPress={() =>
                            void runAction(() =>
                              retry({
                                environmentId,
                                input: { groupId, roundId: round.id, deliveryId: delivery.id },
                              }),
                            )
                          }
                          className="py-2"
                        >
                          <Text className="text-primary">Retry member</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  )),
                ) ?? null}
              </>
            }
            ListEmptyComponent={
              <Text className="py-8 text-center text-muted-foreground">
                {snapshot ? "Message your group to begin." : "Connecting to the group’s computer…"}
              </Text>
            }
          />
          <View className="gap-3 border-t border-border p-4">
            <TextInput
              accessibilityLabel="Message the group"
              multiline
              value={draft.text}
              onChangeText={(value) => store?.setText(value)}
              editable={!!store && !archived}
              placeholder={
                archived ? "Reopen this group to send a message" : "Message or mention a member…"
              }
              placeholderTextColor="#777"
              style={{ maxHeight: 160, minHeight: 48, color: "#fff" }}
              className="rounded-xl bg-muted p-3"
            />
            {draft.attempted ? (
              <Text className="text-xs text-muted-foreground">
                Retry uses the same request to avoid duplicate delivery. Clear draft only removes
                the text saved on this phone.
              </Text>
            ) : null}
            <View className="flex-row items-center gap-3">
              {draft.text ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    store?.clear();
                    setError(null);
                  }}
                  className="p-3"
                >
                  <Text>Clear draft</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSend }}
                disabled={!canSend}
                onPress={() => void submit()}
                className="flex-1 items-center rounded-xl bg-primary p-3"
              >
                <Text className="font-semibold text-primary-foreground">
                  {busy ? "Working…" : draft.attempted ? "Retry send" : "Send"}
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
