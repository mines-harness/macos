import { MinesCatalog, mergeCatalogUpdates } from "@t3tools/client-runtime/catalog";
import { openPersistedCatalog } from "@t3tools/client-runtime/catalog/persistence";
import { describe, expect, it, vi } from "vite-plus/test";
import { createBrowserCatalogStorage } from "./storage";

function fakeBroadcastChannels() {
  const channels = new Set<Channel>();
  const sent: unknown[] = [];
  class Channel extends EventTarget {
    constructor(readonly name: string) {
      super();
      channels.add(this);
    }
    postMessage(data: unknown) {
      sent.push(data);
      for (const channel of channels)
        if (channel !== this && channel.name === this.name)
          queueMicrotask(() => channel.dispatchEvent(new MessageEvent("message", { data })));
    }
    close() {
      channels.delete(this);
    }
  }
  return { Channel, sent };
}

describe("catalog window storage", () => {
  it("merges desktop window writes and reloads peers without broadcasting catalog contents", async () => {
    const { Channel, sent } = fakeBroadcastChannels();
    const records = new Map<string, string>();
    const modes: boolean[] = [];
    const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const fromBase64 = (text: string) =>
      Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
    vi.stubGlobal("BroadcastChannel", Channel);
    vi.stubGlobal("window", {
      desktopBridge: {
        getMinesCatalog: async (key: string) => records.get(key) ?? null,
        setMinesCatalog: async (key: string, snapshot: string, merge: boolean) => {
          modes.push(merge);
          const previous = records.get(key);
          const merged = toBase64(
            mergeCatalogUpdates(
              previous ? [fromBase64(previous), fromBase64(snapshot)] : [fromBase64(snapshot)],
            ),
          );
          records.set(key, merged);
          return merged;
        },
        clearMinesCatalog: async (key: string) => {
          records.delete(key);
        },
      },
    });
    const a = await openPersistedCatalog({
      storage: await createBrowserCatalogStorage("window-sync-test"),
    });
    const b = await openPersistedCatalog({
      storage: await createBrowserCatalogStorage("window-sync-test"),
    });
    try {
      const received = new Promise<void>((resolve) => {
        const stop = b.catalog.subscribe(() => {
          if (
            b.catalog.getSnapshot().entities.some((entity) => entity.title === "Private window A")
          ) {
            stop();
            resolve();
          }
        });
      });
      a.catalog.createSection("Private window A");
      await a.flush();
      await received;
      const returned = new Promise<void>((resolve) => {
        const stop = a.catalog.subscribe(() => {
          if (
            a.catalog.getSnapshot().entities.some((entity) => entity.title === "Private window B")
          ) {
            stop();
            resolve();
          }
        });
      });
      b.catalog.createSection("Private window B");
      await b.flush();
      await returned;
      expect(a.catalog.getSnapshot().entities).toEqual(b.catalog.getSnapshot().entities);
      expect(modes).toEqual([true, true]);
      expect(sent).toEqual(["changed", "changed"]);
      const restored = new MinesCatalog();
      restored.applyUpdate(fromBase64([...records.values()][0]!));
      expect(
        restored
          .getSnapshot()
          .entities.map((entity) => entity.title)
          .sort(),
      ).toEqual(["Private window A", "Private window B"]);
    } finally {
      await Promise.all([a.close(), b.close()]);
      vi.unstubAllGlobals();
    }
  });

  it("refuses unsafe browser writes when Web Locks are unavailable", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    try {
      await expect(createBrowserCatalogStorage("no-locks-test")).rejects.toThrow("Web Locks");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
