import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { Linking, Modal, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput } from "../components/ui/AppText";
import { ScreenScrollView } from "../components/ui/ScreenScrollView";
import { ListRow } from "../components/ui/ListRow";
import {
  cloudFollowUp,
  cloudLink,
  cloudRefresh,
  cloudSnapshot,
  cloudStatus,
  cloudSubmit,
} from "../state/cloudTasks";
import { useProjects } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironments } from "../state/environments";
import { uuidv4 } from "../lib/uuid";

export function MobileCloudModal({
  environmentId: rawEnvironmentId,
  targetId,
  onClose,
}: {
  environmentId: string;
  targetId: string;
  onClose: () => void;
}) {
  const environmentId = EnvironmentId.make(rawEnvironmentId);
  const query = useEnvironmentQuery(cloudSnapshot({ environmentId, input: {} }));
  const environment = useEnvironments().environments.find(
    (entry) => entry.environmentId === environmentId,
  );
  const project = useProjects().find((entry) => entry.environmentId === environmentId);
  const target = query.data?.targets.find((entry) => entry.id === targetId);
  const tasks = (query.data?.tasks.filter((entry) => entry.targetId === targetId) ?? []).sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = tasks.find((task) => task.id === selectedId);
  const [cwd, setCwd] = useState("");
  const [providerEnvironment, setProviderEnvironment] = useState("");
  const [prompt, setPrompt] = useState("");
  const [url, setUrl] = useState("");
  const [requestId, setRequestId] = useState(uuidv4);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const submit = useAtomCommand(cloudSubmit, { reportFailure: false });
  const followUp = useAtomCommand(cloudFollowUp, { reportFailure: false });
  const link = useAtomCommand(cloudLink, { reportFailure: false });
  const refresh = useAtomCommand(cloudRefresh, { reportFailure: false });
  const status = useAtomCommand(cloudStatus, { reportFailure: false });
  const submitPermission = useAtomValue(cloudSubmit.permissionAtom(environmentId));
  const followPermission = useAtomValue(cloudFollowUp.permissionAtom(environmentId));
  const linkPermission = useAtomValue(cloudLink.permissionAtom(environmentId));
  const listPermission = useAtomValue(cloudRefresh.permissionAtom(environmentId));
  const statusPermission = useAtomValue(cloudStatus.permissionAtom(environmentId));
  const connected = environment?.connection.phase === "connected";
  const nativeReady = connected && target?.bridgeStatus === "available";
  const workspace = cwd || project?.workspaceRoot || "";
  const finish = (result: { readonly _tag: string; readonly cause?: unknown }) => {
    if (result._tag === "Success") {
      query.refresh();
      return true;
    }
    const error = result.cause ? Cause.squash(result.cause as Cause.Cause<unknown>) : null;
    setMessage(error instanceof Error ? error.message : "The cloud action could not be completed.");
    return false;
  };
  const send = async () => {
    if (busy || !prompt.trim()) return;
    setBusy(true);
    setMessage(null);
    const result = selected
      ? await followUp({ environmentId, input: { requestId, taskId: selected.id, prompt } })
      : await submit({
          environmentId,
          input: {
            requestId,
            targetId,
            cwd: workspace,
            prompt,
            ...(target?.provider === "codex" ? { environmentId: providerEnvironment } : {}),
          },
        });
    if (finish(result) && result._tag === "Success") {
      setPrompt("");
      setRequestId(uuidv4());
      setMessage(
        result.value.status === "submission-unknown"
          ? "Delivery is unconfirmed. Open the provider before sending again."
          : "Sent to the provider. Open the cloud task to read the complete conversation.",
      );
    }
    setBusy(false);
  };
  const updateDraft = (change: () => void) => {
    change();
    setRequestId(uuidv4());
    setMessage(null);
  };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-row items-center gap-3 border-b border-border p-4">
          <Pressable accessibilityRole="button" onPress={onClose} className="p-2">
            <Text>Close</Text>
          </Pressable>
          <Text className="flex-1 text-lg font-semibold" numberOfLines={1}>
            {target?.label ?? "Cloud device"}
          </Text>
        </View>
        <ScreenScrollView
          className="flex-1"
          contentContainerStyle={{ padding: 16, gap: 16 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text className="text-sm text-foreground-muted">
            Tasks execute on the provider's cloud.{" "}
            {nativeReady
              ? "Your computer's CLI bridge is connected."
              : "Connect your computer to control tasks from mines."}
          </Text>
          {target?.reason ? (
            <Text className="text-xs text-foreground-muted">{target.reason}</Text>
          ) : null}
          {query.error || message ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
              {message ?? query.error}
            </Text>
          ) : null}
          {target?.capabilities.list ? (
            <ListRow
              label="Refresh cloud tasks"
              disabled={busy || !nativeReady || !listPermission}
              onPress={() => {
                setBusy(true);
                void refresh({ environmentId, input: { targetId } }).then((result) => {
                  finish(result);
                  setBusy(false);
                });
              }}
            />
          ) : null}
          {tasks.map((task) => (
            <ListRow
              key={task.id}
              label={task.title}
              description={
                task.status === "submission-unknown"
                  ? "Check delivery with provider"
                  : task.status === "submitted"
                    ? "Sent to cloud"
                    : task.status === "linked"
                      ? "Linked · progress unknown"
                      : task.status
              }
              onPress={() => updateDraft(() => setSelectedId(task.id))}
            />
          ))}
          {selected ? (
            <View className="gap-2">
              <Text className="font-semibold">{selected.title}</Text>
              {selected.summary ? (
                <Text className="text-sm text-foreground-muted">{selected.summary}</Text>
              ) : null}
              {selected.url ? (
                <ListRow
                  label="Open complete task at provider"
                  onPress={() => {
                    void Linking.openURL(selected.url!);
                  }}
                />
              ) : null}
              {target?.capabilities.status && selected.providerTaskId ? (
                <ListRow
                  label="Check task status"
                  disabled={busy || !nativeReady || !statusPermission}
                  onPress={() => {
                    setBusy(true);
                    void status({ environmentId, input: { taskId: selected.id } }).then(
                      (result) => {
                        finish(result);
                        setBusy(false);
                      },
                    );
                  }}
                />
              ) : null}
              <ListRow
                label="Start a new cloud task"
                onPress={() => updateDraft(() => setSelectedId(null))}
              />
            </View>
          ) : null}
          {!selected ? (
            <>
              <Text className="font-semibold">New cloud task</Text>
              <AppTextInput
                accessibilityLabel="Computer repository folder"
                placeholder="Repository path on your computer"
                value={workspace}
                onChangeText={(value) => updateDraft(() => setCwd(value))}
                autoCapitalize="none"
                autoCorrect={false}
                className="rounded-xl bg-grouped-card p-3 text-foreground"
              />
              {target?.provider === "codex" ? (
                <AppTextInput
                  accessibilityLabel="Codex cloud environment ID"
                  placeholder="Codex environment ID"
                  value={providerEnvironment}
                  onChangeText={(value) => updateDraft(() => setProviderEnvironment(value))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="rounded-xl bg-grouped-card p-3 text-foreground"
                />
              ) : (
                <Text className="text-xs text-foreground-muted">
                  Claude may upload your repository, history and tracked changes to its cloud.
                  Verify the folder before submitting.
                </Text>
              )}
            </>
          ) : null}
          {!selected || (target?.capabilities.followUp && selected.providerTaskId) ? (
            <>
              <AppTextInput
                accessibilityLabel={selected ? "Cloud follow-up" : "Cloud prompt"}
                placeholder={
                  selected
                    ? "Follow up on this cloud task…"
                    : "What should this cloud device work on?"
                }
                multiline
                value={prompt}
                onChangeText={(value) => updateDraft(() => setPrompt(value))}
                className="min-h-24 rounded-xl bg-grouped-card p-3 text-foreground"
              />
              <ListRow
                label={busy ? "Sending…" : selected ? "Send follow-up" : "Run in provider cloud"}
                disabled={
                  busy ||
                  !nativeReady ||
                  !prompt.trim() ||
                  (selected
                    ? !followPermission
                    : !submitPermission ||
                      !workspace ||
                      !target?.capabilities.submit ||
                      (target.provider === "codex" && !providerEnvironment.trim()))
                }
                onPress={() => {
                  void send();
                }}
              />
            </>
          ) : null}
          <Text className="font-semibold">Link an existing task</Text>
          <AppTextInput
            accessibilityLabel="Provider task URL"
            placeholder="Paste a provider task URL"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            className="rounded-xl bg-grouped-card p-3 text-foreground"
          />
          <ListRow
            label="Save task link"
            disabled={busy || !connected || !url.trim() || !linkPermission}
            onPress={() => {
              setBusy(true);
              void link({ environmentId, input: { targetId, url } }).then((result) => {
                if (finish(result)) setUrl("");
                setBusy(false);
              });
            }}
          />
          <Text className="text-xs text-foreground-muted">
            Full conversations and stopping tasks stay in the provider's app. Review and apply Codex
            changes from mines on your computer.
          </Text>
        </ScreenScrollView>
      </SafeAreaView>
    </Modal>
  );
}
