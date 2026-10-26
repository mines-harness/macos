import { describe, expect, it } from "vite-plus/test";
import { createPeerIdentity } from "./minesPeerTrust.ts";
import {
  genericMinesPushMessage,
  signMinesPushRequest,
  verifyMinesPushRequest,
} from "./minesPush.ts";

const host = createPeerIdentity(new Uint8Array(32).fill(7), "Private computer label");
const event = {
  action: "alert" as const,
  eventId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000001",
  kind: "needs-attention" as const,
};
describe("mines generic push boundary", () => {
  it("binds the payload to the current device key and purpose", () => {
    const signed = signMinesPushRequest(host, event, "nonce_000000000001", 100);
    expect(verifyMinesPushRequest(signed, 110).payload).toEqual(event);
    expect(() =>
      verifyMinesPushRequest({ ...signed, payload: { ...event, kind: "run-completed" } }, 110),
    ).toThrow();
    expect(() => verifyMinesPushRequest({ ...signed, purpose: "ticket" }, 110)).toThrow();
    expect(() => verifyMinesPushRequest(signed, 200)).toThrow();
    expect(JSON.stringify(signed)).not.toContain("Private computer label");
  });
  it("rejects text or thread fields anywhere instead of silently dropping them", () => {
    const signed = signMinesPushRequest(host, event, "nonce_000000000001", 100);
    for (const key of ["title", "body", "text", "threadId", "messages"]) {
      expect(() => verifyMinesPushRequest({ ...signed, [key]: "private" }, 110)).toThrow();
      expect(() =>
        verifyMinesPushRequest({ ...signed, payload: { ...event, [key]: "private" } }, 110),
      ).toThrow();
    }
  });
  it("creates only fixed notification text and opaque routing data", () => {
    const message = genericMinesPushMessage("ExpoPushToken[abcdefghijk]", event);
    expect(message.data).toEqual({ minesEventId: event.eventId, kind: event.kind });
    expect(message.title).toBe("mines");
    expect(message.body).toBe("An agent needs your attention. Open mines to continue.");
  });
});
