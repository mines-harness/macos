import { RegistryContext } from "@effect/atom-react";
import { MinesCatalog, minesAccountIdAtom } from "@t3tools/client-runtime/catalog";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { act, fakeTimers, render, type Screen } from "../../../test/render";
import {
  CatalogDraggableRow,
  CatalogDragProvider,
  CatalogDropArea,
  CatalogDropLine,
} from "./CatalogDragDrop";

function Board({
  catalog,
  onError,
  onActivate,
}: {
  catalog: MinesCatalog;
  onError: (message: string | null) => void;
  onActivate?: (entityId: string) => void;
}) {
  const snapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot);
  return (
    <CatalogDragProvider catalog={catalog} accountId="account" onError={onError}>
      <div style={{ width: 360, padding: 20 }}>
        <CatalogDropArea
          id="pins"
          target={{ parentId: null, pinned: true }}
          label="Pinned"
          className="min-h-16"
        >
          Pinned
        </CatalogDropArea>
        <CatalogDropArea id="library" target={{ parentId: null, pinned: false }} label="Library">
          <CatalogDropLine
            id="before-work"
            target={{ parentId: null, beforeId: "work", pinned: false }}
            label="Before work"
          />
          <CatalogDropArea
            id="work"
            target={{ parentId: "work", pinned: false }}
            label="Work"
            className="flex min-h-16 items-center gap-3"
          >
            <CatalogDraggableRow
              rowId="work"
              entityId="work"
              title="Work"
              className="min-h-16 w-full text-left"
              onClick={() => onActivate?.("work")}
            >
              Work
            </CatalogDraggableRow>
          </CatalogDropArea>
          <CatalogDropArea
            id="project"
            target={{ parentId: "project", pinned: false }}
            label="Project"
            className="flex min-h-16 items-center gap-3"
          >
            <CatalogDraggableRow
              rowId="project"
              entityId="project"
              title="Project"
              className="min-h-16 w-full text-left"
              onClick={() => onActivate?.("project")}
            >
              Project
            </CatalogDraggableRow>
          </CatalogDropArea>
          <div className="flex min-h-16 items-center">
            <CatalogDraggableRow
              rowId="thread"
              entityId="thread"
              title="Thread"
              className="min-h-16 w-full text-left"
              onClick={() => onActivate?.("thread")}
            >
              Thread
            </CatalogDraggableRow>
          </div>
        </CatalogDropArea>
        <output>{snapshot.pins.map((entry) => entry.entity.title).join(",")}</output>
      </div>
    </CatalogDragProvider>
  );
}

function mouse(type: string, x: number, y: number, buttons = 1) {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons,
    clientX: x,
    clientY: y,
  });
}

function touch(type: string, target: HTMLElement, x: number, y: number) {
  const point = new Touch({ identifier: 1, target, clientX: x, clientY: y });
  const active = type === "touchend" ? [] : [point];
  return new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: active,
    targetTouches: active,
    changedTouches: [point],
  });
}
async function beginDrag(
  screen: Screen,
  title: string,
  targetId: string,
  expectedState = "allowed",
) {
  const handle = screen.container.querySelector<HTMLButtonElement>(`[aria-label="${title}"]`)!;
  const from = handle.getBoundingClientRect();
  const targetElement = screen.container.querySelector<HTMLElement>(
    `[data-catalog-drop="${targetId}"]`,
  )!;
  const target = targetElement.getBoundingClientRect();
  const x = target.x + target.width / 2;
  const y = target.y + target.height / 2;
  await act(() => handle.dispatchEvent(mouse("mousedown", from.x + 10, from.y + 10)));
  await act(() => vi.advanceTimersByTimeAsync(200));
  await vi.waitFor(() => expect(handle.getAttribute("aria-pressed")).toBe("true"));
  await act(() => {
    document.dispatchEvent(mouse("mousemove", x, y));
  });
  await vi.waitFor(() => expect(targetElement.dataset.catalogDropState).toBe(expectedState));
  return () => act(() => document.dispatchEvent(mouse("mouseup", x, y, 0)));
}

function fixture() {
  const catalog = new MinesCatalog();
  catalog.upsert({ id: "work", kind: "section", title: "Work" });
  catalog.upsert({ id: "project", kind: "project", title: "Project" });
  catalog.upsert({ id: "thread", kind: "thread", title: "Thread" });
  const registry = AtomRegistry.make();
  registry.set(minesAccountIdAtom, "account");
  return { catalog, registry };
}

it("activates a quick click without moving the row and does not activate after holding a drag", async () => {
  const { catalog, registry } = fixture();
  const original = catalog.getSnapshot().roots;
  const onActivate = vi.fn();
  await using screen = await render(
    <RegistryContext value={registry}>
      <Board catalog={catalog} onError={() => {}} onActivate={onActivate} />
    </RegistryContext>,
    { router: false }, // This board exercises catalog state without app navigation.
  );
  using _timers = fakeTimers();
  const row = screen.container.querySelector<HTMLButtonElement>('[aria-label="Thread"]')!;
  const from = row.getBoundingClientRect();
  const click = () =>
    act(() => {
      row.dispatchEvent(mouse("mousedown", from.x + 10, from.y + 10));
      row.dispatchEvent(mouse("mouseup", from.x + 10, from.y + 10, 0));
      row.click();
    });
  await click();
  expect(onActivate).toHaveBeenCalledExactlyOnceWith("thread");
  expect(catalog.getSnapshot().roots).toEqual(original);
  await (
    await beginDrag(screen, "Thread", "pins")
  )();
  await act(() => row.click());
  expect(onActivate).toHaveBeenCalledTimes(1);
  expect(catalog.getSnapshot().pins[0]?.entity.id).toBe("thread");
  await act(() => vi.advanceTimersByTimeAsync(50));
  await click();
  expect(onActivate).toHaveBeenCalledTimes(2);
  registry.dispose();
});

it("leaves touch scrolling available before the hold and moves the row after a full hold", async () => {
  const { catalog, registry } = fixture();
  await using screen = await render(
    <RegistryContext value={registry}>
      <Board catalog={catalog} onError={() => {}} />
    </RegistryContext>,
    { router: false }, // This board exercises catalog state without app navigation.
  );
  using _timers = fakeTimers();
  const row = screen.container.querySelector<HTMLButtonElement>('[aria-label="Thread"]')!;
  const from = row.getBoundingClientRect();
  await act(() => row.dispatchEvent(touch("touchstart", row, from.x + 10, from.y + 10)));
  const scroll = touch("touchmove", row, from.x + 10, from.y + 40);
  await act(() => row.dispatchEvent(scroll));
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(scroll.defaultPrevented).toBe(false);
  expect(row.getAttribute("aria-pressed")).not.toBe("true");
  expect(catalog.getSnapshot().pins).toEqual([]);
  await act(() => row.dispatchEvent(touch("touchend", row, from.x + 10, from.y + 40)));

  await act(() => row.dispatchEvent(touch("touchstart", row, from.x + 10, from.y + 10)));
  await act(() => vi.advanceTimersByTimeAsync(199));
  expect(row.getAttribute("aria-pressed")).not.toBe("true");
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(row.getAttribute("aria-pressed")).toBe("true");
  const target = screen.container
    .querySelector<HTMLElement>('[data-catalog-drop="pins"]')!
    .getBoundingClientRect();
  const move = touch("touchmove", row, target.x + target.width / 2, target.y + target.height / 2);
  await act(() => row.dispatchEvent(move));
  expect(move.defaultPrevented).toBe(true);
  await act(() =>
    row.dispatchEvent(
      touch("touchend", row, target.x + target.width / 2, target.y + target.height / 2),
    ),
  );
  expect(catalog.getSnapshot().pins[0]?.entity.id).toBe("thread");
  registry.dispose();
});

it("drags a chat into a project and then into Pinned through the rendered targets", async () => {
  const { catalog, registry } = fixture();
  const onError = vi.fn();
  await using screen = await render(
    <RegistryContext value={registry}>
      <Board catalog={catalog} onError={onError} />
    </RegistryContext>,
    { router: false },
  );
  using _timers = fakeTimers();
  await (
    await beginDrag(screen, "Thread", "project")
  )();
  expect(
    catalog.getSnapshot().roots.find((entry) => entry.entity.id === "project")?.children[0]?.entity
      .id,
  ).toBe("thread");
  await (
    await beginDrag(screen, "Thread", "pins")
  )();
  expect(catalog.getSnapshot().pins[0]?.entity.id).toBe("thread");
  expect(
    catalog.getSnapshot().roots.find((entry) => entry.entity.id === "project")?.children[0]?.entity
      .id,
  ).toBe("thread");
  expect(onError.mock.calls.every(([error]) => error === null)).toBe(true);
  registry.dispose();
});

it("rejects a pointer drop after the system account changes", async () => {
  const { catalog, registry } = fixture();
  const onError = vi.fn();
  await using screen = await render(
    <RegistryContext value={registry}>
      <Board catalog={catalog} onError={onError} />
    </RegistryContext>,
    { router: false },
  );
  using _timers = fakeTimers();
  const release = await beginDrag(screen, "Thread", "pins");
  registry.set(minesAccountIdAtom, "other-account");
  await release();
  expect(catalog.getSnapshot().pins).toEqual([]);
  expect(onError).toHaveBeenLastCalledWith("Your account changed. Start this move again.");
  registry.dispose();
});

it("rejects a section over a project without falling through to the Library root", async () => {
  const { catalog, registry } = fixture();
  const original = catalog.getSnapshot().roots;
  const onError = vi.fn();
  await using screen = await render(
    <RegistryContext value={registry}>
      <Board catalog={catalog} onError={onError} />
    </RegistryContext>,
    { router: false },
  );
  using _timers = fakeTimers();
  await (
    await beginDrag(screen, "Work", "project", "blocked")
  )();
  expect(catalog.getSnapshot().roots).toEqual(original);
  expect(onError).toHaveBeenLastCalledWith(
    "This item cannot be placed here. Its destination may have changed.",
  );
  registry.dispose();
});

it("supports keyboard pickup, cancellation, and dropping into a project", async () => {
  const { catalog, registry } = fixture();
  const original = catalog.getSnapshot().roots;
  await using screen = await render(
    <RegistryContext value={registry}>
      <Board catalog={catalog} onError={() => {}} />
    </RegistryContext>,
    { router: false },
  );
  const handle = screen.container.querySelector<HTMLButtonElement>('[aria-label="Thread"]')!;
  await act(() => handle.focus());
  await userEvent.keyboard("{Space}");
  await vi.waitFor(() => expect(handle.getAttribute("aria-pressed")).toBe("true"));
  await userEvent.keyboard("{ArrowUp}{ArrowUp}{Escape}");
  await vi.waitFor(() => expect(handle.getAttribute("aria-pressed")).not.toBe("true"));
  expect(catalog.getSnapshot().roots).toEqual(original);
  expect(catalog.getSnapshot().pins).toEqual([]);
  await act(() => handle.focus());
  await userEvent.keyboard("{Space}");
  await vi.waitFor(() => expect(handle.getAttribute("aria-pressed")).toBe("true"));
  await userEvent.keyboard("{ArrowUp}{ArrowUp}");
  await vi.waitFor(() =>
    expect(
      screen.container.querySelector<HTMLElement>('[data-catalog-drop="project"]')?.dataset
        .catalogDropState,
    ).toBe("allowed"),
  );
  await userEvent.keyboard("{Space}");
  expect(
    catalog.getSnapshot().roots.find((entry) => entry.entity.id === "project")?.children[0]?.entity
      .id,
  ).toBe("thread");
  registry.dispose();
});
