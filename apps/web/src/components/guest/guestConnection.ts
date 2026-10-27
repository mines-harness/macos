import type { GuestStreamEvent } from "@t3tools/contracts";

import { parseGuestStreamEvent } from "./guestStream.logic";

export function connectGuestStream(input: {
  readonly streamUrl: string;
  readonly sessionUrl: string;
  readonly onEvent: (event: GuestStreamEvent) => void;
  readonly onRejected: () => void;
  readonly onReconnecting: (reconnecting: boolean) => void;
}): () => void {
  const controller = new AbortController();
  let stopped = false;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let probing = false;
  const stop = () => {
    stopped = true;
    controller.abort();
    source?.close();
    if (timer !== undefined) clearTimeout(timer);
  };
  const connect = () => {
    if (stopped) return;
    timer = undefined;
    const current = new EventSource(input.streamUrl);
    source = current;
    current.addEventListener("message", (message) => {
      if (stopped || source !== current) return;
      const event = parseGuestStreamEvent(message.data);
      if (event === null) return;
      input.onReconnecting(false);
      input.onEvent(event);
      if (event.type === "ended") stop();
    });
    current.addEventListener("error", () => {
      if (stopped || source !== current) return;
      input.onReconnecting(true);
      if (current.readyState !== EventSource.CLOSED || probing || timer !== undefined) return;
      probing = true;
      void fetch(input.sessionUrl, { signal: controller.signal })
        .then(
          (response) => response.status === 403,
          () => false,
        )
        .then((rejected) => {
          probing = false;
          if (stopped) return;
          if (rejected) {
            stop();
            input.onRejected();
          } else {
            timer = setTimeout(connect, 2_000);
          }
        });
    });
  };
  connect();
  return stop;
}
