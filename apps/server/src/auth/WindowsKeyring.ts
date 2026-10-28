import * as NodeModule from "node:module";

// SEA executables resolve native add-ons through the adjacent node_modules tree.
const requireForKeyring = NodeModule.createRequire(import.meta.url);

export function loadWindowsKeyring() {
  return requireForKeyring("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
}
