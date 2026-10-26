import { useAtomValue } from "@effect/atom-react";
import { catalogHostId } from "@t3tools/client-runtime/catalog";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId } from "@t3tools/contracts";
import type { GroupMemberInput, GroupSnapshot } from "@t3tools/contracts/groupChat";
import { useRef, useState } from "react";
import { FlatList, Modal, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { SymbolView } from "../components/ui/AppSymbol";
import { uuidv4 } from "../lib/uuid";
import { useThreadShells } from "../state/entities";
import { groupAddMembers, groupCreate, groupHostRoutes, groupList } from "../state/groups";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { useWorkspaceState } from "../state/workspace";
import { availableGroupParticipants, groupMemberKey, nextGroupAlias } from "./groupParticipants";
import { useMinesCatalog } from "./useMinesCatalog";

type MemberInput = typeof GroupMemberInput.Type;

export function MobileGroupParticipantsModal({
  environmentId,
  snapshot,
  onClose,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot?: GroupSnapshot;
  readonly onClose: () => void;
  readonly onSaved: (snapshot: GroupSnapshot) => void;
}) {
  const threads = useThreadShells();
  const { environments } = useWorkspaceState();
  const routes = useEnvironmentQuery(groupHostRoutes({ environmentId, input: {} }));
  const groups = useEnvironmentQuery(groupList({ environmentId, input: {} }));
  const add = useAtomCommand(groupAddMembers, { reportFailure: false });
  const create = useAtomCommand(groupCreate, { reportFailure: false });
  const addAllowed = useAtomValue(groupAddMembers.permissionAtom(environmentId));
  const createAllowed = useAtomValue(groupCreate.permissionAtom(environmentId));
  const { catalog } = useMinesCatalog();
  const [members, setMembers] = useState<ReadonlyArray<MemberInput>>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(uuidv4());
  const occupiedKeys = new Set([
    ...(snapshot?.members.map((member) =>
      groupMemberKey(member.environmentId ?? environmentId, member.threadId),
    ) ?? []),
    ...(groups.data?.memberships.map((member) =>
      groupMemberKey(member.environmentId ?? environmentId, member.threadId),
    ) ?? []),
  ]);
  const available = availableGroupParticipants({
    threads,
    environmentId,
    routedHosts: new Set(routes.data?.routes.map((route) => route.environmentId) ?? []),
    connectedHosts: new Set(
      environments
        .filter((host) => host.connectionState === "connected")
        .map((host) => host.environmentId),
    ),
    occupiedKeys,
  });
  const availableKeys = new Set(
    available.map((thread) => groupMemberKey(thread.environmentId, thread.id)),
  );
  const selectedKeys = new Set(
    members.map((member) => groupMemberKey(member.environmentId ?? environmentId, member.threadId)),
  );
  const capacity = 12 - (snapshot?.members.length ?? 0);
  const canSave =
    !busy &&
    snapshot?.group.visibility !== "shared" &&
    !!groups.data &&
    (snapshot ? addAllowed : createAllowed) &&
    members.length > 0 &&
    members.length <= capacity &&
    members.every((member) =>
      availableKeys.has(groupMemberKey(member.environmentId ?? environmentId, member.threadId)),
    );
  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const result = snapshot
        ? await add({
            environmentId,
            input: { groupId: snapshot.group.id, members, clientRequestId: requestId.current },
          })
        : await create({
            environmentId,
            input: {
              name: name.trim() || "Group chat",
              workflow: "team",
              members,
              clientRequestId: requestId.current,
            },
          });
      if (result._tag !== "Success") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not update participants.");
        return;
      }
      if (result.value.group.visibility !== "shared")
        catalog?.upsert({
          id: catalogHostId("group", environmentId, result.value.group.id),
          kind: "group",
          title: result.value.group.name,
          hostRef: { environmentId, entityId: result.value.group.id },
        });
      groups.refresh();
      onSaved(result.value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update participants.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView className="flex-1 bg-screen">
        <View className="flex-row items-center gap-3 border-b border-border p-4">
          <Button label="Cancel" tone="text" disabled={busy} onPress={onClose} />
          <Text className="flex-1 text-lg font-mines-bold text-foreground">Add participants</Text>
        </View>
        <FlatList
          data={available}
          keyExtractor={(thread) => groupMemberKey(thread.environmentId, thread.id)}
          contentContainerStyle={{ padding: 20, gap: 8 }}
          ListHeaderComponent={
            <View className="gap-4 pb-4">
              {!snapshot ? (
                <AppTextInput
                  accessibilityLabel="Group name"
                  placeholder="Group name"
                  value={name}
                  maxLength={120}
                  onChangeText={(value) => {
                    setName(value);
                    requestId.current = uuidv4();
                  }}
                  editable={!busy}
                  className="rounded-xl bg-grouped-card p-4 text-foreground"
                />
              ) : null}
              <Text className="text-sm text-foreground-muted">
                Choose existing mines. Each keeps its model, workspace, and memory.
              </Text>
              <Text className="text-xs text-foreground-muted">
                {members.length} selected · {capacity} places available
              </Text>
              {error || groups.error || routes.error ? (
                <Text accessibilityRole="alert" className="text-danger-foreground">
                  {error ?? groups.error ?? routes.error}
                </Text>
              ) : null}
            </View>
          }
          renderItem={({ item: thread }) => {
            const key = groupMemberKey(thread.environmentId, thread.id);
            const selected = selectedKeys.has(key);
            const disabled = busy || (!selected && members.length >= capacity);
            return (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected, disabled }}
                disabled={disabled}
                onPress={() => {
                  setMembers((current) =>
                    selected
                      ? current.filter(
                          (member) =>
                            groupMemberKey(
                              member.environmentId ?? environmentId,
                              member.threadId,
                            ) !== key,
                        )
                      : [
                          ...current,
                          {
                            threadId: thread.id,
                            environmentId: thread.environmentId,
                            alias: nextGroupAlias(thread.title, [
                              ...(snapshot?.members ?? []),
                              ...current,
                            ]),
                          },
                        ],
                  );
                  requestId.current = uuidv4();
                  setError(null);
                }}
                className="min-h-14 flex-row items-center gap-3 rounded-xl bg-grouped-card p-3 disabled:opacity-40"
              >
                <SymbolView
                  name={selected ? "checkmark.circle.fill" : "circle"}
                  size={22}
                  tintColorClassName="accent-foreground"
                />
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={1} className="font-mines-medium text-foreground">
                    {thread.title}
                  </Text>
                  <Text numberOfLines={1} className="text-xs text-foreground-muted">
                    {environments.find((host) => host.environmentId === thread.environmentId)
                      ?.environmentLabel ?? "Computer"}{" "}
                    · {thread.modelSelection.model}
                  </Text>
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <Text className="py-6 text-center text-foreground-muted">
              {groups.isPending
                ? "Loading mines…"
                : "No available mines on this computer or its connected group computers."}
            </Text>
          }
        />
        <View className="border-t border-border p-4">
          <Button
            label={snapshot ? "Add participants" : "Create group"}
            tone="primary"
            fullWidth
            disabled={!canSave}
            loading={busy}
            onPress={() => {
              void save();
            }}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}
