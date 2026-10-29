import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  ComposerContextId,
  ThreadId,
  RunId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as GroupAttachments from "./GroupAttachments.ts";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import {
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";

const dependencies = ServerConfig.layerTest(process.cwd(), { prefix: "mines-group-files-" }).pipe(
  Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
);
const layer = GroupAttachments.layer.pipe(Layer.provideMerge(dependencies));
const stage = Effect.fn("test.stageGroupAttachment")(function* (text: string) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const attachment: ChatAttachment = {
    type: "file",
    id: ChatAttachmentId.make(createPendingAttachmentId("txt")),
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: Buffer.byteLength(text),
  };
  const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
  if (!path) throw new Error("Expected test attachment path");
  yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
  yield* fs.writeFileString(path, text);
  return attachment;
});

describe("group attachment storage and transfers", () => {
  it.effect(
    "publishes an exact run's viewed image inside its workspace and rejects paths outside it",
    () =>
      Effect.gen(function* () {
        const assets = yield* GroupAttachments.GroupAttachments;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "group-image-fixture-" });
        const workspace = path.join(root, "workspace");
        yield* fs.makeDirectory(workspace);
        const png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrU8AAAAASUVORK5CYII=",
          "base64",
        );
        yield* fs.writeFile(path.join(workspace, "screen.png"), png);
        yield* fs.writeFile(path.join(root, "private.png"), png);
        const at = DateTime.makeUnsafe("2026-10-29T00:00:00Z");
        const item: OrchestrationV2TurnItem = {
          id: TurnItemId.make("viewed-image"),
          threadId: ThreadId.make("native"),
          runId: RunId.make("group-run"),
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: null,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          type: "dynamic_tool",
          toolName: "view_image",
          viewedImagePath: "screen.png",
          input: {},
        };
        const image = yield* assets.itemAsset(item, "image", 0, workspace);
        expect(image.mimeType).toBe("image/png");
        expect(Buffer.from((yield* assets.read(image, 0)).data, "base64")).toEqual(png);
        expect(
          (yield* assets
            .itemAsset({ ...item, viewedImagePath: "../private.png" }, "image", 0, workspace)
            .pipe(Effect.flip)).code,
        ).toBe("dispatch");
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "claims durable group files and gives each native mine an independent copy with remapped context",
    () =>
      Effect.gen(function* () {
        const assets = yield* GroupAttachments.GroupAttachments;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const upload = yield* stage("original");
        const payload = {
          attachments: [upload],
          context: {
            version: 1 as const,
            records: [
              {
                version: 1 as const,
                kind: "file" as const,
                contextId: ComposerContextId.make("file-context"),
                label: "notes.txt",
                attachmentId: upload.id,
                name: upload.name,
                mimeType: upload.mimeType,
                sizeBytes: upload.sizeBytes,
              },
            ],
          },
        };
        const group = yield* assets.retain("group:files", payload);
        const first = yield* assets.forThread("mine:first", group);
        const second = yield* assets.forThread("mine:second", group);
        expect(parseThreadSegmentFromAttachmentId(group.attachments[0]!.id)).toBe("group-files");
        expect(first.attachments[0]!.id).not.toBe(second.attachments[0]!.id);
        expect(first.context?.records[0]).toMatchObject({ attachmentId: first.attachments[0]!.id });
        expect(second.context?.records[0]).toMatchObject({
          attachmentId: second.attachments[0]!.id,
        });
        const firstPath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: first.attachments[0]!,
        })!;
        const secondPath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: second.attachments[0]!,
        })!;
        yield* fs.writeFileString(firstPath, "changed!");
        expect(yield* fs.readFileString(secondPath)).toBe("original");
        expect(
          yield* fs.exists(
            resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment: upload })!,
          ),
        ).toBe(true);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "transfers bounded immutable chunks, rejects conflicting or out-of-order writes, and scopes receipt ownership",
    () =>
      Effect.gen(function* () {
        const assets = yield* GroupAttachments.GroupAttachments;
        const upload = yield* stage("a".repeat(400_000));
        const first = yield* assets.read(upload, 0);
        expect(Buffer.from(first.data, "base64").length).toBeLessThanOrEqual(192 * 1024);
        expect(first.complete).toBe(false);
        const later = yield* assets.read(upload, Buffer.from(first.data, "base64").length);
        expect((yield* assets.receive("wrong-order", later).pipe(Effect.flip)).code).toBe(
          "dispatch",
        );
        const received = yield* assets.transfer({ attachments: [upload] }, (chunk) =>
          assets.receive("group:receiver", chunk),
        );
        expect((yield* assets.receive("group:receiver", first)).id).toBe(
          received.attachments[0]!.id,
        );
        const changed = {
          ...first,
          data: Buffer.from("b".repeat(Buffer.from(first.data, "base64").length)).toString(
            "base64",
          ),
        };
        expect((yield* assets.receive("group:receiver", changed).pipe(Effect.flip)).code).toBe(
          "dispatch",
        );
        expect(yield* assets.cached("group:receiver", upload)).toEqual(received.attachments[0]);
        expect(yield* assets.cached("another-group", upload)).toBeUndefined();
        expect((yield* assets.restore("another-group", received).pipe(Effect.flip)).code).toBe(
          "dispatch",
        );
        expect((yield* assets.restore("group:receiver", received)).attachments).toEqual(
          received.attachments,
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "moves large structured context through verified scoped chunks and refuses foreign context before reading it",
    () =>
      Effect.gen(function* () {
        const assets = yield* GroupAttachments.GroupAttachments;
        const payload = {
          context: {
            version: 1 as const,
            records: Array.from({ length: 3 }, (_, index) => ({
              version: 1 as const,
              kind: "terminal" as const,
              contextId: ComposerContextId.make(`terminal-${index}`),
              label: "Terminal",
              terminalId: "terminal",
              terminalLabel: "Shell",
              lineStart: 0,
              lineEnd: 100,
              text: "context".repeat(5_000),
            })),
          },
        };
        const prepared = yield* assets.transfer(payload, (chunk) =>
          assets.receive("shared-upload:group:friend", chunk),
        );
        expect(prepared.context).toBeUndefined();
        expect(prepared.contextFile).toBeDefined();
        const restored = yield* assets.restore("shared-upload:group:friend", prepared);
        expect(restored.context).toEqual(payload.context);
        expect(
          (yield* assets.restore("shared-upload:other:friend", prepared).pipe(Effect.flip)).code,
        ).toBe("dispatch");
        expect((yield* assets.retain("group:other", prepared).pipe(Effect.flip)).code).toBe(
          "dispatch",
        );
      }).pipe(Effect.provide(layer)),
  );
});
