import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { minesAccountIdAtom } from "@t3tools/client-runtime/catalog";
import {
  cancelMineTransfer,
  transferMine,
  type MineTransferClient,
  type MineTransferProgress,
  type MineTransferRequest,
} from "@t3tools/client-runtime/mine-transfer";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Modal, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { openMobilePrivateStore } from "../../catalog/encryptedStorage";
import { AppText as Text } from "../../components/ui/AppText";
import { ListRow } from "../../components/ui/ListRow";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { mineTransferCommands } from "../../state/mine-transfer";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { createMineTransferJournal } from "./mineTransferJournal";

const STAGE_LABEL: Record<MineTransferProgress["stage"], string> = {
  checking: "Checking the destination…",
  pausing: "Pausing and saving this mine…",
  copying: "Copying project files…",
  starting: "Starting on the destination…",
  finishing: "Finishing the transfer…",
  complete: "Transfer complete",
};

function transferPermissions(environmentId: EnvironmentId, role: "source" | "destination") {
  return Atom.make((get) => {
    const commands =
      role === "source"
        ? [
            mineTransferCommands.prepare,
            mineTransferCommands.readChunk,
            mineTransferCommands.finalize,
          ]
        : [
            mineTransferCommands.preflight,
            mineTransferCommands.begin,
            mineTransferCommands.writeChunk,
            mineTransferCommands.accept,
          ];
    return commands.every((command) => get(command.permissionAtom(environmentId)));
  });
}

function DestinationRow(props: {
  readonly environment: EnvironmentPresentation;
  readonly disabled: boolean;
  readonly onSelect: (environmentId: EnvironmentId) => void;
}) {
  const id = props.environment.environmentId;
  const permissionAtom = useMemo(() => transferPermissions(id, "destination"), [id]);
  const allowed = useAtomValue(permissionAtom);
  const connected = props.environment.connection.phase === "connected";
  const supported = props.environment.serverConfig?.environment.capabilities.mineTransfer === true;
  return (
    <ListRow
      label={props.environment.label}
      description={
        connected
          ? supported
            ? allowed
              ? "Transfer to this device"
              : "Transfer access required"
            : "Update this device to transfer mines"
          : "Connect this device first"
      }
      icon="desktopcomputer"
      disabled={props.disabled || !connected || !supported || !allowed}
      onPress={() => props.onSelect(id)}
    />
  );
}

export function ThreadMineTransferControl(props: {
  readonly thread: EnvironmentThreadShell;
  readonly children: (controls: {
    readonly open: () => void;
    readonly allowed: boolean;
    readonly needsUpdate: boolean;
  }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const accountId = useAtomValue(minesAccountIdAtom) ?? "local-device";
  const environmentId = props.thread.environmentId;
  const { presentation } = useEnvironmentPresentation(environmentId);
  const supported = presentation?.serverConfig?.environment.capabilities.mineTransfer === true;
  const journalKey = JSON.stringify([accountId, environmentId, props.thread.id]);
  const [savedTransfer, setSavedTransfer] = useState<{
    readonly key: string;
    readonly pending: boolean;
  } | null>(null);
  const onPendingChange = useCallback(
    (pending: boolean) => setSavedTransfer({ key: journalKey, pending }),
    [journalKey],
  );
  useEffect(() => {
    let closed = false;
    void openMobilePrivateStore(accountId)
      .then((storage) =>
        createMineTransferJournal({ storage, environmentId, threadId: props.thread.id }).load(),
      )
      .then((saved) => {
        if (!closed) onPendingChange(saved !== null);
      })
      .catch(() => {});
    return () => {
      closed = true;
    };
  }, [accountId, environmentId, props.thread.id, onPendingChange]);
  const permissionAtom = useMemo(
    () => transferPermissions(environmentId, "source"),
    [environmentId],
  );
  const allowed = useAtomValue(permissionAtom);
  return (
    <>
      {props.children({
        open: () => setOpen(true),
        allowed:
          allowed && (supported || (savedTransfer?.key === journalKey && savedTransfer.pending)),
        needsUpdate: !supported,
      })}
      {open ? (
        <MineTransferModal
          key={JSON.stringify([accountId, environmentId, props.thread.id])}
          accountId={accountId}
          thread={props.thread}
          sourceAllowed={allowed}
          onPendingChange={onPendingChange}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function MineTransferModal(props: {
  readonly accountId: string;
  readonly thread: EnvironmentThreadShell;
  readonly sourceAllowed: boolean;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const accountId = props.accountId;
  const onPendingChange = props.onPendingChange;
  const { environments } = useEnvironments();
  const selectDetail = useSelectWorkspaceDetail();
  const sourceId = props.thread.environmentId;
  const threadId = props.thread.id;
  const [journal, setJournal] = useState<ReturnType<typeof createMineTransferJournal> | null>(null);
  const [pending, setPending] = useState<MineTransferRequest | null>(null);
  const destinationId = pending?.destinationEnvironmentId ?? null;
  const [progress, setProgress] = useState<MineTransferProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const source = environments.find((environment) => environment.environmentId === sourceId);
  const destination = environments.find(
    (environment) => environment.environmentId === pending?.destinationEnvironmentId,
  );
  const sourceSupported = source?.serverConfig?.environment.capabilities.mineTransfer === true;
  const destinationSupported =
    destination?.serverConfig?.environment.capabilities.mineTransfer === true;
  const canRun =
    props.sourceAllowed &&
    source?.connection.phase === "connected" &&
    (sourceSupported || pending !== null);
  const candidates = environments.filter((environment) => environment.environmentId !== sourceId);

  useEffect(() => {
    let closed = false;
    void openMobilePrivateStore(accountId)
      .then(async (storage) => {
        const opened = createMineTransferJournal({ storage, environmentId: sourceId, threadId });
        const saved = await opened.load();
        if (!closed) {
          setPending(saved);
          onPendingChange(saved !== null);
          setJournal(opened);
        }
      })
      .catch((cause: unknown) => {
        if (!closed)
          setError(cause instanceof Error ? cause.message : "Could not open the saved transfer.");
      });
    return () => {
      closed = true;
    };
  }, [accountId, sourceId, threadId, onPendingChange]);

  const client = (environmentId: EnvironmentId): MineTransferClient => {
    const run = async <Input, A, E>(
      command: AtomCommand<{ environmentId: EnvironmentId; input: Input }, A, E>,
      input: Input,
    ): Promise<A> => {
      const result = await runAtomCommand(
        registry,
        command,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag === "Success") return result.value;
      throw squashAtomCommandFailure(result);
    };
    return {
      preflight: (input) => run(mineTransferCommands.preflight, input),
      prepare: (input) => run(mineTransferCommands.prepare, input),
      readChunk: (input) => run(mineTransferCommands.readChunk, input),
      begin: (input) => run(mineTransferCommands.begin, input),
      writeChunk: (input) => run(mineTransferCommands.writeChunk, input),
      accept: (input) => run(mineTransferCommands.accept, input),
      finalize: (input) => run(mineTransferCommands.finalize, input),
      cancel: (input) => run(mineTransferCommands.cancel, input),
    };
  };

  const runTransfer = async (destinationId: EnvironmentId) => {
    if (busyRef.current || !journal || !canRun) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const request = pending ?? {
      transferId: uuidv4(),
      sourceEnvironmentId: sourceId,
      destinationEnvironmentId: destinationId,
      threadId,
      modelSelection: props.thread.modelSelection,
      continueActive: true,
    };
    try {
      await journal.save(request);
      setPending(request);
      props.onPendingChange(true);
      const receipt = await transferMine(
        client(sourceId),
        client(request.destinationEnvironmentId),
        request,
        setProgress,
      );
      await journal.clear();
      props.onPendingChange(false);
      props.onClose();
      selectDetail({
        name: "Thread",
        params: { environmentId: receipt.destinationEnvironmentId, threadId: receipt.threadId },
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Transfer interrupted. Retry to continue safely.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const returnToSource = async () => {
    if (busyRef.current || !pending || !journal) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await cancelMineTransfer(
        client(sourceId),
        client(pending.destinationEnvironmentId),
        pending.transferId,
      );
      await journal.clear();
      setPending(null);
      props.onPendingChange(false);
      setProgress(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not confirm cancellation. Retry the transfer to finish safely.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const cancelPermissionAtom = useMemo(
    () =>
      Atom.make(
        (get) =>
          get(mineTransferCommands.cancel.permissionAtom(sourceId)) &&
          (destinationId === null ||
            get(mineTransferCommands.cancel.permissionAtom(destinationId))),
      ),
    [sourceId, destinationId],
  );
  const canCancel = useAtomValue(cancelPermissionAtom);
  const retryPermissionAtom = useMemo(
    () =>
      destinationId === null ? Atom.make(false) : transferPermissions(destinationId, "destination"),
    [destinationId],
  );
  const canRetry = useAtomValue(retryPermissionAtom);
  const dismiss = () => {
    if (!busyRef.current) props.onClose();
  };
  const percent =
    progress && progress.totalBytes > 0
      ? Math.round((progress.copiedBytes / progress.totalBytes) * 100)
      : null;

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={dismiss}>
      <SafeAreaView className="flex-1 bg-screen">
        <SheetHeader
          presentation="inline"
          title="Transfer mine"
          subtitle={props.thread.title}
          onClose={dismiss}
          dismissDisabled={busy}
        />
        <ScreenScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
          <Text className="text-sm leading-5 text-foreground-muted">
            Move this mine’s text history and project files to another device. Active work pauses,
            then continues in a new provider session. Native tool state and terminals stay on the
            source device. Keep this phone open until the transfer finishes.
          </Text>
          {source?.connection.phase === "connected" && !sourceSupported ? (
            <Text className="text-sm text-foreground-muted">
              Update the source device to transfer mines.
            </Text>
          ) : null}
          {pending && destination?.connection.phase === "connected" && !destinationSupported ? (
            <Text className="text-sm text-foreground-muted">
              Update the destination device to finish this saved transfer.
            </Text>
          ) : null}
          {!canRun ? (
            <Text className="text-sm text-foreground-muted">
              Connect the source device with transfer access to continue.
            </Text>
          ) : null}
          {!journal && !error ? (
            <Text className="text-sm text-foreground-muted">Opening saved transfer…</Text>
          ) : null}
          {pending ? (
            <View className="gap-3 rounded-2xl bg-grouped-card p-4">
              <Text className="font-mines-medium text-foreground">
                {source?.label ?? "Source device"} → {destination?.label ?? "Saved destination"}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {pending.modelSelection.instanceId} · {pending.modelSelection.model}
              </Text>
              {progress ? (
                <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
                  {STAGE_LABEL[progress.stage]}
                  {progress.stage === "copying" && percent !== null ? ` ${percent}%` : ""}
                </Text>
              ) : null}
              {!busy ? (
                <Text className="text-sm text-foreground-muted">
                  Retry continues this saved transfer from the last acknowledged file chunk.
                </Text>
              ) : null}
            </View>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {error}
            </Text>
          ) : null}
          {pending ? (
            <View className="overflow-hidden rounded-2xl">
              <ListRow
                label="Retry transfer"
                disabled={
                  busy || !canRun || !canRetry || destination?.connection.phase !== "connected"
                }
                onPress={() => void runTransfer(pending.destinationEnvironmentId)}
              />
              <ListRow
                label="Return to source"
                description="The destination must confirm cancellation before this mine can run on the source again."
                disabled={busy || !canCancel}
                onPress={() => void returnToSource()}
              />
            </View>
          ) : (
            <View className="overflow-hidden rounded-2xl">
              {candidates.map((environment) => (
                <DestinationRow
                  key={environment.environmentId}
                  environment={environment}
                  disabled={busy || !journal || !canRun}
                  onSelect={(id) => void runTransfer(id)}
                />
              ))}
              {candidates.length === 0 ? (
                <Text className="p-4 text-sm text-foreground-muted">
                  Add another device in Connections to transfer this mine.
                </Text>
              ) : null}
            </View>
          )}
        </ScreenScrollView>
      </SafeAreaView>
    </Modal>
  );
}
