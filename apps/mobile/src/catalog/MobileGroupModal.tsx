import { useAtomValue } from "@effect/atom-react";
import { groupRecipients } from "@t3tools/client-runtime/group-chat";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, View } from "react-native";
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
import { GroupRunTranscript, GroupRunLoadMore, useGroupRunProjections } from "./GroupRunTranscript";
import { groupMessageProjection, unplacedGroupProjections } from "./groupConversationRows";
import { ConversationMessage } from "../components/ConversationMessage";
import { GroupConversationComposer } from "./GroupConversationComposer";
import { useGroupConversationComposer } from "./useGroupConversationComposer";
import { MobileGroupRoster } from "./MobileGroupRoster";

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
  const composer = useGroupConversationComposer({ environmentId, groupId, store });
  const [busy, setBusy] = useState(false);
  const [addingParticipants, setAddingParticipants] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectDetail = useSelectWorkspaceDetail();
  const snapshot = query.data?.group.visibility === "shared" ? null : query.data;
  const activity = useGroupRunProjections({
    environmentId,
    coordinatorEnvironmentId: environmentId,
    snapshot,
    address: { groupId },
  });
  const archived = snapshot?.group.archivedAt != null;
  const finish = (result: Awaited<ReturnType<typeof send>>) => {
    if (result._tag === "Success") return true;
    const cause = squashAtomCommandFailure(result);
    setError(cause instanceof Error ? cause.message : "The group action could not be completed.");
    return false;
  };
  const submit = async () => {
    if (
      busy ||
      !composer.hasContent ||
      !composer.ready ||
      !snapshot ||
      !store ||
      archived ||
      !sendAllowed
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const prepared = await composer.prepare();
      const addressing = groupRecipients(prepared.payload.message, snapshot.members);
      const result = await send({
        environmentId,
        input: {
          groupId,
          ...prepared.payload,
          ...(addressing.mentionEveryone
            ? { mentionEveryone: true }
            : addressing.recipientMemberIds.length
              ? { recipientMemberIds: addressing.recipientMemberIds }
              : {}),
        },
      });
      if (finish(result)) prepared.acknowledge();
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
  const canSend =
    !busy && composer.hasContent && composer.ready && !!snapshot && !archived && sendAllowed;
  const appendMention = (alias: string) =>
    composer.setText((text) => `${text}${text && !/\s$/.test(text) ? " " : ""}@${alias} `);
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
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Show participants"
              accessibilityState={{ expanded: rosterOpen }}
              onPress={() => setRosterOpen((open) => !open)}
              className="p-2"
            >
              <Text>Participants</Text>
            </Pressable>
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
          {query.error || error || draftError || composer.error ? (
            <Text accessibilityRole="alert" className="px-4 text-destructive">
              {error ?? draftError ?? composer.error ?? query.error}
            </Text>
          ) : null}
          <View className="min-h-0 flex-1">
            <FlatList
              style={{ flex: 1 }}
              data={snapshot?.messages ?? []}
              keyExtractor={(message) => message.id}
              contentContainerStyle={{ padding: 16, gap: 16 }}
              renderItem={({ item }) => {
                const projection = groupMessageProjection(activity.projections, item);
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
                    {projection ? (
                      <GroupRunTranscript
                        environmentId={environmentId}
                        projection={projection}
                        address={{ groupId }}
                      />
                    ) : (
                      <ConversationMessage
                        environmentId={environmentId}
                        text={item.text}
                        user={item.kind === "user"}
                        attachments={item.attachments}
                        context={item.context}
                      />
                    )}
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
                  {unplacedGroupProjections(activity.projections, snapshot?.messages ?? []).map(
                    (projection) => (
                      <View key={projection.deliveryId} className="gap-2 py-3">
                        <Text className="text-xs text-foreground-muted">
                          {snapshot?.members.find((member) => member.id === projection.memberId)
                            ?.alias ?? "Mine"}
                        </Text>
                        <GroupRunTranscript
                          environmentId={environmentId}
                          projection={projection}
                          address={{ groupId }}
                        />
                      </View>
                    ),
                  )}
                  <GroupRunLoadMore loader={activity} />
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
                  {snapshot
                    ? "Message your group to begin."
                    : "Connecting to the group’s computer…"}
                </Text>
              }
            />
            {rosterOpen ? (
              <MobileGroupRoster
                snapshot={snapshot}
                onClose={() => setRosterOpen(false)}
                disabled={!store || archived}
                onMention={(alias) => {
                  appendMention(alias);
                  setRosterOpen(false);
                }}
              >
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
                ) : null}
              </MobileGroupRoster>
            ) : null}
          </View>
          <GroupConversationComposer
            composer={composer}
            members={snapshot?.members ?? []}
            environmentId={environmentId}
            label="Message the group"
            disabled={archived}
            busy={busy}
            canSend={canSend}
            onSend={() => void submit()}
          >
            <Text className="text-xs text-foreground-muted">
              {draft.attempted
                ? "Retry send"
                : snapshot?.group.workflow === "team"
                  ? "Team"
                  : "Group"}
            </Text>
          </GroupConversationComposer>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
