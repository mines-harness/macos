import { assert, it } from "@effect/vitest";

import { selectLocalMacSigningIdentity } from "./local-macos-signing.ts";

const first = "A".repeat(40);
const second = "B".repeat(40);
const identity = (fingerprint: string, kind = "Apple Development") =>
  `  1) ${fingerprint} "${kind}: Fixture Developer (FIXTURE123)"`;

it("automatically selects only a sole valid Apple Development identity", () => {
  assert.equal(
    selectLocalMacSigningIdentity(`${identity(first)}\n1 valid identities found`),
    first,
  );
});

it("refuses to choose between two developer identities", () => {
  assert.throws(
    () => selectLocalMacSigningIdentity(`${identity(first)}\n${identity(second)}`),
    /Pin a certificate/,
  );
});

it("uses a pinned developer identity without falling back to a different one", () => {
  assert.equal(
    selectLocalMacSigningIdentity(`${identity(first)}\n${identity(second)}`, second.toLowerCase()),
    second,
  );
  assert.throws(
    () => selectLocalMacSigningIdentity(identity(first), second),
    /valid Apple Development/,
  );
});

it("does not treat distribution or unrelated certificates as development identities", () => {
  assert.throws(
    () => selectLocalMacSigningIdentity(identity(first, "Developer ID Application")),
    /Found 0 eligible/,
  );
});
