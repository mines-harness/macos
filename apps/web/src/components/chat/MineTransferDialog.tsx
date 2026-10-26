import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import {
  cancelMineTransfer,
  transferMine,
  type MineTransferProgress,
  type MineTransferRequest,
} from "@t3tools/client-runtime/mine-transfer";
import type { EnvironmentId, MineTransferReceipt, ScopedThreadRef } from "@t3tools/contracts";
import { ArrowRightLeftIcon, CheckIcon, MonitorIcon } from "lucide-react";
import { useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { randomUUID } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import {
  clearPendingMineTransfer,
  mineTransferClient,
  mineTransferCommands,
  readPendingMineTransfer,
  savePendingMineTransfer,
} from "../../state/mineTransfer";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { mineTransferDialogThreadAtom } from "./mineTransferDialogState";

const stages: Record<MineTransferProgress["stage"], string> = {
  checking: "Checking the destination…",
  pausing: "Pausing the agent and saving your work…",
  copying: "Copying project files…",
  starting: "Restoring the mine on the destination…",
  finishing: "Finishing the transfer…",
  complete: "Transfer complete",
};

export function MineTransferDialogHost() {
  const threadRef = useAtomValue(mineTransferDialogThreadAtom);
  return threadRef ? (
    <MineTransferDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(mineTransferDialogThreadAtom, null)}
    />
  ) : null;
}

function MineTransferDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const router = useRouter();
  const thread = useThreadShell(threadRef);
  const { environments } = useEnvironments();
  const [pending, setPending] = useState(() => readPendingMineTransfer(threadRef));
  const destinations = environments.filter(
    (device) => device.environmentId !== threadRef.environmentId,
  );
  const [selected, setSelected] = useState<EnvironmentId | null>(
    pending?.destinationEnvironmentId ??
      destinations.find((device) => device.connection.phase === "connected")?.environmentId ??
      null,
  );
  const [continueActive, setContinueActive] = useState(pending?.continueActive ?? true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<MineTransferProgress | null>(null);
  const [receipt, setReceipt] = useState<MineTransferReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canPrepare = useAtomValue(
    mineTransferCommands.prepare.permissionAtom(threadRef.environmentId),
  );
  const canReceive = useAtomValue(
    mineTransferCommands.begin.permissionAtom(selected ?? threadRef.environmentId),
  );
  const canFinalize = useAtomValue(
    mineTransferCommands.finalize.permissionAtom(threadRef.environmentId),
  );
  const destination = destinations.find((device) => device.environmentId === selected);
  const source = environments.find((device) => device.environmentId === threadRef.environmentId);
  const connected =
    source?.connection.phase === "connected" && destination?.connection.phase === "connected";

  const report = (cause: unknown) =>
    setError(
      cause instanceof Error
        ? cause.message
        : "The transfer could not finish. Reconnect both devices and retry.",
    );
  const start = async () => {
    const modelSelection = pending?.modelSelection ?? thread?.modelSelection;
    if (!selected || !modelSelection || busy) return;
    setBusy(true);
    setError(null);
    try {
      const request: MineTransferRequest = pending ?? {
        transferId: randomUUID(),
        threadId: threadRef.threadId,
        sourceEnvironmentId: threadRef.environmentId,
        destinationEnvironmentId: selected,
        modelSelection,
        continueActive,
      };
      savePendingMineTransfer(request);
      setPending(request);
      const result = await transferMine(
        mineTransferClient(request.sourceEnvironmentId),
        mineTransferClient(request.destinationEnvironmentId),
        request,
        setProgress,
      );
      setReceipt(result);
      clearPendingMineTransfer(request);
      setPending(null);
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const returnToSource = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      await cancelMineTransfer(
        mineTransferClient(pending.sourceEnvironmentId),
        mineTransferClient(pending.destinationEnvironmentId),
        pending.transferId,
      );
      clearPendingMineTransfer(pending);
      setPending(null);
      setProgress(null);
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Transfer mine</DialogTitle>
          <DialogDescription>
            Move {thread?.title ?? "this mine"} from {source?.label ?? "its current device"} to
            another device. The agent pauses while project files and saved conversation context
            move.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {receipt ? (
              <p role="status">Your mine is ready on {destination?.label ?? "the destination"}.</p>
            ) : (
              <>
                <div className="space-y-1" role="group" aria-label="Destination device">
                  {destinations.map((device) => (
                    <button
                      key={device.environmentId}
                      type="button"
                      className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-3 text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
                      disabled={busy || pending !== null || device.connection.phase !== "connected"}
                      aria-pressed={selected === device.environmentId}
                      onClick={() => setSelected(device.environmentId)}
                    >
                      <MonitorIcon aria-hidden className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{device.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {device.connection.phase === "connected" ? "Connected" : "Offline"}
                      </span>
                      {selected === device.environmentId ? (
                        <CheckIcon aria-hidden className="size-4" />
                      ) : null}
                    </button>
                  ))}
                </div>
                {destinations.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Connect your other computer in Settings → Connections first.
                  </p>
                ) : null}
                {!pending ? (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={continueActive}
                      onCheckedChange={setContinueActive}
                      disabled={busy}
                    />
                    Continue automatically if the agent is working
                  </label>
                ) : null}
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Uncommitted files travel in a private Git snapshot. Your normal branch stays
                  intact. Ignored files, local credentials, running terminals, and provider tool
                  state stay on their device.
                </p>
                {pending && !busy ? (
                  <p className="text-sm text-muted-foreground">
                    A saved transfer is pending. Retry to finish it, or return to the source. After
                    returning, continue the agent from its paused mine.
                  </p>
                ) : null}
                {progress && busy ? (
                  <div className="space-y-2" role="status" aria-live="polite">
                    <p className="text-sm">{stages[progress.stage]}</p>
                    {progress.stage === "copying" ? (
                      <>
                        <progress
                          className="h-2 w-full accent-primary"
                          max={progress.totalBytes}
                          value={progress.copiedBytes}
                          aria-label="Project files copied"
                        />
                        <p className="text-xs tabular-nums text-muted-foreground">
                          {Math.round((progress.copiedBytes / progress.totalBytes) * 100)}%
                        </p>
                      </>
                    ) : null}
                  </div>
                ) : null}
                {!canPrepare || !canReceive || !canFinalize ? (
                  <p className="text-sm text-muted-foreground">
                    This connection needs permission to operate mines and write project files on
                    both devices.
                  </p>
                ) : null}
                {!connected && destinations.length > 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Keep both devices awake and connected during the transfer.
                  </p>
                ) : null}
              </>
            )}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {receipt ? (
            <Button
              onClick={() => {
                onClose();
                void router.navigate({
                  to: "/$environmentId/$threadId",
                  params: {
                    environmentId: receipt.destinationEnvironmentId,
                    threadId: receipt.threadId,
                  },
                });
              }}
            >
              Open mine
            </Button>
          ) : (
            <>
              {pending ? (
                <Button
                  variant="outline"
                  disabled={busy || !connected}
                  onClick={() => void returnToSource()}
                >
                  Return to source
                </Button>
              ) : null}
              <Button variant="outline" disabled={busy} onClick={onClose}>
                Close
              </Button>
              <Button
                disabled={
                  busy ||
                  !selected ||
                  (!thread && !pending) ||
                  !connected ||
                  !canPrepare ||
                  !canReceive ||
                  !canFinalize
                }
                onClick={() => void start()}
              >
                <ArrowRightLeftIcon aria-hidden />
                {pending ? "Retry transfer" : "Transfer mine"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
