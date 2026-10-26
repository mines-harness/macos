import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ContactsStore } from "./ContactsStore.ts";
import { handleContactsAvatarRequest } from "./ContactsAvatarRoutes.ts";

const friendId = `mines-${"a".repeat(20)}`;
const version = "f".repeat(32);
const pathname = `/v1/contacts/avatars/${friendId}/${version}`;
const gif = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

function fixture(avatar: string | null) {
  const calls: Array<{ friendId: string; version: string }> = [];
  const unused = () => Effect.die("Unexpected contacts mutation");
  const store = ContactsStore.of({
    initialize: Effect.void,
    ensureProfile: unused,
    updateProfile: unused,
    findProfile: unused,
    isContact: unused,
    addContact: unused,
    removeContact: unused,
    snapshot: unused,
    registerGroup: unused,
    invite: unused,
    transition: unused,
    groupMembers: unused,
    avatar: (friendId, version) =>
      Effect.sync(() => {
        calls.push({ friendId, version });
        return avatar;
      }),
  });
  return {
    calls,
    request: (method = "GET", path = pathname) =>
      handleContactsAvatarRequest({ method, pathname: path }).pipe(
        Effect.provideService(ContactsStore, store),
      ),
  };
}

it.effect("serves a bounded raster publicly with its actual MIME and immutable version", () =>
  Effect.gen(function* () {
    const test = fixture(gif);
    const result = yield* test.request();
    expect(result.status).toBe(200);
    expect(result.headers).toMatchObject({
      "content-type": "image/gif",
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=31536000, immutable",
      etag: `"${version}"`,
    });
    expect(Buffer.from(result.body!).toString("ascii", 0, 6)).toBe("GIF89a");
    expect(test.calls).toEqual([{ friendId, version }]);
    const head = yield* test.request("HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers["content-length"]).toBe(String(result.body!.length));
  }),
);

it.effect("does not fetch malformed friend IDs, versions or mutation methods", () =>
  Effect.gen(function* () {
    const test = fixture(gif);
    for (const [method, path] of [
      ["GET", `${pathname}/extra`],
      ["GET", pathname.replace(version, "invalid")],
      ["GET", pathname.replace(friendId, "someone@example.com")],
      ["POST", pathname],
    ]) {
      expect((yield* test.request(method, path)).status).toBe(404);
    }
    expect(test.calls).toEqual([]);
  }),
);

it.effect("rejects missing, non-raster, mismatched or oversized avatar content", () =>
  Effect.gen(function* () {
    for (const avatar of [
      null,
      "https://example.com/avatar.png",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:image/png;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      `data:image/gif;base64,${Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16_384)]).toString("base64")}`,
    ]) {
      const result = yield* fixture(avatar).request();
      expect(result.status).toBe(404);
      expect(result.body).toBeNull();
      expect(result.headers["cache-control"]).toBe("no-store");
    }
  }),
);
