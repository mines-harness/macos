import { describe, expect, it } from "vite-plus/test";

import { createMinesDeviceSyncPreferences } from "./minesDeviceSyncPreference";

function persistentStorage(values = new Map<string, string>()) {
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  };
}

const computer = {
  accountId: "account-a",
  environmentId: "computer-a",
  controlUrl: "https://mines.example.com",
};

describe("Mines device sync preference", () => {
  it("enables a new computer by default and retains explicit Disable after a restart", () => {
    const persisted = persistentStorage();
    const firstLaunch = createMinesDeviceSyncPreferences(persisted.storage);
    expect(firstLaunch.canAutoEnable(computer)).toBe(true);
    firstLaunch.setEnabled(computer, false);
    const nextLaunch = createMinesDeviceSyncPreferences(
      persistentStorage(persisted.values).storage,
    );
    expect(nextLaunch.canAutoEnable(computer)).toBe(false);
  });

  it("isolates disabling to the account, computer and account service", () => {
    const preferences = createMinesDeviceSyncPreferences(persistentStorage().storage);
    preferences.setEnabled(computer, false);
    expect(preferences.canAutoEnable({ ...computer, accountId: "account-b" })).toBe(true);
    expect(preferences.canAutoEnable({ ...computer, environmentId: "computer-b" })).toBe(true);
    expect(
      preferences.canAutoEnable({ ...computer, controlUrl: "https://other.example.com" }),
    ).toBe(true);
    expect(preferences.canAutoEnable(computer)).toBe(false);
  });

  it("explicit Enable removes only that computer's opt-out", () => {
    const persisted = persistentStorage();
    const preferences = createMinesDeviceSyncPreferences(persisted.storage);
    const otherComputer = { ...computer, environmentId: "computer-b" };
    preferences.setEnabled(computer, false);
    preferences.setEnabled(otherComputer, false);
    preferences.setEnabled(computer, true);
    const nextLaunch = createMinesDeviceSyncPreferences(persisted.storage);
    expect(nextLaunch.canAutoEnable(computer)).toBe(true);
    expect(nextLaunch.canAutoEnable(otherComputer)).toBe(false);
    expect(persisted.values.size).toBe(1);
  });

  it("keeps Disable when the same service URL gains a trailing slash or path", () => {
    const preferences = createMinesDeviceSyncPreferences(persistentStorage().storage);
    preferences.setEnabled(computer, false);
    expect(
      preferences.canAutoEnable({ ...computer, controlUrl: "https://mines.example.com/" }),
    ).toBe(false);
    expect(
      preferences.canAutoEnable({ ...computer, controlUrl: "https://mines.example.com/account" }),
    ).toBe(false);
  });

  it("does not automatically expose a computer when its preference cannot be read", () => {
    const preferences = createMinesDeviceSyncPreferences({
      getItem: () => {
        throw new Error("Storage unavailable");
      },
      setItem: () => {},
      removeItem: () => {},
    });
    expect(preferences.canAutoEnable(computer)).toBe(false);
  });
});
