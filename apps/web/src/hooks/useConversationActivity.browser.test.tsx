import type { ConversationActivityKind } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { ConversationActivityIndicator } from "../components/chat/ConversationActivity";
import { useConversationActivityPublisher } from "./useConversationActivity";

function Publisher({
  target,
  publish,
}: {
  readonly target: string;
  readonly publish: (target: string, kind: ConversationActivityKind) => void;
}) {
  const activity = useConversationActivityPublisher({
    targetKey: target,
    publish: (kind) => publish(target, kind),
  });
  return <button onClick={activity.typing}>Type</button>;
}

it("clears the original conversation on navigation and the new one when the window loses focus", async () => {
  const publish = vi.fn();
  await using screen = await render(<Publisher target="first" publish={publish} />, {
    // Tests one hook's conversation lifecycle, with no navigation links.
    router: false,
  });
  await userEvent.click(screen.getByRole("button", { name: "Type" }));
  await screen.rerender(<Publisher target="second" publish={publish} />);
  expect(publish.mock.calls).toEqual([
    ["first", "typing"],
    ["first", "idle"],
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Type" }));
  await act(() => window.dispatchEvent(new Event("blur")));
  expect(publish.mock.calls).toEqual([
    ["first", "typing"],
    ["first", "idle"],
    ["second", "typing"],
    ["second", "idle"],
  ]);
});

it("expires an activity lease and names actual voice activity as singing", async () => {
  // The deadline snapshot reads this clock on its first render.
  using _timers = fakeTimers({ now: 0 });
  await using screen = await render(
    <ConversationActivityIndicator
      name="Alex"
      activity={{
        kind: "voice",
        expiresAt: "1970-01-01T00:00:08.000Z",
      }}
    />,
    {
      // A status region without routing or environment data.
      router: false,
    },
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent("Alex is singing...");
  await act(() => vi.advanceTimersByTime(8_000));
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
});
