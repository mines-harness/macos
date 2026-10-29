import type { ConversationActivityKind } from "@t3tools/contracts";

const REFRESH_MS = 4_000;
const TYPING_IDLE_MS = 4_000;

export function createConversationActivityPublisher(
  publish: (kind: ConversationActivityKind) => void,
) {
  let current: ConversationActivityKind = "idle";
  let disposed = false;
  let refresh: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const stopTimers = () => {
    clearTimeout(refresh);
    clearTimeout(idle);
    refresh = undefined;
    idle = undefined;
  };
  const renew = () => {
    clearTimeout(refresh);
    refresh = setTimeout(() => {
      if (disposed || current === "idle") return;
      publish(current);
      renew();
    }, REFRESH_MS);
  };
  const clear = () => {
    stopTimers();
    if (current === "idle") return;
    current = "idle";
    publish("idle");
  };
  return {
    onEdit(hasText = true) {
      if (disposed || current === "voice") return;
      if (!hasText) return clear();
      clearTimeout(idle);
      idle = setTimeout(clear, TYPING_IDLE_MS);
      if (current !== "typing") {
        current = "typing";
        publish(current);
        renew();
      }
    },
    setCaptureActive(active: boolean) {
      if (disposed) return;
      if (!active) {
        if (current === "voice") clear();
        return;
      }
      if (current === "voice") return;
      stopTimers();
      current = "voice";
      publish(current);
      renew();
    },
    onBlur: clear,
    onSubmit: clear,
    [Symbol.dispose]() {
      if (disposed) return;
      clear();
      disposed = true;
    },
  };
}
