import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type ModelSelection,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { AudioLinesIcon, PhoneOffIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { randomUUID } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { voiceCapabilities, voiceSession, voiceStart, voiceStop } from "../../state/voice";
import {
  createLiveVoicePeer,
  liveVoiceUnavailableReason,
  type LiveVoicePeer,
} from "../../voice/liveVoicePeer";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";

interface ActiveVoice {
  readonly media: LiveVoicePeer;
  readonly timeout: ReturnType<typeof setTimeout>;
  runId: RunId | null;
}

export function ComposerLiveVoiceControl({
  environmentId,
  threadId,
  modelSelection,
  startDisabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly startDisabled: boolean;
}) {
  const environment = useEnvironment(environmentId);
  const connected = environment?.connection.phase === "connected";
  const permitted = useAtomValue(voiceStart.permissionAtom(environmentId));
  const startCommand = useAtomCommand(voiceStart, { reportFailure: false });
  const stopCommand = useAtomCommand(voiceStop, { reportFailure: false });
  const capability = useEnvironmentQuery(
    connected && permitted
      ? voiceCapabilities({ environmentId, input: { threadId, modelSelection } })
      : null,
  );
  const active = useRef<ActiveVoice | null>(null);
  const mounted = useRef(true);
  const [runId, setRunId] = useState<RunId | null>(null);
  const [phase, setPhase] = useState<"idle" | "connecting" | "live">("idle");
  const session = useEnvironmentQuery(
    runId ? voiceSession({ environmentId, input: { threadId, runId } }) : null,
  );
  const stopRun = useStableCallback((id: RunId) => {
    void stopCommand({ environmentId, input: { threadId, runId: id } });
  });
  const end = useStableCallback((message?: string) => {
    const current = active.current;
    if (!current) return;
    active.current = null;
    clearTimeout(current.timeout);
    current.media.close();
    if (current.runId) stopRun(current.runId);
    if (!mounted.current) return;
    setRunId(null);
    setPhase("idle");
    if (message)
      toastManager.add({
        type: "error",
        title: "Voice stopped",
        description: message,
        data: { threadRef: { environmentId, threadId } },
      });
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      end();
    };
  }, [end]);
  useEffect(() => {
    if (!connected || !permitted) end();
  }, [connected, permitted, end]);
  useEffect(() => {
    const current = active.current;
    if (!current || !runId) return;
    if (session.error || session.data?.closed) {
      end(session.error ?? session.data?.error ?? undefined);
      return;
    }
    if (session.data?.sdp)
      void current.media.acceptAnswer(session.data.sdp).catch(() => {
        if (active.current === current) end("Could not connect the voice conversation.");
      });
  }, [session.data, session.error, runId, end]);

  const start = async () => {
    if (
      active.current ||
      startDisabled ||
      !connected ||
      !permitted ||
      !capability.data?.live.supported
    )
      return;
    const unavailable = liveVoiceUnavailableReason();
    if (unavailable) {
      toastManager.add({ type: "error", title: "Voice unavailable", description: unavailable });
      return;
    }
    setPhase("connecting");
    let current: ActiveVoice | null = null;
    try {
      const media = createLiveVoicePeer({
        onConnected: () => {
          if (!current || active.current !== current) return;
          clearTimeout(current.timeout);
          setPhase("live");
        },
        onFailure: (error) => {
          if (current && active.current === current) end(error.message);
        },
      });
      current = {
        media,
        runId: null,
        timeout: setTimeout(() => end("The voice connection timed out. Try again."), 45_000),
      };
      active.current = current;
      const sdp = await media.offer;
      if (active.current !== current) return;
      const result = await startCommand({
        environmentId,
        input: {
          threadId,
          commandId: CommandId.make(randomUUID()),
          messageId: MessageId.make(randomUUID()),
          modelSelection,
          sdp,
        },
      });
      if (result._tag !== "Success") {
        if (active.current === current) end(formatEnvironmentQueryError(result.cause));
        return;
      }
      current.runId = result.value.runId;
      if (active.current !== current) {
        stopRun(result.value.runId);
        return;
      }
      setRunId(result.value.runId);
    } catch (error) {
      if (current && active.current === current)
        end(error instanceof Error ? error.message : "Could not start voice.");
      else if (!current && mounted.current) {
        setPhase("idle");
        toastManager.add({
          type: "error",
          title: "Voice unavailable",
          description: error instanceof Error ? error.message : "Could not start voice.",
        });
      }
    }
  };

  if (!capability.data?.live.supported && phase === "idle") return null;
  const unavailable = liveVoiceUnavailableReason();
  const label = phase === "idle" ? "Talk with GPT" : "End voice conversation";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            aria-label={label}
            aria-pressed={phase !== "idle"}
            disabled={
              phase === "idle" &&
              (startDisabled || !connected || !permitted || unavailable !== null)
            }
            onClick={() => {
              if (phase === "idle") void start();
              else end();
            }}
          />
        }
      >
        {phase === "connecting" ? (
          <Spinner className="size-4" />
        ) : (
          <ComposerControlIcon icon={phase === "live" ? PhoneOffIcon : AudioLinesIcon} />
        )}
        {phase !== "idle" ? (
          <span className="sr-only">{phase === "live" ? "Microphone live" : "Connecting"}</span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup>
        {phase === "idle"
          ? (unavailable ?? "Talk with GPT using this mine’s connected ChatGPT account")
          : "End voice conversation"}
      </TooltipPopup>
    </Tooltip>
  );
}
