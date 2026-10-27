import { GuestSessionId, GuestShareId, type ThreadGuestShare } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { guestShareLinkAvailable } from "./guestShareLinkAvailability";

const now = Date.parse("2026-10-26T12:00:00Z");
const guest = {
  id: GuestSessionId.make("guest"),
  name: "Sam",
  joinedAt: "2026-10-26T11:00:00Z",
};
const share = (overrides: Partial<ThreadGuestShare> = {}): ThreadGuestShare => ({
  id: GuestShareId.make("share"),
  host: "guest.example.com",
  createdAt: "2026-10-26T10:00:00Z",
  expiresAt: "2026-10-26T13:00:00Z",
  guestName: null,
  messages: [],
  ...overrides,
});

describe("guestShareLinkAvailable", () => {
  it.each([null, undefined])("rejects a missing share (%s)", (missing) => {
    expect(guestShareLinkAvailable(missing, now)).toBe(false);
  });

  it("expires exactly at the cutoff, remaining available immediately before it", () => {
    const link = share({ expiresAt: "2026-10-26T12:00:00Z" });
    expect(guestShareLinkAvailable(link, now - 1)).toBe(true);
    expect(guestShareLinkAvailable(link, now)).toBe(false);
    expect(guestShareLinkAvailable(link, now + 1)).toBe(false);
  });

  it("keeps an exhausted link unavailable after its kicked guest leaves the roster", () => {
    const link = share({ maxGuests: 1, useCount: 1, guests: [guest], guestName: "Sam" });
    expect(guestShareLinkAvailable(link, now)).toBe(false);
    expect(guestShareLinkAvailable({ ...link, guests: [], guestName: null }, now)).toBe(false);
  });

  it.each([2, 3])("rejects lifetime use count %i at or above the limit", (useCount) => {
    expect(guestShareLinkAvailable(share({ maxGuests: 2, useCount, guests: [] }), now)).toBe(false);
  });

  it("allows an unexpired link with remaining lifetime uses after a guest leaves", () => {
    expect(guestShareLinkAvailable(share({ maxGuests: 3, useCount: 2, guests: [] }), now)).toBe(
      true,
    );
  });

  it("falls back to the roster count when the lifetime count is missing", () => {
    const link = share({ guests: [guest], maxGuests: 1 });
    expect(guestShareLinkAvailable(link, now)).toBe(false);
    expect(guestShareLinkAvailable({ ...link, maxGuests: 2 }, now)).toBe(true);
  });

  it("respects a zero lifetime count and an empty roster before the legacy nickname", () => {
    expect(guestShareLinkAvailable(share({ useCount: 0, guests: [guest] }), now)).toBe(true);
    expect(guestShareLinkAvailable(share({ guests: [], guestName: "Sam" }), now)).toBe(true);
  });

  it("counts a legacy nickname as one use and defaults the lifetime limit to one", () => {
    expect(guestShareLinkAvailable(share({ guestName: "Sam" }), now)).toBe(false);
    expect(guestShareLinkAvailable(share({ guestName: "Sam", maxGuests: 2 }), now)).toBe(true);
    expect(guestShareLinkAvailable(share(), now)).toBe(true);
  });
});
