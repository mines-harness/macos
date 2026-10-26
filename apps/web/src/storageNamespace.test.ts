import { afterEach, expect, it, vi } from "vite-plus/test";

function installStorage(entries: Record<string, string>): Storage {
  const values = new Map(Object.entries(entries));
  const storage: Storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("localStorage", storage);
  return storage;
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

it("starts fresh UI preferences without reading or deleting old settings and drafts", async () => {
  const oldState = JSON.stringify({ projectOrder: ["old-project"] });
  const oldDraft = JSON.stringify({ state: { prompt: "unsent draft" } });
  const storage = installStorage({
    "t3code:ui-state:v1": oldState,
    "t3code:renderer-state:v8": oldState,
    "codething:renderer-state:v4": oldState,
    "t3code:composer-drafts:v1": oldDraft,
  });
  const { useUiStateStore, persistState } = await import("./uiStateStore");

  expect(useUiStateStore.getState().projectOrder).toEqual([]);
  persistState({ ...useUiStateStore.getState(), projectOrder: ["new-project"] });

  expect(JSON.parse(storage.getItem("mines:ui-state:v1") ?? "{}").projectOrder).toEqual([
    "new-project",
  ]);
  expect(storage.getItem("t3code:ui-state:v1")).toBe(oldState);
  expect(storage.getItem("t3code:renderer-state:v8")).toBe(oldState);
  expect(storage.getItem("codething:renderer-state:v4")).toBe(oldState);
  expect(storage.getItem("t3code:composer-drafts:v1")).toBe(oldDraft);
});

it("reads mines settings without adopting old settings", async () => {
  const oldSettings = '{"old":"settings"}';
  const storage = installStorage({ "t3code:client-settings:v1": oldSettings });
  const { readBrowserClientSettings, writeBrowserClientSettings } =
    await import("./clientPersistenceStorage");
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts");

  expect(readBrowserClientSettings()).toBeNull();
  writeBrowserClientSettings(DEFAULT_CLIENT_SETTINGS);
  expect(readBrowserClientSettings()).toEqual(DEFAULT_CLIENT_SETTINGS);
  expect(storage.getItem("mines:client-settings:v1")).not.toBeNull();
  expect(storage.getItem("t3code:client-settings:v1")).toBe(oldSettings);
});

it("leaves old prompt stashes intact when initializing the fresh stash", async () => {
  const oldStash = JSON.stringify({ version: 2, state: { entries: [] } });
  const storage = installStorage({
    "t3code:prompt-stash:v2": oldStash,
    "t3code:prompt-stash:v1": "legacy stash",
  });
  const { usePromptStashStore } = await import("./promptStashStore");

  expect(usePromptStashStore.getState().entries).toEqual([]);
  expect(storage.getItem("t3code:prompt-stash:v2")).toBe(oldStash);
  expect(storage.getItem("t3code:prompt-stash:v1")).toBe("legacy stash");
  expect(storage.getItem("mines:prompt-stash:v2")).toBeNull();
});
