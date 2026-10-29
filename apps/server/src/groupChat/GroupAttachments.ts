// @effect-diagnostics nodeBuiltinImport:off -- exclusive immutable copies and bounded random-access transfers are filesystem boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import {
  ChatAttachmentId,
  GroupChatError,
  type ChatAttachment,
  type GroupAttachmentChunk,
  OrchestrationMessageContext,
  type OrchestrationV2TurnItem,
  type GroupTransferredContext,
  type ProviderUserInputAnswers,
  UserInputAttachments,
} from "@t3tools/contracts";
import {
  htmlRenderFromToolItem,
  mcpAppFromToolItem,
  toolOutputImages,
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
} from "@t3tools/shared/toolOutput";
import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as AttachmentClaims from "../orchestration-v2/AttachmentClaims.ts";
import { isWorkspaceImagePreviewPath, mediaMimeType } from "@t3tools/shared/mediaPreview";
import { appendUserInputAttachmentPaths } from "../provider/userInputAttachments.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as FileSystem from "effect/FileSystem";
import {
  createDeterministicAttachmentId,
  parseAttachmentFileExtension,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeContext = Schema.encodeSync(Schema.fromJsonString(OrchestrationMessageContext));
const decodeContext = Schema.decodeEffect(Schema.fromJsonString(OrchestrationMessageContext));
const decodeTransferReceipt = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ scope: Schema.String, sourceId: Schema.String, attachment: Schema.Unknown }),
  ),
);
const decodeUserInputAttachments = Schema.decodeUnknownEffect(UserInputAttachments);
const CHUNK_BYTES = 192 * 1024;
type Payload = {
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext;
  readonly contextFile?: GroupTransferredContext;
};
type Prepared = {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext;
  readonly contextFile?: GroupTransferredContext;
};
const unavailable = () =>
  new GroupChatError({
    code: "dispatch",
    message:
      "The group attachment could not be transferred. Retry the message after reconnecting its host.",
  });
const remap = (payload: Payload, attachments: ReadonlyArray<ChatAttachment>): Prepared => {
  const context = payload.context
    ? remapComposerContextAttachments(
        { version: 1, records: payload.context.records },
        payload.attachments ?? [],
        attachments,
      )
    : undefined;
  return { attachments, ...(context ? { context } : {}) };
};

export class GroupAttachments extends Context.Service<
  GroupAttachments,
  {
    readonly prepareAnswers: (
      threadId: string,
      answers: ProviderUserInputAnswers,
      attachments?: UserInputAttachments,
    ) => Effect.Effect<
      { answers: ProviderUserInputAnswers; attachmentsByQuestionId: UserInputAttachments },
      GroupChatError
    >;
    readonly restore: (scope: string, payload: Payload) => Effect.Effect<Prepared, GroupChatError>;
    readonly itemAsset: (
      item: OrchestrationV2TurnItem,
      kind: "html" | "image",
      index?: number,
      workspaceRoot?: string,
    ) => Effect.Effect<ChatAttachment, GroupChatError>;
    readonly retain: (owner: string, payload: Payload) => Effect.Effect<Prepared, GroupChatError>;
    readonly forThread: (
      threadId: string,
      payload: Payload,
    ) => Effect.Effect<Prepared, GroupChatError>;
    readonly read: (
      attachment: ChatAttachment,
      offset: number,
    ) => Effect.Effect<GroupAttachmentChunk, GroupChatError>;
    readonly receive: (
      scope: string,
      chunk: GroupAttachmentChunk,
    ) => Effect.Effect<ChatAttachment, GroupChatError>;
    readonly cached: (
      scope: string,
      attachment: ChatAttachment,
    ) => Effect.Effect<ChatAttachment | undefined, GroupChatError>;
    readonly transfer: (
      payload: Payload,
      send: (chunk: GroupAttachmentChunk) => Effect.Effect<ChatAttachment, GroupChatError>,
    ) => Effect.Effect<Prepared, GroupChatError>;
  }
>()("mines/groupChat/GroupAttachments") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const documents = yield* DocumentText.DocumentText;
  const lock = yield* Semaphore.make(1);
  const path = (attachment: ChatAttachment) => {
    const value = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
    if (!value) throw unavailable();
    return value;
  };
  const target = (scope: string, attachment: ChatAttachment): ChatAttachment => {
    const base = createDeterministicAttachmentId(
      "group-transfer",
      JSON.stringify([scope, attachment.id]),
    );
    if (!base) throw unavailable();
    const extension = parseAttachmentFileExtension(attachment.id);
    return {
      ...attachment,
      id: ChatAttachmentId.make(
        `${base.replace(/^group-transfer-/, "pending-")}${extension ? `-${extension}` : ""}`,
      ),
    };
  };
  const read = Effect.fn("GroupAttachments.read")((attachment: ChatAttachment, offset: number) =>
    Effect.tryPromise({
      try: async () => {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > attachment.sizeBytes)
          throw unavailable();
        const file = await NodeFSP.open(path(attachment), "r");
        try {
          if (Number((await file.stat()).size) !== attachment.sizeBytes) throw unavailable();
          const data = Buffer.alloc(Math.min(CHUNK_BYTES, attachment.sizeBytes - offset));
          const { bytesRead } = await file.read(data, 0, data.length, offset);
          return {
            type: "attachment-chunk" as const,
            attachment,
            offset,
            data: data.subarray(0, bytesRead).toString("base64"),
            complete: offset + bytesRead === attachment.sizeBytes,
          };
        } finally {
          await file.close();
        }
      },
      catch: unavailable,
    }),
  );
  const receive = Effect.fn("GroupAttachments.receive")(
    (scope: string, chunk: GroupAttachmentChunk) =>
      lock.withPermit(
        Effect.tryPromise({
          try: async () => {
            if (
              (chunk.attachment.type !== "image" && chunk.attachment.type !== "file") ||
              chunk.attachment.sizeBytes > 64 * 1024 * 1024
            )
              throw unavailable();
            const attachment = target(scope, chunk.attachment);
            const finalPath = path(attachment);
            const bytes = Buffer.from(chunk.data, "base64");
            if (
              bytes.length > CHUNK_BYTES ||
              bytes.toString("base64") !== chunk.data ||
              chunk.offset + bytes.length > attachment.sizeBytes ||
              chunk.complete !== (chunk.offset + bytes.length === attachment.sizeBytes)
            )
              throw unavailable();
            await NodeFSP.mkdir(config.attachmentsDir, { recursive: true });
            const exists = await NodeFSP.stat(finalPath).then(
              () => true,
              () => false,
            );
            const file = await NodeFSP.open(
              exists ? finalPath : `${finalPath}.part`,
              exists ? "r" : "a+",
            );
            try {
              const size = Number((await file.stat()).size);
              if (chunk.offset > size) throw unavailable();
              if (chunk.offset < size || exists) {
                const previous = Buffer.alloc(bytes.length);
                const result = await file.read(previous, 0, bytes.length, chunk.offset);
                if (result.bytesRead !== bytes.length || !previous.equals(bytes))
                  throw unavailable();
              } else await file.write(bytes);
              if (chunk.complete && Number((await file.stat()).size) !== attachment.sizeBytes)
                throw unavailable();
            } finally {
              await file.close();
            }
            if (chunk.complete) {
              if (!exists) await NodeFSP.rename(`${finalPath}.part`, finalPath);
              const receipt = encodeJson({ scope, sourceId: chunk.attachment.id, attachment });
              try {
                await NodeFSP.writeFile(`${finalPath}.group-transfer.json`, receipt, {
                  flag: "wx",
                });
              } catch (cause) {
                if (
                  !(
                    cause &&
                    typeof cause === "object" &&
                    "code" in cause &&
                    cause.code === "EEXIST"
                  )
                )
                  throw cause;
                if (
                  (await NodeFSP.readFile(`${finalPath}.group-transfer.json`, "utf8")) !== receipt
                )
                  throw unavailable();
              }
            }
            return attachment;
          },
          catch: unavailable,
        }),
      ),
  );
  const verifyTransferred = Effect.fn("GroupAttachments.verifyTransferred")(function* (
    scope: string,
    attachment: ChatAttachment,
  ) {
    const receipt = yield* fs
      .readFileString(`${path(attachment)}.group-transfer.json`)
      .pipe(Effect.mapError(unavailable));
    const parsed = yield* decodeTransferReceipt(receipt).pipe(Effect.mapError(unavailable));
    if (
      parsed.scope !== scope ||
      encodeJson(parsed.attachment) !== encodeJson(attachment) ||
      target(scope, { ...attachment, id: ChatAttachmentId.make(parsed.sourceId) }).id !==
        attachment.id
    )
      return yield* unavailable();
  });
  const restoreContext = Effect.fn("GroupAttachments.restoreContext")(function* (
    payload: Payload,
    scope?: string,
  ) {
    if (scope !== undefined)
      for (const attachment of payload.attachments ?? [])
        yield* verifyTransferred(scope, attachment);
    if (!payload.contextFile)
      return {
        attachments: payload.attachments ?? [],
        ...(payload.context ? { context: payload.context } : {}),
      };
    const { attachment, sourceId } = payload.contextFile;
    if (
      scope === undefined ||
      target(scope, { ...attachment, id: ChatAttachmentId.make(sourceId) }).id !== attachment.id ||
      attachment.mimeType !== "application/json" ||
      attachment.sizeBytes > 64 * 1024 * 1024
    )
      return yield* unavailable();
    yield* verifyTransferred(scope, attachment);
    const encoded = yield* fs.readFileString(path(attachment)).pipe(Effect.mapError(unavailable));
    const context = yield* decodeContext(encoded).pipe(Effect.mapError(unavailable));
    return { attachments: payload.attachments ?? [], context };
  });
  const contextAttachment = Effect.fn("GroupAttachments.contextAttachment")(function* (
    context: OrchestrationMessageContext,
  ) {
    const encoded = encodeContext(context);
    const base = createDeterministicAttachmentId("group-context", encoded);
    if (!base) return yield* unavailable();
    const attachment: ChatAttachment = {
      type: "file",
      id: ChatAttachmentId.make(`${base}-json`),
      name: "context.json",
      mimeType: "application/json",
      sizeBytes: Buffer.byteLength(encoded),
    };
    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(config.attachmentsDir, { recursive: true });
        try {
          await NodeFSP.writeFile(path(attachment), encoded, { flag: "wx" });
        } catch (cause) {
          if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "EEXIST"))
            throw cause;
        }
      },
      catch: unavailable,
    });
    return attachment;
  });
  const retain = Effect.fn("GroupAttachments.retain")(function* (owner: string, incoming: Payload) {
    const payload = yield* restoreContext(incoming);
    const attachments = payload.attachments ?? [];
    if (
      attachments.some((attachment) => {
        const segment = parseThreadSegmentFromAttachmentId(attachment.id);
        return segment !== "pending" && segment !== toSafeThreadAttachmentSegment(owner);
      })
    )
      return yield* unavailable();
    const claimed = yield* AttachmentClaims.claimPendingAttachments({
      threadId: owner,
      attachments,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(DocumentText.DocumentText, documents),
      Effect.mapError(unavailable),
    );
    return remap(payload, claimed.attachments);
  });
  const transferOne = Effect.fn("GroupAttachments.transferOne")(function* (
    attachment: ChatAttachment,
    send: (chunk: GroupAttachmentChunk) => Effect.Effect<ChatAttachment, GroupChatError>,
  ) {
    let offset = 0;
    let received: ChatAttachment | undefined;
    do {
      const chunk = yield* read(attachment, offset);
      received = yield* send(chunk);
      offset += Buffer.from(chunk.data, "base64").length;
      if (chunk.complete) break;
    } while (offset < attachment.sizeBytes);
    if (!received) return yield* unavailable();
    return received;
  });
  const transfer = Effect.fn("GroupAttachments.transfer")(function* (
    payload: Payload,
    send: (chunk: GroupAttachmentChunk) => Effect.Effect<ChatAttachment, GroupChatError>,
  ) {
    const attachments = yield* Effect.forEach(
      payload.attachments ?? [],
      (attachment) => transferOne(attachment, send),
      { concurrency: 1 },
    );
    const prepared = remap(payload, attachments);
    if (prepared.context && Buffer.byteLength(encodeContext(prepared.context)) > 64 * 1024) {
      const staged = yield* contextAttachment(prepared.context);
      return {
        attachments,
        contextFile: { attachment: yield* transferOne(staged, send), sourceId: staged.id },
      };
    }
    return prepared;
  });
  const forThread = Effect.fn("GroupAttachments.forThread")(function* (
    threadId: string,
    incoming: Payload,
  ) {
    const payload = yield* restoreContext(incoming);
    const copies: ChatAttachment[] = [];
    for (const attachment of payload.attachments ?? []) {
      const copy = target(threadId, attachment);
      yield* Effect.tryPromise({
        try: async () => {
          try {
            await NodeFSP.copyFile(path(attachment), path(copy), NodeFS.constants.COPYFILE_EXCL);
          } catch (cause) {
            if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "EEXIST"))
              throw cause;
          }
        },
        catch: unavailable,
      });
      copies.push(copy);
    }
    return yield* retain(threadId, remap(payload, copies));
  });
  return GroupAttachments.of({
    forThread,
    prepareAnswers: Effect.fn("GroupAttachments.prepareAnswers")(
      function* (threadId, answers, incoming) {
        const prepared: Record<string, ReadonlyArray<ChatAttachment>> = {};
        for (const [key, files] of Object.entries(incoming ?? {}))
          prepared[key] = (yield* forThread(threadId, { attachments: files })).attachments;
        const attachmentsByQuestionId = yield* decodeUserInputAttachments(prepared).pipe(
          Effect.mapError(unavailable),
        );
        const enriched = yield* appendUserInputAttachmentPaths({
          answers,
          attachmentsByQuestionId,
          attachmentsDir: config.attachmentsDir,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(DocumentText.DocumentText, documents),
          Effect.mapError(unavailable),
        );
        return { answers: enriched, attachmentsByQuestionId };
      },
    ),
    restore: Effect.fn("GroupAttachments.restore")((scope, payload) =>
      restoreContext(payload, scope),
    ),
    itemAsset: Effect.fn("GroupAttachments.itemAsset")((item, kind, index = 0, workspaceRoot) =>
      Effect.tryPromise({
        try: async () => {
          if (item.type !== "dynamic_tool") throw unavailable();
          if (kind === "html") {
            const reference = htmlRenderFromToolItem(item) ?? mcpAppFromToolItem(item);
            if (!reference) throw unavailable();
            const file = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId: reference.attachmentId,
            });
            if (!file) throw unavailable();
            const info = await NodeFSP.stat(file);
            if (!info.isFile() || info.size > 64 * 1024 * 1024) throw unavailable();
            return {
              type: "file" as const,
              id: ChatAttachmentId.make(reference.attachmentId),
              name: "visual.html",
              mimeType: "text/html",
              sizeBytes: info.size,
            };
          }
          let image = toolOutputImages(item.output)[index];
          if (
            !image?.data &&
            index === 0 &&
            item.viewedImagePath &&
            workspaceRoot &&
            isWorkspaceImagePreviewPath(item.viewedImagePath)
          ) {
            const root = await NodeFSP.realpath(workspaceRoot);
            const file = await NodeFSP.realpath(NodePath.resolve(root, item.viewedImagePath));
            const relative = NodePath.relative(root, file);
            const mimeType = mediaMimeType(file);
            if (
              relative.startsWith("..") ||
              NodePath.isAbsolute(relative) ||
              !mimeType?.startsWith("image/")
            )
              throw unavailable();
            const handle = await NodeFSP.open(file, "r");
            let bytes: Buffer;
            try {
              const info = await handle.stat();
              if (!info.isFile() || info.size > 20 * 1024 * 1024) throw unavailable();
              bytes = Buffer.alloc(info.size);
              const read = await handle.read(bytes, 0, bytes.length, 0);
              if (read.bytesRead !== bytes.length) throw unavailable();
            } finally {
              await handle.close();
            }
            image = { mimeType, data: bytes.toString("base64") };
          }
          if (!image?.data || image.data.length > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH)
            throw unavailable();
          const bytes = Buffer.from(image.data, "base64");
          const id = createDeterministicAttachmentId(
            "group-image",
            encodeJson([
              item.id,
              index,
              NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
            ]),
          );
          if (!id) throw unavailable();
          const extension = image.mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
          const attachment: ChatAttachment = {
            type: "image",
            id: ChatAttachmentId.make(id),
            name: `image-${index + 1}.${extension}`,
            mimeType: image.mimeType,
            sizeBytes: bytes.length,
          };
          await NodeFSP.mkdir(config.attachmentsDir, { recursive: true });
          try {
            await NodeFSP.writeFile(path(attachment), bytes, { flag: "wx" });
          } catch (cause) {
            if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "EEXIST"))
              throw cause;
          }
          return attachment;
        },
        catch: unavailable,
      }),
    ),
    read,
    receive,
    retain,
    transfer,
    cached: Effect.fn("GroupAttachments.cached")((scope, source) =>
      Effect.tryPromise({
        try: async () => {
          const attachment = target(scope, source);
          const info = await NodeFSP.stat(path(attachment)).catch(() => undefined);
          return info?.size === source.sizeBytes ? attachment : undefined;
        },
        catch: unavailable,
      }),
    ),
  });
});
export const layer = Layer.effect(GroupAttachments, make);
