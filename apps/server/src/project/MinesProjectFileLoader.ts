import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { MINES_PROJECT_FILE_NAME, type MinesProjectFile } from "@t3tools/contracts";
import { MinesProjectFileFromJson } from "@t3tools/shared/minesProjectFile";

const decodeMinesProjectFileJson = Schema.decodeEffect(MinesProjectFileFromJson);

export class MinesProjectFileLoadError extends Schema.TaggedError<MinesProjectFileLoadError>()(
  "MinesProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${MINES_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

export class MinesProjectFileLoader extends Context.Service<
  MinesProjectFileLoader,
  {
    /** Never fails; missing/unreadable/invalid files return none, with warnings for invalid files. */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<MinesProjectFile>>;
  }
>()("mines/project/MinesProjectFileLoader") {}

const logMinesProjectFileLoadError = (error: MinesProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: MinesProjectFileLoader["Service"]["load"] = Effect.fn("MinesProjectFileLoader.load")(
    function* (workspaceRoot) {
      const filePath = path.join(workspaceRoot, MINES_PROJECT_FILE_NAME);
      const raw = yield* fileSystem.readFileString(filePath).pipe(
        Effect.asSome,
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<string>())
              : logMinesProjectFileLoadError(
                  new MinesProjectFileLoadError({
                    operation: "read",
                    workspaceRoot,
                    filePath,
                    cause: error,
                  }),
                ).pipe(Effect.as(Option.none<string>())),
        }),
      );
      if (Option.isNone(raw)) {
        return Option.none<MinesProjectFile>();
      }
      return yield* decodeMinesProjectFileJson(raw.value).pipe(
        Effect.asSome,
        Effect.catchTags({
          SchemaError: (error) =>
            logMinesProjectFileLoadError(
              new MinesProjectFileLoadError({
                operation: "decode",
                workspaceRoot,
                filePath,
                cause: error,
              }),
            ).pipe(Effect.as(Option.none<MinesProjectFile>())),
        }),
      );
    },
  );

  return MinesProjectFileLoader.of({ load });
});

export const layer = Layer.effect(MinesProjectFileLoader, make);
