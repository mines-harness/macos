import { expect, it } from "vite-plus/test";

import { peerClientConnectionStatus } from "./peerClientStatus.logic";

it("reports connected only after the direct environment session is established", () => {
  expect(
    peerClientConnectionStatus({ enabled: true, phase: "connected", error: null }),
  ).toMatchObject({ label: "Connected", canRetry: true });
  expect(
    peerClientConnectionStatus({ enabled: true, phase: "available", error: null }),
  ).toMatchObject({ label: "Not checked", canRetry: true });
  expect(peerClientConnectionStatus(null)).toMatchObject({ label: "Not checked", canRetry: false });
});

it("does not mistake a local network outage for a remote offline verdict", () => {
  const status = peerClientConnectionStatus({ enabled: true, phase: "offline", error: null });
  expect(status.label).toBe("Not connected");
  expect(status.description).toContain("This device is offline");
  expect(status.description).toContain("has not been checked");
});

it("keeps a retry available during automatic reconnect backoff", () => {
  const status = peerClientConnectionStatus({
    enabled: true,
    phase: "reconnecting",
    error: "The direct connection was interrupted.",
  });
  expect(status).toMatchObject({ label: "Reconnecting", canRetry: true, retryLabel: "Retry" });
  expect(status.description).toContain("interrupted");
});

it("shows a failed check as unavailable rather than claiming the computer is offline", () => {
  expect(
    peerClientConnectionStatus({
      enabled: true,
      phase: "error",
      error: "The network blocked the direct connection.",
    }),
  ).toMatchObject({
    label: "Connection unavailable",
    description: "The network blocked the direct connection.",
    canRetry: true,
  });
});

it("does not offer a no-op check for disabled or incompatible saved computers", () => {
  expect(
    peerClientConnectionStatus({ enabled: false, phase: "connected", error: null }),
  ).toMatchObject({ label: "Disabled", canRetry: false });
  expect(
    peerClientConnectionStatus({
      enabled: true,
      phase: "unsupported",
      error: "Update Mines to connect.",
    }),
  ).toMatchObject({ label: "Update required", canRetry: false });
});
