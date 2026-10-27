import { describe, expect, it } from "vite-plus/test";
import { GuestShareId, type ThreadGuestShare } from "@t3tools/contracts";

import { guestShareOwnerView, type GuestShareCreation } from "./guestShareOwnerState";

const share = (id: string, changes: Partial<ThreadGuestShare> = {}): ThreadGuestShare => ({
  id: GuestShareId.make(id),
  host: "host.example.test",
  createdAt: "2026-10-26T10:00:00.000Z",
  expiresAt: "2026-10-26T16:00:00.000Z",
  guestName: null,
  messages: [],
  maxGuests: 1,
  useCount: 0,
  ...changes,
});

const creation = (previousShareId: string | null = null): GuestShareCreation => ({
  result: { url: "https://example.test/guest#new", share: share("new") },
  previousShareId,
  synchronized: false,
});

describe("guest share owner synchronization", () => {
  it("waits for the current share before allowing a replacement", () => {
    expect(guestShareOwnerView({ loaded: false, share: null }, null).canCreate).toBe(false);
    expect(guestShareOwnerView({ loaded: false, share: share("cached") }, null).canCreate).toBe(
      false,
    );
    expect(guestShareOwnerView({ loaded: true, share: null }, null).canCreate).toBe(true);
    const existing = share("existing");
    expect(guestShareOwnerView({ loaded: true, share: existing }, null)).toMatchObject({
      canCreate: true,
      share: existing,
    });
  });

  it("shows the returned link while its subscription still shows the previous share", () => {
    const created = creation("old");
    const view = guestShareOwnerView({ loaded: true, share: share("old") }, created);
    expect(view).toMatchObject({
      canCreate: false,
      url: created.result.url,
      share: created.result.share,
    });
    expect(view.creation).toBe(created);
  });

  it("stops offering a created link when another device closes or replaces it", () => {
    const observed = guestShareOwnerView({ loaded: true, share: share("new") }, creation());
    expect(observed.creation?.synchronized).toBe(true);
    for (const nextShare of [null, share("replacement")]) {
      const next = guestShareOwnerView({ loaded: true, share: nextShare }, observed.creation);
      expect(next).toMatchObject({ creation: null, url: null, share: nextShare, canCreate: true });
    }
  });

  it("discards a later replacement even when the creation was not observed separately", () => {
    expect(
      guestShareOwnerView({ loaded: true, share: share("other") }, creation("old")),
    ).toMatchObject({ creation: null, url: null, canCreate: true });
  });

  it("offers a replacement when lifetime uses are exhausted even after all guests are kicked", () => {
    const exhausted = share("new", { useCount: 1, guests: [], guestName: "Former guest" });
    expect(guestShareOwnerView({ loaded: true, share: exhausted }, creation())).toMatchObject({
      exhausted: true,
      canCreate: true,
      url: null,
    });
  });

  it("keeps a link usable while it has remaining uses", () => {
    const active = share("new", { maxGuests: 2, useCount: 1 });
    expect(guestShareOwnerView({ loaded: true, share: active }, creation())).toMatchObject({
      exhausted: false,
      canCreate: false,
      url: "https://example.test/guest#new",
    });
  });
});
