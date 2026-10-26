import type { ProviderVoiceEvent } from "@t3tools/contracts";

export interface VoiceSessionSnapshot {
  readonly sdp: string | null;
  readonly closed: boolean;
  readonly error: string | null;
}

export const INITIAL_VOICE_SESSION: VoiceSessionSnapshot = {
  sdp: null,
  closed: false,
  error: null,
};

export function reduceVoiceSession(
  state: VoiceSessionSnapshot,
  event: ProviderVoiceEvent,
): VoiceSessionSnapshot {
  if (event.type === "sdp") return { ...state, sdp: event.sdp };
  if (event.type === "error") return { ...state, error: event.message, closed: true };
  if (event.type === "closed") return { ...state, closed: true };
  return state;
}
