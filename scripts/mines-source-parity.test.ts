import { assert, it } from "@effect/vitest";
import { compareSourceTrees } from "./mines-source-parity.ts";

it("reports shared-code drift and additions without mistaking repository presentation for platform behavior", () => {
  const canonical = [
    { path: "apps/web/composer.tsx", sha: "new", type: "blob" },
    { path: "packages/contracts/rpc.ts", sha: "same", type: "blob" },
    { path: "apps/desktop/tray.ts", sha: "mac-and-windows", type: "blob" },
    { path: "README.md", sha: "canonical readme", type: "blob" },
  ];
  const windows = [
    { path: "apps/web/composer.tsx", sha: "old", type: "blob" },
    { path: "packages/contracts/rpc.ts", sha: "same", type: "blob" },
    { path: "apps/desktop/secret.ts", sha: "windows-only", type: "blob" },
    { path: "README.md", sha: "windows readme", type: "blob" },
  ];
  assert.deepEqual(compareSourceTrees(canonical, windows, ["apps", "packages"]), [
    { path: "apps/desktop/secret.ts", canonical: null, repository: "windows-only" },
    { path: "apps/desktop/tray.ts", canonical: "mac-and-windows", repository: null },
    { path: "apps/web/composer.tsx", canonical: "new", repository: "old" },
  ]);
  assert.deepEqual(compareSourceTrees(canonical, windows, ["apps/mobile", "packages"]), []);
});
