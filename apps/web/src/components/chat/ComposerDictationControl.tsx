import { useEffect, useState, useSyncExternalStore } from "react";
import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import type { DesktopDictationCapability } from "@t3tools/contracts";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { useStableCallback } from "../../hooks/useStableCallback";
import { createDictationBackend } from "../../voice/dictationBackend";
import { createDictationInput } from "../../voice/dictationInput";
import { randomUUID } from "../../lib/utils";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";

type DictationInput = {
  readonly ownerKey: string;
  readonly disabled?: boolean;
  readonly onTranscript: (text: string) => void;
  readonly onRecordingChange?: (recording: boolean) => void;
  readonly onBusyChange?: (busy: boolean) => void;
};
const IDLE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const idleSnapshot = () => IDLE;
const idleSubscription = () => () => undefined;

function useComposerDictation(input: DictationInput) {
  const [backend] = useState(() => createDictationBackend(window.desktopBridge, window));
  const [capability, setCapability] = useState<DesktopDictationCapability | null>(null);
  const transcript = useStableCallback((ownerKey: string, text: string) => {
    if (ownerKey === input.ownerKey) input.onTranscript(text);
  });
  const recording = useStableCallback((active: boolean) => input.onRecordingChange?.(active));
  const busy = useStableCallback((active: boolean) => input.onBusyChange?.(active));
  const getCapability = useStableCallback(
    () =>
      capability ?? {
        available: false,
        locale: "en-US",
        reason: "Checking speech recognition…",
      },
  );
  const publish = useStableCallback((ownerKey: string, next: VoiceInputState) => {
    if (ownerKey !== input.ownerKey) return;
    recording(next.phase === "recording");
    busy(voiceInputBlocksSubmission(next));
    if (next.phase === "error")
      toastManager.add({
        type: "error",
        title: "Dictation stopped",
        description: next.error ?? "Could not transcribe speech.",
      });
  });
  // oxlint-disable-next-line mines/react-effect-budget -- Speech capability comes from asynchronous native IPC or the browser engine.
  useEffect(() => {
    let live = true;
    const locale = window.desktopBridge?.getSystemLocale?.() ?? navigator.language ?? "en-US";
    if (!backend) return;
    void backend.capability(locale).then(
      (available) => {
        if (live) setCapability(available);
      },
      () => {
        if (live)
          setCapability({
            available: false,
            locale,
            reason: "Speech recognition is unavailable on this device.",
          });
      },
    );
    return () => {
      live = false;
    };
  }, [backend]);
  const [capture] = useState(() => {
    if (!backend) return null;
    return createDictationInput({
      ownerKey: input.ownerKey,
      backend,
      getCapability,
      createSessionId: randomUUID,
      onTranscript: (text) => transcript(input.ownerKey, text),
      onStateChange: (next) => publish(input.ownerKey, next),
    });
  });
  const state = useSyncExternalStore(
    capture?.subscribe ?? idleSubscription,
    capture?.getSnapshot ?? idleSnapshot,
    idleSnapshot,
  );
  // oxlint-disable-next-line mines/react-effect-budget -- Changing the draft owner or unmounting must release the native microphone.
  useEffect(() => {
    capture?.activate();
    return () => {
      capture?.dispose();
      recording(false);
      busy(false);
    };
  }, [capture, recording, busy]);
  // oxlint-disable-next-line mines/react-effect-budget -- Losing compose permission must stop capture even when it changes outside this control.
  useEffect(() => {
    if (input.disabled) capture?.controller.cancel();
  }, [input.disabled, capture]);
  return {
    state,
    available: capability?.available === true,
    unavailableReason: backend
      ? (capability?.reason ?? (capability ? null : "Checking speech recognition…"))
      : "Speech recognition is not supported by this browser.",
    busy: voiceInputBlocksSubmission(state),
    start: () => {
      if (!input.disabled) void capture?.controller.start();
    },
    stop: () => {
      void capture?.controller.stop();
    },
    cancel: () => capture?.controller.cancel(),
  };
}

export function ComposerDictationControl(input: DictationInput) {
  return <ComposerDictationSession key={input.ownerKey} {...input} />;
}

function ComposerDictationSession(input: DictationInput) {
  const voice = useComposerDictation(input);
  const recording = voice.state.phase === "recording";
  const waiting = voice.busy && !recording;
  const label = recording
    ? "Finish dictation"
    : voice.state.phase === "transcribing"
      ? "Transcribing dictation"
      : waiting
        ? "Preparing dictation"
        : "Dictate message";
  const reason = voice.state.error ?? voice.unavailableReason;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              aria-label={label}
              aria-pressed={recording}
              disabled={waiting || (!recording && (!voice.available || input.disabled))}
              onClick={recording ? voice.stop : voice.start}
            >
              {waiting ? (
                <Spinner />
              ) : (
                <ComposerControlIcon icon={recording ? SquareIcon : MicIcon} />
              )}
            </ComposerControl>
          }
        />
        <TooltipPopup>
          {recording
            ? "Finish and add speech to the draft"
            : (reason ?? "Dictate into your draft. Nothing is sent automatically.")}
        </TooltipPopup>
      </Tooltip>
      {voice.busy && (
        <ComposerControl
          aria-label="Cancel dictation"
          title="Discard dictation"
          onClick={voice.cancel}
        >
          <ComposerControlIcon icon={XIcon} />
        </ComposerControl>
      )}
    </>
  );
}
