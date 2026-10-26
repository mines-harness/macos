import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";
import { INITIAL_VOICE_SESSION, reduceVoiceSession } from "@t3tools/client-runtime/voice-live";

export const voiceCapabilities = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:voice:capabilities",
  tag: WS_METHODS.voiceGetCapabilities,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
export const voiceStart = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:voice:start",
  tag: WS_METHODS.voiceStart,
});
export const voiceStop = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:voice:stop",
  tag: WS_METHODS.voiceStop,
});
export const voiceSession = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "mines:voice:session",
  tag: WS_METHODS.voiceSubscribe,
  idleTtlMs: 0,
  transform: (stream) => stream.pipe(Stream.scan(() => INITIAL_VOICE_SESSION, reduceVoiceSession)),
});
