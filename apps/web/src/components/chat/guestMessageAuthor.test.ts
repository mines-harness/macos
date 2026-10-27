import { expect, it } from "vite-plus/test";

import { guestMessageAuthorName } from "./guestMessageAuthor";

it("keeps each message's nickname after another guest joins or its author leaves", () => {
  const share = { guestName: "Alice" };
  expect(guestMessageAuthorName({ guestName: "Bob", guestId: "bob-session" }, share)).toBe("Bob");
  expect(guestMessageAuthorName({ guestName: "Charlie", guestId: "charlie-session" }, share)).toBe(
    "Charlie",
  );
});

it("uses the historical share nickname only for messages without a guest identity", () => {
  expect(guestMessageAuthorName({}, { guestName: "Alice" })).toBe("Alice");
  expect(guestMessageAuthorName({ guestId: "unknown-session" }, { guestName: "Alice" })).toBe(
    "Guest",
  );
  expect(guestMessageAuthorName({}, { guestName: null })).toBe("Guest");
});
