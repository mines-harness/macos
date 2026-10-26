import { CONTACT_AVATAR_MAX_BYTES, CONTACT_AVATAR_MAX_LENGTH } from "@t3tools/contracts/contacts";
import * as Effect from "effect/Effect";
import { ContactsStore } from "./ContactsStore.ts";

export interface ContactsAvatarResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | null;
}

export const isContactsAvatarPath = (pathname: string) =>
  pathname.startsWith("/v1/contacts/avatars/");

function raster(value: string | null) {
  if (!value || value.length > CONTACT_AVATAR_MAX_LENGTH) return null;
  const match = value.match(/^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  const bytes = Buffer.from(match[2]!, "base64");
  if (!bytes.length || bytes.length > CONTACT_AVATAR_MAX_BYTES) return null;
  const valid =
    match[1] === "png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : match[1] === "jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : match[1] === "gif"
          ? ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
          : bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
            bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return valid ? { bytes, type: `image/${match[1]}` } : null;
}

const unavailable = (status: number): ContactsAvatarResponse => ({
  status,
  headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  body: null,
});

export const handleContactsAvatarRequest = Effect.fn("ContactsAvatarRoutes.handle")(
  function* (request: {
    readonly pathname: string;
    readonly method: string;
  }): Effect.fn.Return<ContactsAvatarResponse, never, ContactsStore> {
    const match = request.pathname.match(
      /^\/v1\/contacts\/avatars\/(mines-[a-f0-9]{20})\/([a-f0-9]{32})$/,
    );
    if (!match || (request.method !== "GET" && request.method !== "HEAD")) return unavailable(404);
    const store = yield* ContactsStore;
    const value = yield* store.avatar(match[1]!, match[2]!).pipe(Effect.orElseSucceed(() => null));
    const image = raster(value);
    if (!image) return unavailable(404);
    return {
      status: 200,
      headers: {
        "content-type": image.type,
        "content-length": String(image.bytes.length),
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        etag: `"${match[2]}"`,
      },
      body: request.method === "HEAD" ? null : image.bytes,
    };
  },
);
