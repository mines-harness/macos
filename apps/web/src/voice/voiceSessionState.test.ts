import { describe, expect, it } from "vite-plus/test";

import { INITIAL_VOICE_SESSION, reduceVoiceSession } from "@t3tools/client-runtime/voice-live";

describe("voice subscription state", () => {
  it("retains an answer when later events share the same stream chunk", () => {
    const snapshot = [
      { type: "started" as const },
      { type: "sdp" as const, sdp: "provider-answer" },
      { type: "transcript" as const, role: "assistant" as const, text: "Hello", done: true },
    ].reduce(reduceVoiceSession, INITIAL_VOICE_SESSION);
    expect(snapshot.sdp).toBe("provider-answer");
    expect(snapshot.closed).toBe(false);
  });

  it("keeps an error visible if a closed notification follows it", () => {
    const failed = reduceVoiceSession(INITIAL_VOICE_SESSION, {
      type: "error",
      message: "Subscription unavailable",
    });
    expect(reduceVoiceSession(failed, { type: "closed" })).toEqual({
      sdp: null,
      closed: true,
      error: "Subscription unavailable",
    });
  });
});
