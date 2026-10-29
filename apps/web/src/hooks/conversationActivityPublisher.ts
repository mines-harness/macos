import { CONVERSATION_ACTIVITY_TTL_MS, type ConversationActivityKind } from "@t3tools/contracts";

export function createConversationActivityPublisher(
  publish: (kind: ConversationActivityKind) => unknown,
) {
  let kind: ConversationActivityKind = "idle";
  let recording = false;
  let disposed = false;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  const send = (value: ConversationActivityKind) => {
    try {
      void Promise.resolve(publish(value)).catch(() => {});
    } catch {}
  };
  const change = (next: ConversationActivityKind) => {
    if (disposed || kind === next) return;
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    kind = next;
    send(kind);
    if (kind !== "idle")
      refreshTimer = setInterval(() => send(kind), CONVERSATION_ACTIVITY_TTL_MS / 2);
  };
  const clear = () => {
    recording = false;
    clearTimeout(pauseTimer);
    pauseTimer = undefined;
    change("idle");
  };
  return {
    typing() {
      if (disposed || recording) return;
      clearTimeout(pauseTimer);
      change("typing");
      pauseTimer = setTimeout(clear, 2_500);
    },
    voice(active: boolean) {
      if (disposed || active === recording) return;
      if (!active) return clear();
      recording = true;
      clearTimeout(pauseTimer);
      pauseTimer = undefined;
      change("voice");
    },
    clear,
    [Symbol.dispose]() {
      clear();
      disposed = true;
    },
  };
}
