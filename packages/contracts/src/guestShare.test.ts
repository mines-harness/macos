import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  guestShareGuests,
  guestSharePermission,
  GuestRedeemRequest,
  GuestShareCreateInput,
  GuestSubmitRequest,
  ThreadGuestShare,
} from "./guestShare.ts";
import { GuestShareView } from "./guestStream.ts";

const isRedeem = Schema.is(GuestRedeemRequest);
const isCreate = Schema.is(GuestShareCreateInput);
const isSubmit = Schema.is(GuestSubmitRequest);
const isShare = Schema.is(ThreadGuestShare);
const decodeShare = Schema.decodeUnknownSync(ThreadGuestShare);
const decodeView = Schema.decodeUnknownSync(GuestShareView);

describe("guest sharing options", () => {
  it("bounds permissions, lifetime capacity, and duration", () => {
    expect(
      isCreate({ threadId: "thread", permission: "send", maxGuests: 100, durationHours: 0.25 }),
    ).toBe(true);
    for (const options of [
      { permission: "owner" },
      { maxGuests: 0 },
      { maxGuests: 101 },
      { maxGuests: 1.5 },
      { durationHours: 0.24 },
      { durationHours: 169 },
    ]) {
      expect(isCreate({ threadId: "thread", ...options })).toBe(false);
    }
  });

  it("bounds optional message retry keys", () => {
    expect(isSubmit({ shareId: "share", text: "Hello", requestId: "retry-1" })).toBe(true);
    expect(isSubmit({ shareId: "share", text: "Hello", requestId: "x".repeat(129) })).toBe(false);
  });

  it("keeps legacy share defaults and permits a bounded sanitized roster", () => {
    const legacy = decodeShare({
      id: "share",
      host: "env.test",
      createdAt: "2026-10-26T00:00:00Z",
      expiresAt: "2026-10-27T00:00:00Z",
      guestName: "Sam",
      messages: [],
    });
    expect(guestSharePermission(legacy)).toBe("confirm");
    expect(guestShareGuests(legacy)).toEqual([]);
    expect(guestShareGuests(null)).toEqual([]);
    const guest = { id: "guest", name: "Sam", joinedAt: "2026-10-26T00:00:00Z" };
    expect(isShare({ ...legacy, guests: [guest] })).toBe(true);
    expect(isShare({ ...legacy, guests: Array.from({ length: 101 }, () => guest) })).toBe(false);
    const view = decodeView({
      shareId: legacy.id,
      title: "Shared mine",
      guestName: "Sam",
      expiresAt: legacy.expiresAt,
      messages: [],
      model: { driver: "codex", name: "Codex" },
      guestId: guest.id,
      guests: [{ ...guest, ipAddress: "192.0.2.1" }],
      permission: "send",
    });
    expect(view.guests?.[0]).toEqual(guest);
  });
});

describe("GuestRedeemRequest", () => {
  it("accepts a one-line name and rejects names that break the attribution line", () => {
    expect(isRedeem({ credential: "invite", name: "Maya Chen" })).toBe(true);
    for (const name of [
      "Maya\nowner",
      "Maya owner",
      "Maya owner",
      "Maya\u0007",
      "Theo\u202E (owner)",
      "Theo\u2066x",
    ]) {
      expect(isRedeem({ credential: "invite", name })).toBe(false);
    }
  });
});
