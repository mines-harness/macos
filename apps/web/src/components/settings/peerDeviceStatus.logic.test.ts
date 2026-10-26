import { describePeerDevice } from "./peerDeviceStatus.logic";
import { describe, expect, it } from "vite-plus/test";

describe("device connection status", () => {
  it("does not treat online discovery as proof of a direct connection", () => {
    const status = describePeerDevice({ online: true });
    expect(status.label).toBe("Not checked");
    expect(status.presenceLabel).toBe("Online");
  });

  it("keeps an established connection distinct from discovery being offline", () => {
    const status = describePeerDevice({ status: "connected", online: false });
    expect(status.label).toBe("Connected");
    expect(status.presenceLabel).toBe("Offline");
  });

  it("reports a failed direct check without declaring an online device offline", () => {
    const status = describePeerDevice({ status: "unavailable", online: true });
    expect(status.label).toBe("Couldn’t connect");
    expect(status.presenceLabel).toBe("Online");
    expect(status.description).toContain("another network");
  });

  it("does not guess device presence when talking to an older account service", () => {
    expect(describePeerDevice({ status: "reachable" }).presenceLabel).toBe("Presence unknown");
  });

  it("explains approval separately from an unsuccessful connection", () => {
    expect(describePeerDevice({ status: "approval-required" }).label).toBe("Approval required");
    expect(describePeerDevice({ status: "approval-required" }).description).toContain("Approve");
  });

  it("clears confidence in old connection data when the current status is unavailable", () => {
    expect(describePeerDevice({ status: "unknown", online: true }).label).toBe(
      "Status unavailable",
    );
  });
});
