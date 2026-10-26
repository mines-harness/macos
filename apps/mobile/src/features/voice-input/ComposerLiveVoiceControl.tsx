import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { LiveVoicePeer } from "@t3tools/client-runtime/voice-live";
import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type ModelSelection,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { ComposerActionButton } from "../../components/ComposerToolbar";
import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { createNativeLiveVoicePeer, isNativeLiveVoiceAvailable } from "../../native/liveVoicePeer";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { voiceCapabilities, voiceSession, voiceStart, voiceStop } from "../../state/voice";
import { useGlobalVoiceInput } from "./VoiceInputProvider";

interface ActiveVoice {
  readonly abort: AbortController;
  media: LiveVoicePeer | null;
  timeout: ReturnType<typeof setTimeout>;
  runId: RunId | null;
}

export function ComposerLiveVoiceControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly connected: boolean;
  readonly startDisabled: boolean;
  readonly size: "regular" | "large";
  readonly onActiveChange: (active: boolean) => void;
}) {
  const { environmentId, threadId, modelSelection, connected, onActiveChange } = props;
  const permitted = useAtomValue(voiceStart.permissionAtom(environmentId));
  const localDictation = useGlobalVoiceInput();
  const startCommand = useAtomCommand(voiceStart, { reportFailure: false });
  const stopCommand = useAtomCommand(voiceStop, { reportFailure: false });
  const capable = isNativeLiveVoiceAvailable();
  const capability = useEnvironmentQuery(
    capable && connected && permitted
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
  const stopRun = useCallback(
    (id: RunId) => {
      void stopCommand({ environmentId, input: { threadId, runId: id } });
    },
    [environmentId, stopCommand, threadId],
  );
  const end = useCallback(
    (message?: string) => {
      const current = active.current;
      if (!current) return;
      active.current = null;
      clearTimeout(current.timeout);
      current.abort.abort();
      current.media?.close();
      if (current.runId) stopRun(current.runId);
      onActiveChange(false);
      if (!mounted.current) return;
      setRunId(null);
      setPhase("idle");
      if (message) Dialog.alert("Voice stopped", message);
    },
    [onActiveChange, stopRun],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      end();
    };
  }, [end]);
  useFocusEffect(useCallback(() => () => end(), [end]));
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "background") end();
    });
    return () => listener.remove();
  }, [end]);
  useEffect(() => {
    if (!connected || !permitted || localDictation.isBusy) end();
  }, [connected, permitted, localDictation.isBusy, end]);
  useEffect(() => {
    const current = active.current;
    if (!current?.media || !runId) return;
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
      props.startDisabled ||
      !connected ||
      !permitted ||
      localDictation.isBusy ||
      !capability.data?.live.supported
    )
      return;
    const current: ActiveVoice = {
      abort: new AbortController(),
      media: null,
      runId: null,
      timeout: setTimeout(() => end("The voice connection timed out. Try again."), 45_000),
    };
    active.current = current;
    setPhase("connecting");
    onActiveChange(true);
    try {
      const media = await createNativeLiveVoicePeer({
        signal: current.abort.signal,
        onConnected: () => {
          if (active.current !== current) return;
          clearTimeout(current.timeout);
          setPhase("live");
        },
        onFailure: (error) => {
          if (active.current === current) end(error.message);
        },
      });
      current.media = media;
      if (active.current !== current) {
        media.close();
        void media.offer.catch(() => undefined);
        return;
      }
      const sdp = await media.offer;
      if (active.current !== current) return;
      const result = await startCommand({
        environmentId,
        input: {
          threadId,
          modelSelection,
          sdp,
          commandId: CommandId.make(uuidv4()),
          messageId: MessageId.make(uuidv4()),
        },
      });
      if (result._tag !== "Success") {
        if (active.current === current) {
          const error = squashAtomCommandFailure(result);
          end(error instanceof Error ? error.message : "Could not start voice.");
        }
        return;
      }
      current.runId = result.value.runId;
      if (active.current !== current) {
        stopRun(result.value.runId);
        return;
      }
      setRunId(result.value.runId);
    } catch (error) {
      if (active.current === current)
        end(error instanceof Error ? error.message : "Could not start voice.");
    }
  };
  if (!capable || (!capability.data?.live.supported && phase === "idle")) return null;
  return (
    <ComposerActionButton
      size={props.size}
      accessibilityLabel={
        phase === "idle"
          ? "Talk with GPT"
          : phase === "connecting"
            ? "Cancel voice connection"
            : "End voice conversation"
      }
      icon={phase === "idle" ? "headphones" : "stop.fill"}
      variant={phase === "idle" ? "primary" : "danger"}
      disabled={
        phase === "idle" &&
        (props.startDisabled || !connected || !permitted || localDictation.isBusy)
      }
      onPress={() => {
        if (phase === "idle") void start();
        else end();
      }}
    />
  );
}
