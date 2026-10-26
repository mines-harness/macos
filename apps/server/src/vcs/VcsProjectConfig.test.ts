import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import * as VcsProjectConfig from "./VcsProjectConfig.ts";

const layerTest = VcsProjectConfig.layer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(NodeServices.layer),
);

describe("VcsProjectConfig", () => {
  it.layer(layerTest)("keeps old install project configuration separate", (it) => {
    it.effect("does not read or copy .t3code configuration", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "mines-vcs-isolated-" });
        const legacy = path.join(root, ".t3code", "vcs.json");
        yield* fs.makeDirectory(path.dirname(legacy), { recursive: true });
        yield* fs.writeFileString(legacy, '{"vcsKind":"jj"}');
        const service = yield* VcsProjectConfig.VcsProjectConfig;
        assert.equal(yield* service.resolveKind({ cwd: root }), "auto");
        assert.equal(yield* fs.readFileString(legacy), '{"vcsKind":"jj"}');
        assert.isFalse(yield* fs.exists(path.join(root, ".mines", "vcs.json")));
      }),
    );
  });
  it.layer(layerTest)("discovers .mines/vcs.json from nested workspaces", (it) => {
    it.effect("returns the configured kind", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "mines-vcs-config-test-",
        });
        const configDir = path.join(root, ".mines");
        const nested = path.join(root, "packages", "app");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          JSON.stringify({ vcs: { kind: "jj" } }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: nested });

        assert.equal(kind, "jj");
      }),
    );
  });

  it.layer(layerTest)("continues to parent configs after a candidate inspect failure", (it) => {
    it.effect("logs the failed candidate and returns the parent config", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "mines-vcs-config-test-",
        });
        const configDir = path.join(root, ".mines");
        const cwd = path.join(root, "invalid\0child");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          JSON.stringify({ vcs: { kind: "jj" } }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd });

        assert.equal(kind, "jj");
        const failedCandidate = path.join(cwd, ".mines", "vcs.json");
        const [error] = messages[0] as ReadonlyArray<unknown>;
        assert.instanceOf(error, VcsProjectConfig.VcsProjectConfigError);
        assert.equal(
          error.message,
          "Failed to inspect VCS project config at " + failedCandidate + ".",
        );
        assert.deepInclude(error, {
          operation: "inspect",
          cwd,
          configPath: failedCandidate,
          _tag: "VcsProjectConfigError",
        });
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });
  });

  it.layer(layerTest)("falls back to auto when config JSON is malformed", (it) => {
    it.effect("returns auto and logs the failed operation and path", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "mines-vcs-config-test-",
        });
        const configDir = path.join(root, ".mines");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(configDir, "vcs.json"), "{not json");

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
        const [error] = messages[0] as ReadonlyArray<unknown>;
        assert.instanceOf(error, VcsProjectConfig.VcsProjectConfigError);
        assert.equal(
          error.message,
          "Failed to decode VCS project config at " + path.join(configDir, "vcs.json") + ".",
        );
        assert.deepInclude(error.cause, { _tag: "SchemaError" });
        assert.deepInclude(error, {
          operation: "decode",
          cwd: root,
          configPath: path.join(configDir, "vcs.json"),
          _tag: "VcsProjectConfigError",
        });
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });
  });
});
