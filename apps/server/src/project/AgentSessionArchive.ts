import {
  ChatAttachmentId,
  type AgentSessionImportSource,
  type ChatFileAttachment,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { createDeterministicAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

// Raw history is streamed into ordinary authenticated attachments, which already have download
// access on desktop, web, and mobile. Chunking keeps arbitrarily large sources below upload limits.
const CHUNK_BYTES = 16 * 1024 * 1024;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const archiveSession = Effect.fn("AgentSessionArchive.archiveSession")(function* <E = never>(
  source: AgentSessionImportSource,
  threadId: ThreadId,
  content?: Stream.Stream<Uint8Array, E>,
  referenceFilePath?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
  const attachments: ChatFileAttachment[] = [];
  const stableKey = `${source.filePath}:${source.providerSessionId}:${source.size}:${source.mtimeMs}`;
  let index = 0;
  const save = Effect.fn("AgentSessionArchive.save")(function* (
    bytes: Uint8Array,
    name: string,
    extension: string,
  ) {
    const id = ChatAttachmentId.make(
      `${createDeterministicAttachmentId(threadId, `${stableKey}:${name}`)!}-${extension}`,
    );
    const destination = path.join(config.attachmentsDir, `${id}.${extension}`);
    // An interrupted write is never published. A retry replaces only this deterministic archive part.
    const pending = `${destination}.part`;
    yield* fs.writeFile(pending, bytes);
    yield* fs.rename(pending, destination);
    attachments.push({
      type: "file",
      id,
      name,
      mimeType: extension === "json" ? "application/json" : "application/octet-stream",
      sizeBytes: bytes.byteLength,
    });
  });
  const bytes: Stream.Stream<Uint8Array, E | PlatformError> =
    content ?? fs.stream(source.filePath, { chunkSize: CHUNK_BYTES });
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const flush = Effect.fn("AgentSessionArchive.flush")(function* () {
    if (pendingBytes === 0) return;
    const chunk = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const part of pending) {
      chunk.set(part, offset);
      offset += part.byteLength;
    }
    yield* save(chunk, `source-history-${String(++index).padStart(5, "0")}.bin`, "bin");
    pending = [];
    pendingBytes = 0;
  });
  yield* bytes.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const length = Math.min(CHUNK_BYTES - pendingBytes, chunk.byteLength - offset);
          pending.push(chunk.subarray(offset, offset + length));
          pendingBytes += length;
          offset += length;
          if (pendingBytes === CHUNK_BYTES) yield* flush();
        }
      }),
    ),
  );
  yield* flush();
  if (attachments.length === 0) return attachments;
  if (referenceFilePath) {
    let referenceIndex = 0;
    yield* fs
      .stream(referenceFilePath, { chunkSize: CHUNK_BYTES })
      .pipe(
        Stream.runForEach((bytes) =>
          save(
            bytes,
            `normalized-references-${String(++referenceIndex).padStart(5, "0")}.bin`,
            "bin",
          ),
        ),
      );
  }
  const manifest = new TextEncoder().encode(
    encodeJson({
      format: "mines-source-history-v1",
      source,
      representation: content ? "session-jsonl-export" : "original-bytes",
      reconstruction:
        "Concatenate source-history parts in numeric order. Concatenate normalized-references parts separately to obtain a JSONL index of known tool calls, results, and attachment references. Original tool records and attachment references are preserved verbatim; referenced files are not fetched or executed.",
      parts: attachments.map(({ name, id, sizeBytes }) => ({ name, id, sizeBytes })),
    }),
  );
  yield* save(manifest, "source-history-manifest.json", "json");
  return attachments;
});
