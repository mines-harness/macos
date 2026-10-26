import { useEffect, useSyncExternalStore } from "react";
import {
  decodeAppActivity,
  EMPTY_APP_ACTIVITY,
  recordAppActivity,
  summarizeAppActivity,
} from "./appActivity.logic";

const STORAGE_KEY = "mines:app-activity:v1";
const HEARTBEAT_MS = 15_000;
const listeners = new Set<() => void>();
let ledger = EMPTY_APP_ACTIVITY;
let sessionMs = 0;
let snapshot = summarizeAppActivity(ledger, Date.now(), sessionMs);

function readLedger() {
  try {
    return decodeAppActivity(globalThis.localStorage?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return ledger;
  }
}

function updateSnapshot(at: number) {
  snapshot = summarizeAppActivity(ledger, at, sessionMs);
  for (const listener of listeners) listener();
}

export function useTrackAppActivity(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    ledger = readLedger();
    updateSnapshot(Date.now());
    let activeSince: number | null = null;
    let storageFailed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const flush = () => {
      const now = Date.now();
      if (activeSince !== null) {
        // Sleep or a suspended renderer must not become hours of active use.
        const start = Math.max(activeSince, now - HEARTBEAT_MS * 2);
        ledger = recordAppActivity(storageFailed ? ledger : readLedger(), start, now);
        sessionMs += Math.max(0, now - start);
        activeSince = now;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(ledger));
          storageFailed = false;
        } catch {
          storageFailed = true;
        }
      }
      updateSnapshot(now);
    };
    const updateFocus = () => {
      flush();
      const active = document.visibilityState === "visible" && document.hasFocus();
      activeSince = active ? Date.now() : null;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      heartbeat = active ? setInterval(flush, HEARTBEAT_MS) : undefined;
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || storageFailed) return;
      ledger = readLedger();
      updateSnapshot(Date.now());
    };
    const onPageHide = () => {
      flush();
      activeSince = null;
      if (heartbeat !== undefined) clearInterval(heartbeat);
    };
    window.addEventListener("focus", updateFocus);
    window.addEventListener("blur", updateFocus);
    document.addEventListener("visibilitychange", updateFocus);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", updateFocus);
    window.addEventListener("storage", onStorage);
    updateFocus();
    return () => {
      onPageHide();
      window.removeEventListener("focus", updateFocus);
      window.removeEventListener("blur", updateFocus);
      document.removeEventListener("visibilitychange", updateFocus);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", updateFocus);
      window.removeEventListener("storage", onStorage);
    };
  }, [enabled]);
}

export function useAppActivity() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => snapshot,
  );
}
