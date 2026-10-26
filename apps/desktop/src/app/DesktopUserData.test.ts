import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["win32", "darwin", "linux"] as const)(
  "isolates mines from existing upstream credentials on %s",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mines-profile-" });
      for (const sourceName of ["t3code", "t3code-v2", "T3 Code (Alpha)", "T3 Code (Dev)"]) {
        const source = path.join(directory, sourceName);
        yield* fs.makeDirectory(source, { recursive: true });
        yield* fs.writeFileString(path.join(source, "Local State"), "upstream-private-state");
      }
      for (const isDevelopment of [false, true]) {
        const destination = yield* resolveUserDataPath({
          appDataDirectory: directory,
          platform,
          isDevelopment,
        });
        assert.equal(destination, path.join(directory, isDevelopment ? "mines-dev" : "mines"));
        assert.isFalse(yield* fs.exists(path.join(destination, "Local State")));
      }
      assert.equal(
        yield* fs.readFileString(path.join(directory, "t3code", "Local State")),
        "upstream-private-state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
