import type { PeerDeviceStatus } from "@t3tools/contracts";

const connectionStatuses = {
  connected: {
    label: "Connected",
    description: "A direct connection is active.",
    tone: "success",
  },
  reachable: {
    label: "Reachable",
    description: "The last direct connection check succeeded.",
    tone: "success",
  },
  unavailable: {
    label: "Couldn’t connect",
    description: "Keep both devices awake and try again, or use another network.",
    tone: "warning",
  },
  "approval-required": {
    label: "Approval required",
    description: "Approve this device before checking its direct connection.",
    tone: "warning",
  },
  "not-tested": {
    label: "Not checked",
    description: "Check this device to confirm a direct connection.",
    tone: "secondary",
  },
  unknown: {
    label: "Status unavailable",
    description: "Refresh or reconnect to check this device’s connection.",
    tone: "secondary",
  },
} as const;

export function describePeerDevice({
  status = "not-tested",
  online,
}: {
  readonly status?: PeerDeviceStatus["status"] | "unknown";
  readonly online?: boolean;
}) {
  return {
    ...connectionStatuses[status],
    presenceLabel: online === undefined ? "Presence unknown" : online ? "Online" : "Offline",
  };
}
