interface DeviceSyncScope {
  readonly accountId: string;
  readonly environmentId: string;
  readonly controlUrl: string;
}

type PreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storageKey(scope: DeviceSyncScope): string {
  return `mines:device-sync-disabled:v1:${JSON.stringify([
    new URL(scope.controlUrl).origin,
    scope.accountId,
    scope.environmentId,
  ])}`;
}

export function createMinesDeviceSyncPreferences(storage?: PreferenceStorage) {
  const currentStorage = () => storage ?? window.localStorage;
  return {
    canAutoEnable(scope: DeviceSyncScope): boolean {
      try {
        return currentStorage().getItem(storageKey(scope)) === null;
      } catch {
        return false;
      }
    },
    setEnabled(scope: DeviceSyncScope, enabled: boolean): void {
      const key = storageKey(scope);
      if (enabled) currentStorage().removeItem(key);
      else currentStorage().setItem(key, "disabled");
    },
  };
}

export const minesDeviceSyncPreferences = createMinesDeviceSyncPreferences();
