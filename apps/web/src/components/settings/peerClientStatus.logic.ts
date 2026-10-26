import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";

export function peerClientConnectionStatus(
  connection:
    | (Pick<EnvironmentConnectionPresentation, "phase" | "error"> & { readonly enabled: boolean })
    | null,
) {
  if (connection === null)
    return {
      label: "Not checked",
      description: "Waiting for this computer's saved connection to load.",
      canRetry: false,
      retryLabel: "Check connection",
    };
  if (!connection.enabled)
    return {
      label: "Disabled",
      description: "Enable this computer in Your computers to check its connection.",
      canRetry: false,
      retryLabel: "Check connection",
    };
  switch (connection.phase) {
    case "connected":
      return {
        label: "Connected",
        description: "A direct connection to this computer is active.",
        canRetry: true,
        retryLabel: "Check connection",
      };
    case "connecting":
      return {
        label: "Connecting",
        description: "Testing the direct connection. Keep both devices awake.",
        canRetry: false,
        retryLabel: "Checking…",
      };
    case "reconnecting":
      return {
        label: "Reconnecting",
        description: connection.error ?? "The direct connection was interrupted. Trying again.",
        canRetry: true,
        retryLabel: "Retry",
      };
    case "error":
      return {
        label: "Connection unavailable",
        description:
          connection.error ?? "A direct connection could not be established. Try another network.",
        canRetry: true,
        retryLabel: "Retry",
      };
    case "offline":
      return {
        label: "Not connected",
        description:
          "This device is offline. The other computer's availability has not been checked.",
        canRetry: true,
        retryLabel: "Retry",
      };
    case "unsupported":
      return {
        label: "Update required",
        description: connection.error ?? "Update Mines on this computer before connecting.",
        canRetry: false,
        retryLabel: "Check connection",
      };
    case "available":
      return {
        label: "Not checked",
        description: "Check whether a direct connection to this computer can be established.",
        canRetry: true,
        retryLabel: "Check connection",
      };
  }
}
