import {
  AgentSessionScanError,
  ThreadId,
  type ChatFileAttachment,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type AgentSessionImportSource,
  type AgentSessionProjectCandidate,
  type AgentSessionProjectGit,
  type AgentSessionScanResult,
  AgentSessionScanInput,
  isAgentSessionGeneratedContextTitle,
  type AgentSessionSourceReport,
  type AgentSessionSourceSection,
  type AgentSessionThreadCandidate,
  AgentSessionThreadProvenance,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { isBareGitConfig, parseOriginUrlFromGitConfig } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { repositoryPathFromRemoteUrl } from "@t3tools/source-control-core/server/SourceControlProvider";

import { createDeterministicAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ServerSettings from "../serverSettings.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { archiveSession } from "./AgentSessionArchive.ts";
import { readCodexAppCatalog } from "./CodexAppCatalog.ts";
import {
  discoverT3CodeSessions,
  loadT3CodeSession,
  type T3CodeSessionCandidate,
} from "./T3CodeAgentSessions.ts";
import {
  discoverExternalSessions,
  externalSessionArchive,
  loadExternalSession,
  type ExternalSessionCandidate,
} from "./ExternalAgentSessions.ts";
import {
  createTranscriptJsonReader,
  createTranscriptJsonSelector,
  TranscriptJsonLimitError,
} from "./AgentSessionJson.ts";

const TRANSCRIPT_PREFIX_BYTES = 32 * 1024;
const METADATA_READ_BYTES = 8 * 1024;
const MAX_TRANSCRIPT_SCAN_BYTES = 1024 * 1024;
const MAX_TITLE_RECOVERY_BYTES = 4 * 1024 * 1024;

const MAX_METADATA_RECORDS_PER_TRANSCRIPT = 1_000;
// Screenshot-heavy transcripts can reach GiB; select fields while streaming to avoid allocating payloads.
const MAX_IMPORT_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_IMPORT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_IMPORT_TRANSCRIPTS = 100;
const MAX_IMPORT_RECORDS = Number.MAX_SAFE_INTEGER;

const TranscriptContentBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  tool_use_id: Schema.optional(Schema.String),
  image_url: Schema.optional(Schema.String),
  source: Schema.optional(
    Schema.Struct({
      type: Schema.optional(Schema.String),
      path: Schema.optional(Schema.String),
      url: Schema.optional(Schema.String),
      media_type: Schema.optional(Schema.String),
    }),
  ),
});

const TranscriptMessage = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(TranscriptContentBlock)])),
  model: Schema.optional(Schema.String),
});

const CodexTurnMetadata = Schema.Struct({
  turn_id: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});

const TranscriptRecord = Schema.Struct({
  type: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  aiTitle: Schema.optional(Schema.String),
  customTitle: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
  message: Schema.optional(TranscriptMessage),
  payload: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      session_id: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      role: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      call_id: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Array(TranscriptContentBlock)),
      internal_chat_message_metadata_passthrough: Schema.optional(Schema.Unknown),
    }),
  ),
});

const MessageProjection = Schema.Array(
  Schema.Struct({
    role: Schema.Literals(["user", "assistant"]),
    text: Schema.String,
    createdAt: Schema.String,
  }),
);
const encodeMessages = Schema.encodeSync(Schema.fromJsonString(MessageProjection));
const decodeMessages = Schema.decodeUnknownEffect(Schema.fromJsonString(MessageProjection));
const encodeReference = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeScanInput = Schema.encodeSync(Schema.fromJsonString(AgentSessionScanInput));
const threadProvenance = Schema.decodeUnknownSync(AgentSessionThreadProvenance);
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeTranscriptRecord = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptRecord));
const decodeTranscriptValue = Schema.decodeUnknownOption(TranscriptRecord);
const selectTranscriptPath = createTranscriptJsonSelector(TranscriptRecord);
const decodeCodexTurnMetadata = Schema.decodeUnknownOption(CodexTurnMetadata);

type DecodedTranscriptRecord = typeof TranscriptRecord.Type;

interface AgentSessionTranscriptMetadata {
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly fallbackSessionId: string;
  readonly lastActiveAtMs: number;
}

export interface AgentSessionThreadMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface AgentSessionThread extends AgentSessionThreadProvenance {
  readonly source: AgentSessionSource;
  readonly providerDriver?: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly title: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<AgentSessionThreadMessage>;
  readonly nativeContinuation?: boolean;
  readonly partial?: boolean;
  readonly projectionFiles?: ReadonlyArray<string>;
  readonly messageCount?: number;
  readonly archiveAttachments?: ReadonlyArray<ChatFileAttachment>;
  readonly sourceSection?: AgentSessionSourceSection;
}

export type AgentSessionRecentThread =
  | {
      readonly _tag: "Importable";
      readonly thread: AgentSessionThread;
      readonly source: AgentSessionImportSource;
    }
  | (AgentSessionThreadProvenance & {
      readonly _tag: "AlreadyImported";
      readonly source: AgentSessionImportSource;
      readonly title?: string;
      readonly nativeTitle?: string;
      readonly sourceSection?: AgentSessionSourceSection;
    })
  | { readonly _tag: "Duplicate"; readonly source: AgentSessionImportSource }
  | {
      readonly _tag: "Skipped";
      readonly reason?: "deferred" | "unavailable" | "failed";
      readonly cursor?: number;
    };

export class AgentSessionScanner extends Context.Service<
  AgentSessionScanner,
  {
    readonly scan: (
      input?: AgentSessionScanInput,
    ) => Effect.Effect<AgentSessionScanResult, AgentSessionScanError>;
    readonly streamMessages: (
      thread: AgentSessionThread,
    ) => Stream.Stream<AgentSessionThreadMessage, AgentSessionScanError>;
    readonly recentThreads: (
      workspaceRoot: string,
      completedSources?: ReadonlyArray<AgentSessionImportSource>,
      input?: AgentSessionScanInput,
      titleRepairThreadIds?: ReadonlyArray<ThreadId>,
    ) => Stream.Stream<AgentSessionRecentThread, AgentSessionScanError>;
    readonly projectSourceSection: (
      workspaceRoot: string,
      input?: AgentSessionScanInput,
    ) => Effect.Effect<AgentSessionSourceSection | undefined>;
  }
>()("mines/project/AgentSessionScanner") {}

type AgentSessionSource = AgentSessionProjectCandidate["sources"][number];

interface RawCandidate {
  readonly cwd: string;
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadCount: number;
  readonly lastActiveAtMs: number | null;
  readonly title?: string;
  readonly sourceSection?: AgentSessionSourceSection;
  readonly transcripts: ReadonlyArray<{
    readonly filePath: string;
    readonly mtimeMs: number | null;
    readonly external?: ExternalSessionCandidate;
    readonly t3Code?: T3CodeSessionCandidate;
    readonly preview: AgentSessionThreadCandidate;
    readonly nativeTitle?: string;
  }>;
}

interface TranscriptCandidate {
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly providerInstanceId: ProviderInstanceId;
  readonly size: number;
}

interface MetadataReadBudget {
  bytesRemaining: number;
  operationsRemaining: number;
  recordsRemaining: number;
  truncated: boolean;
}

function selectMetadataTranscripts(transcripts: ReadonlyArray<TranscriptCandidate>) {
  const selected: Array<TranscriptCandidate> = [];
  let pending = Array.from(
    Map.groupBy(transcripts, (transcript) => transcript.providerInstanceId).values(),
    (entries) => entries.values(),
  );
  while (pending.length > 0) {
    const nextRound: typeof pending = [];
    for (const iterator of pending) {
      const next = iterator.next();
      if (next.done) continue;
      selected.push(next.value);
      nextRound.push(iterator);
    }
    pending = nextRound;
  }
  return selected;
}

function splitTranscriptRecords(contents: string, limit: number): string[] {
  const records = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  return records.split("\n", Math.min(limit, 0xffff_ffff));
}

function isTextContentBlock(block: typeof TranscriptContentBlock.Type): boolean {
  return block.type === "text" || block.type === "input_text" || block.type === "output_text";
}

function extractText(
  content: string | ReadonlyArray<typeof TranscriptContentBlock.Type> | undefined,
): string {
  if (typeof content === "string") return content.trim();
  if (content === undefined) return "";
  return content
    .filter(isTextContentBlock)
    .map((block) => block.text?.trim() ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

function normalizeTimestamp(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : fallback;
}

function codexTurnId(metadata: unknown): string | null {
  const decoded = decodeCodexTurnMetadata(metadata);
  if (
    Option.isNone(decoded) ||
    typeof decoded.value.turn_id !== "string" ||
    decoded.value.turn_id.trim().length === 0
  ) {
    return null;
  }
  return decoded.value.turn_id;
}

function isHiddenClaudeRecord(record: DecodedTranscriptRecord): boolean {
  return record.isMeta === true || record.isCompactSummary === true;
}

// Claude repeats session fields on records that need not be retained.
interface ClaudeFields {
  readonly sessionId: string | undefined;
  readonly title: string | undefined;
  readonly customTitle: string | null;
  readonly model: string | undefined;
}

const emptyClaudeFields: ClaudeFields = {
  sessionId: undefined,
  title: undefined,
  customTitle: null,
  model: undefined,
};

function foldClaudeFields(fields: ClaudeFields, record: DecodedTranscriptRecord): ClaudeFields {
  if (isHiddenClaudeRecord(record)) return fields;
  const model = record.message?.model?.trim();
  return {
    sessionId: record.sessionId?.trim() || fields.sessionId,
    title: record.aiTitle?.trim() || fields.title,
    // Claude flushes the AI title after the user's rename; an empty rename clears it.
    customTitle:
      record.customTitle === undefined ? fields.customTitle : record.customTitle.trim() || null,
    // Claude uses this sentinel for local error responses. It is not a
    // model ID that can be selected when the imported session resumes.
    model: model && model !== "<synthetic>" ? model : fields.model,
  };
}

// Codex records setup context as user text ahead of the real request. Skip
// these leading blocks when deriving a title; imported messages keep them.
const CODEX_TITLE_PREAMBLE =
  /^(?:\s*(?:<(recommended_plugins|environment_context|user_instructions|INSTRUCTIONS|in-app-browser-context|external_codex_apps_open_page)(?:\s[^>]*)?>[\s\S]*?<\/\1>|# AGENTS\.md instructions\b[^\n]*|## My request for Codex:))+/;

function deriveTitle(source: AgentSessionSource, text: string): string | undefined {
  const request = source === "codex" ? text.replace(CODEX_TITLE_PREAMBLE, "") : text;
  const title = request.trim().split("\n")[0]?.slice(0, 100).trim();
  return title && (source !== "codex" || !isAgentSessionGeneratedContextTitle(title))
    ? title
    : undefined;
}

export function parseAgentSessionTranscript(
  input: AgentSessionTranscriptMetadata & {
    readonly contents: string;
  },
  lines = splitTranscriptRecords(input.contents, MAX_IMPORT_RECORDS + 1),
): AgentSessionThread | null {
  if (lines.length > MAX_IMPORT_RECORDS) return null;
  const records = lines.flatMap((line) => Option.toArray(decodeTranscriptRecord(line)));
  const claudeFields =
    input.source === "claudeAgent"
      ? records.reduce(foldClaudeFields, emptyClaudeFields)
      : emptyClaudeFields;
  return parseAgentSessionRecords(input, records, claudeFields);
}

function parseAgentSessionRecords(
  input: AgentSessionTranscriptMetadata,
  records: ReadonlyArray<DecodedTranscriptRecord>,
  claudeFields: ClaudeFields,
): AgentSessionThread | null {
  const fallbackTimestamp = DateTime.formatIso(DateTime.makeUnsafe(input.lastActiveAtMs));
  // Claude filenames are session IDs. Codex rollout filenames include extra
  // timestamp text, so only transcript metadata can provide a resumable ID.
  let providerSessionId =
    input.source === "codex" ? "" : (claudeFields.sessionId ?? input.fallbackSessionId);
  const title = claudeFields.title ?? null;
  let model = claudeFields.model ?? null;
  let derivedTitle: string | undefined;
  let hasCodexSessionId = false;
  const messages: Array<AgentSessionThreadMessage & { readonly codexResponseUser: boolean }> = [];
  let firstUserMessage:
    | (AgentSessionThreadMessage & { readonly codexResponseUser: boolean })
    | undefined;
  const canonicalCodexResponseUserIndices = new Set<number>();
  let canonicalUserTextsInTurn = new Set<string>();
  let responseUsersInTurn: Array<{
    readonly index: number;
    readonly turnId: string;
    readonly text: string;
  }> = [];
  const finishCodexTurn = () => {
    const canonicalTurnIds = new Set(
      responseUsersInTurn.flatMap((responseUser) =>
        canonicalUserTextsInTurn.has(responseUser.text) ? [responseUser.turnId] : [],
      ),
    );
    for (const responseUser of responseUsersInTurn) {
      if (canonicalTurnIds.has(responseUser.turnId)) {
        canonicalCodexResponseUserIndices.add(responseUser.index);
      }
    }
    canonicalUserTextsInTurn = new Set();
    responseUsersInTurn = [];
  };
  if (input.source === "codex") {
    let recordIndex = -1;
    for (const record of records) {
      recordIndex += 1;
      if (
        record.type === "response_item" &&
        record.payload?.type === "message" &&
        record.payload.role === "assistant"
      ) {
        finishCodexTurn();
        continue;
      }
      if (record.type === "event_msg" && record.payload?.type === "user_message") {
        const text = record.payload.message?.trim() ?? "";
        if (text.length > 0) canonicalUserTextsInTurn.add(text);
        continue;
      }
      if (
        record.type === "response_item" &&
        record.payload?.type === "message" &&
        record.payload.role === "user"
      ) {
        const turnId = codexTurnId(record.payload.internal_chat_message_metadata_passthrough);
        const text = extractText(record.payload.content);
        if (turnId !== null && text.length > 0) {
          responseUsersInTurn.push({ index: recordIndex, turnId, text });
        }
      }
    }
    finishCodexTurn();
  }

  const retainMessage = (
    message: AgentSessionThreadMessage & { readonly codexResponseUser: boolean },
  ) => {
    if (firstUserMessage === undefined && message.role === "user") {
      firstUserMessage = message;
    }
    if (derivedTitle === undefined && message.role === "user") {
      derivedTitle = deriveTitle(input.source, message.text);
    }
    messages.push(message);
  };

  const hasMatchingCodexEventInTurn = (text: string) => {
    const comparisonText = text.trim();
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === "assistant") return false;
      if (
        message?.role === "user" &&
        !message.codexResponseUser &&
        message.text.trim() === comparisonText
      ) {
        return true;
      }
    }
    return false;
  };

  let recordIndex = -1;
  for (const record of records) {
    recordIndex += 1;
    if (input.source === "claudeAgent") {
      if (isHiddenClaudeRecord(record)) continue;
      if (record.type !== "user" && record.type !== "assistant") continue;
      const text = extractText(record.message?.content);
      if (text.length === 0) continue;
      retainMessage({
        role: record.type,
        text,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: false,
      });
      continue;
    }

    if (record.type === "session_meta") {
      const sessionId = record.payload?.id?.trim() || record.payload?.session_id?.trim();
      if (!hasCodexSessionId && sessionId) {
        providerSessionId = sessionId;
        hasCodexSessionId = true;
      }
      continue;
    }
    if (record.type === "turn_context" && record.payload?.model?.trim()) {
      model = record.payload.model.trim();
      continue;
    }
    if (record.type === "event_msg" && record.payload?.type === "user_message") {
      const text = record.payload.message ?? "";
      if (text.trim().length === 0) continue;
      // Codex can duplicate prompts across formats; remove only matching response copies.
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role === "assistant") break;
        if (message?.codexResponseUser === true && message.text.trim() === text.trim()) {
          if (firstUserMessage === message) firstUserMessage = undefined;
          messages.splice(index, 1);
          break;
        }
      }
      retainMessage({
        role: "user",
        text,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: false,
      });
      continue;
    }
    if (
      record.type !== "response_item" ||
      record.payload?.type !== "message" ||
      (record.payload.role !== "user" && record.payload.role !== "assistant")
    ) {
      continue;
    }

    const extractedText = extractText(record.payload.content);
    if (extractedText.length === 0) continue;
    if (record.payload.role === "user" && canonicalCodexResponseUserIndices.has(recordIndex)) {
      continue;
    }
    if (record.payload.role === "user" && hasMatchingCodexEventInTurn(extractedText)) {
      continue;
    }
    retainMessage({
      role: record.payload.role,
      text: extractedText,
      createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
      codexResponseUser: record.payload.role === "user",
    });
  }

  const visibleMessages = messages.map(
    ({ codexResponseUser: _codexResponseUser, ...message }) => message,
  );
  const nativeContinuation = input.source !== "codex" || hasCodexSessionId;
  if (providerSessionId.trim().length === 0) providerSessionId = input.fallbackSessionId;
  if (providerSessionId.trim().length === 0) return null;
  const retainedMessages = [...visibleMessages];
  if (firstUserMessage !== undefined && !messages.includes(firstUserMessage)) {
    const { codexResponseUser: _codexResponseUser, ...visibleFirstUserMessage } = firstUserMessage;
    retainedMessages.unshift(visibleFirstUserMessage);
  }

  return {
    source: input.source,
    providerInstanceId: input.providerInstanceId,
    providerSessionId,
    title: claudeFields.customTitle ?? title ?? derivedTitle ?? "Imported mine",
    model,
    createdAt: retainedMessages[0]?.createdAt ?? fallbackTimestamp,
    updatedAt: fallbackTimestamp,
    messages: retainedMessages,
    nativeContinuation,
    partial:
      firstUserMessage === undefined ||
      records.some(
        (record) =>
          (record.type === "response_item" && record.payload?.type !== "message") ||
          [record.message?.content, record.payload?.content].some(
            (content) =>
              Array.isArray(content) && content.some((block) => !isTextContentBlock(block)),
          ),
      ),
  };
}

function extractDecodedCwd(record: DecodedTranscriptRecord): string | null {
  const cwd = record.cwd?.trim() || record.payload?.cwd?.trim();
  return cwd && cwd.length > 0 ? cwd : null;
}

function normalizedReferences(record: DecodedTranscriptRecord, sourceRecord: number) {
  const references: Array<{
    kind: string;
    sourceRecord: number;
    sourcePath: string;
    id?: string;
    name?: string;
    reference?: string;
  }> = [];
  const payload = record.payload;
  if (
    record.type === "response_item" &&
    (payload?.type === "function_call" ||
      payload?.type === "function_call_output" ||
      payload?.type === "custom_tool_call" ||
      payload?.type === "custom_tool_call_output")
  ) {
    references.push({
      kind: payload.type.endsWith("output") ? "tool-result" : "tool-call",
      sourceRecord,
      sourcePath: "payload",
      ...(payload.call_id ? { id: payload.call_id } : {}),
      ...(payload.name ? { name: payload.name } : {}),
    });
  }
  for (const [sourcePath, content] of [
    ["message.content", record.message?.content],
    ["payload.content", payload?.content],
  ] as const) {
    if (!Array.isArray(content)) continue;
    for (const [index, block] of content.entries()) {
      const kind =
        block.type === "tool_use"
          ? "tool-call"
          : block.type === "tool_result"
            ? "tool-result"
            : block.type === "image" ||
                block.type === "input_image" ||
                block.type === "document" ||
                block.type === "file"
              ? "attachment-reference"
              : null;
      if (kind === null) continue;
      const reference = block.source?.path ?? block.source?.url ?? block.image_url;
      references.push({
        kind,
        sourceRecord,
        sourcePath: `${sourcePath}[${index}]`,
        ...(block.id || block.tool_use_id ? { id: block.id ?? block.tool_use_id } : {}),
        ...(block.name ? { name: block.name } : {}),
        ...(reference
          ? { reference: reference.startsWith("data:") ? "embedded in source archive" : reference }
          : {}),
      });
    }
  }
  return references;
}

function shouldRetainDecodedRecord(
  source: AgentSessionSource,
  record: DecodedTranscriptRecord,
): boolean {
  if (source === "claudeAgent") {
    if (isHiddenClaudeRecord(record) || (record.type !== "user" && record.type !== "assistant")) {
      return false;
    }
    const content = record.message?.content;
    return typeof content === "string"
      ? content.trim().length > 0
      : (content?.some(
          (block) => isTextContentBlock(block) && (block.text?.trim().length ?? 0) > 0,
        ) ?? false);
  }
  if (extractDecodedCwd(record) !== null) return true;
  return (
    record.type === "session_meta" ||
    record.type === "turn_context" ||
    (record.type === "event_msg" && record.payload?.type === "user_message") ||
    (record.type === "response_item" &&
      record.payload?.type === "message" &&
      (record.payload.role === "user" || record.payload.role === "assistant"))
  );
}

function extractCwd(
  line: string,
  source: AgentSessionSource,
): { cwd: string; sessionId?: string; title?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const payload = record.payload;
  const nested =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : undefined;
  const cwd = typeof record.cwd === "string" && record.cwd.trim() ? record.cwd : nested?.cwd;
  if (typeof cwd !== "string" || !cwd.trim()) return null;
  const sessionId =
    source === "codex"
      ? record.type === "session_meta"
        ? nested?.id
        : nested?.session_id
      : record.sessionId;
  const title = record.customTitle ?? record.aiTitle;
  return {
    cwd,
    ...(typeof sessionId === "string" ? { sessionId } : {}),
    ...(typeof title === "string" && title.trim() ? { title: title.trim() } : {}),
  };
}

function threadCandidateKey(
  source: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  filePath: string,
  sessionId = "",
) {
  return createDeterministicAttachmentId(
    "import-thread",
    `${source}\0${providerInstanceId}\0${filePath}\0${sessionId}`,
  )!;
}

function transcriptIdentity(filePath: string, stats: FileSystem.File.Info) {
  return {
    filePath,
    size: Number(stats.size),
    mtimeMs: Option.match(stats.mtime, { onNone: () => null, onSome: (date) => date.getTime() }),
    device: Number(stats.dev),
    inode: Option.match(stats.ino, { onNone: () => null, onSome: String }),
    birthtimeMs: Option.match(stats.birthtime, {
      onNone: () => null,
      onSome: (date) => date.getTime(),
    }),
  };
}

type TranscriptIdentity = Pick<
  AgentSessionImportSource,
  "filePath" | "size" | "mtimeMs" | "device" | "inode" | "birthtimeMs"
>;

const fileIdKey = (inode: TranscriptIdentity["inode"]) => (inode === null ? null : String(inode));

function sameTranscriptIdentity(left: TranscriptIdentity, right: TranscriptIdentity): boolean {
  // Unsafe legacy numbers may already have lost file ID precision.
  if (
    (typeof left.inode === "number" && !Number.isSafeInteger(left.inode)) ||
    (typeof right.inode === "number" && !Number.isSafeInteger(right.inode))
  ) {
    return false;
  }
  return (
    left.filePath === right.filePath &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.device === right.device &&
    fileIdKey(left.inode) === fileIdKey(right.inode) &&
    left.birthtimeMs === right.birthtimeMs
  );
}

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig.ServerConfig;
  // Concurrent client imports must not hold multiple selected-history budgets.
  const importReadLock = yield* Semaphore.make(1);
  const path = yield* Path.Path;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const hostEnvironment = yield* HostProcess.Environment;
  const homeDir = yield* HostProcess.HomeDirectory;
  let cachedCodexCatalogs: ReadonlyMap<
    ProviderInstanceId,
    Effect.Success<ReturnType<typeof readCodexAppCatalog>>
  > = new Map();
  let cachedCodexCatalogKey: string | null = null;

  const listDirectory = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  const statOption = (target: string) =>
    fileSystem.stat(target).pipe(Effect.asSome, Effect.orElseSucceed(Option.none));

  const directoryIdentity = Effect.fn("AgentSessionScanner.directoryIdentity")(function* (
    target: string,
    knownStats?: FileSystem.File.Info,
  ) {
    const resolved = path.resolve(target);
    const stats = knownStats === undefined ? yield* statOption(resolved) : Option.some(knownStats);
    if (Option.isSome(stats) && Option.isSome(stats.value.ino) && stats.value.ino.value > 0n) {
      return `inode:${stats.value.dev}:${stats.value.ino.value}`;
    }
    const realPath = yield* fileSystem
      .realPath(resolved)
      .pipe(Effect.orElseSucceed(() => resolved));
    return `path:${normalizeProjectPathForComparison(realPath)}`;
  });

  const readGitIdentity = Effect.fn("AgentSessionScanner.readGitIdentity")(function* (
    directory: string,
  ): Effect.fn.Return<
    | { readonly _tag: "Repository"; readonly git: AgentSessionProjectGit | null }
    | { readonly _tag: "Worktree" }
    | { readonly _tag: "NotGit" }
  > {
    const gitPath = path.join(directory, ".git");
    const gitStats = yield* statOption(gitPath);
    if (Option.isNone(gitStats)) return { _tag: "NotGit" } as const;
    let gitDir = gitPath;
    if (gitStats.value.type !== "Directory") {
      const pointer = yield* fileSystem
        .readFileString(gitPath)
        .pipe(Effect.orElseSucceed(() => ""));
      const target = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
      if (target === undefined || target.length === 0) return { _tag: "NotGit" } as const;
      gitDir = path.resolve(directory, target);
    }
    const linkedWorktree =
      gitStats.value.type !== "Directory" && /[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(gitDir);
    if (linkedWorktree) {
      const commonDir = yield* fileSystem
        .readFileString(path.join(gitDir, "commondir"))
        .pipe(Effect.orElseSucceed(() => ""));
      if (commonDir.trim().length === 0) return { _tag: "Worktree" } as const;
      gitDir = path.resolve(gitDir, commonDir.trim());
    }
    const configText = yield* fileSystem
      .readFileString(path.join(gitDir, "config"))
      .pipe(Effect.orElseSucceed(() => ""));
    // Bare repositories have no main checkout, so offer their linked worktrees independently.
    if (linkedWorktree && !isBareGitConfig(configText)) return { _tag: "Worktree" } as const;
    const originUrl = parseOriginUrlFromGitConfig(configText);
    return {
      _tag: "Repository",
      git: {
        remoteKey:
          originUrl === null ? null : sourceControlDefinitions.repositoryKeyFromRemote(originUrl),
        repository: repositoryPathFromRemoteUrl(originUrl),
      },
    } as const;
  });

  const readCwd = Effect.fn("AgentSessionScanner.readCwd")(function* (
    source: AgentSessionSource,
    transcript: TranscriptCandidate,
    budget: MetadataReadBudget,
  ) {
    if (transcript.size === 0) return null;
    if (
      budget.bytesRemaining === 0 ||
      budget.operationsRemaining < 2 ||
      budget.recordsRemaining === 0
    ) {
      budget.truncated = true;
      return null;
    }
    budget.operationsRemaining -= 1;
    return yield* Effect.scoped(
      fileSystem.open(transcript.filePath, { flag: "r" }).pipe(
        Effect.flatMap((file) =>
          Effect.gen(function* () {
            const decoder = new TextDecoder();
            let remaining = "";
            let bytesRead = 0;
            let recordsRead = 0;
            const maxBytes = Math.min(MAX_TRANSCRIPT_SCAN_BYTES, transcript.size);
            const reserveRecord = () => {
              if (
                recordsRead === MAX_METADATA_RECORDS_PER_TRANSCRIPT ||
                budget.recordsRemaining === 0
              ) {
                budget.truncated = true;
                return false;
              }
              recordsRead += 1;
              budget.recordsRemaining -= 1;
              return true;
            };
            const readLastRecord = () => {
              const record = remaining + decoder.decode();
              return record.length === 0 || !reserveRecord()
                ? null
                : extractCwd(record.trim(), source);
            };

            while (bytesRead < maxBytes) {
              if (budget.bytesRemaining === 0 || budget.operationsRemaining === 0) {
                budget.truncated = true;
                return null;
              }
              const readSize = Math.min(
                METADATA_READ_BYTES,
                maxBytes - bytesRead,
                budget.bytesRemaining,
              );
              budget.operationsRemaining -= 1;
              budget.bytesRemaining -= readSize;
              const next = yield* file.readAlloc(readSize);
              if (Option.isNone(next)) {
                return readLastRecord();
              }

              bytesRead += next.value.byteLength;
              remaining += decoder.decode(next.value, { stream: true });
              const lines = remaining.split("\n");
              remaining = lines.pop() ?? "";

              for (const line of lines) {
                if (!reserveRecord()) return null;
                const cwd = extractCwd(line.trim(), source);
                if (cwd !== null) return cwd;
              }
            }

            if (bytesRead < transcript.size) {
              budget.truncated = true;
              return null;
            }
            return readLastRecord();
          }),
        ),
      ),
    ).pipe(Effect.orElseSucceed(() => null));
  });

  const readCodexRequestTitle = Effect.fn("AgentSessionScanner.readCodexRequestTitle")(function* (
    filePath: string,
    expected: TranscriptIdentity,
  ) {
    const titleFromRecord = (line: string) => {
      const record = decodeTranscriptRecord(line);
      if (Option.isNone(record)) return undefined;
      const { type, payload } = record.value;
      const text =
        type === "event_msg" && payload?.type === "user_message"
          ? payload.message
          : type === "response_item" && payload?.type === "message" && payload.role === "user"
            ? extractText(payload.content)
            : undefined;
      const title = text === undefined ? undefined : deriveTitle("codex", text);
      return title && !isAgentSessionGeneratedContextTitle(title) ? title : undefined;
    };
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(filePath, { flag: "r" });
        const decoder = new TextDecoder();
        let remaining = "";
        let bytesRead = 0;
        let recordsRead = 0;
        while (
          bytesRead < MAX_TITLE_RECOVERY_BYTES &&
          recordsRead < MAX_METADATA_RECORDS_PER_TRANSCRIPT
        ) {
          const next = yield* file.readAlloc(
            Math.min(METADATA_READ_BYTES, MAX_TITLE_RECOVERY_BYTES - bytesRead),
          );
          if (Option.isNone(next)) {
            const title = titleFromRecord(remaining + decoder.decode());
            return title &&
              sameTranscriptIdentity(expected, transcriptIdentity(filePath, yield* file.stat))
              ? title
              : undefined;
          }
          bytesRead += next.value.byteLength;
          remaining += decoder.decode(next.value, { stream: true });
          const lines = remaining.split("\n");
          remaining = lines.pop() ?? "";
          for (const line of lines) {
            if (recordsRead++ === MAX_METADATA_RECORDS_PER_TRANSCRIPT) return undefined;
            const title = titleFromRecord(line);
            if (title)
              return sameTranscriptIdentity(
                expected,
                transcriptIdentity(filePath, yield* file.stat),
              )
                ? title
                : undefined;
          }
        }
        return undefined;
      }),
    ).pipe(Effect.orElseSucceed(() => undefined));
  });

  const readTranscript = Effect.fn("AgentSessionScanner.readTranscript")(function* (
    filePath: string,
    expected: ReturnType<typeof transcriptIdentity>,
    recordLimit: number,
    metadata: AgentSessionTranscriptMetadata,
  ) {
    const source = metadata.source;

    return yield* Effect.scoped(
      fileSystem.open(filePath, { flag: "r" }).pipe(
        Effect.flatMap((file) =>
          Effect.gen(function* () {
            if (!sameTranscriptIdentity(expected, transcriptIdentity(filePath, yield* file.stat))) {
              return null;
            }
            const records: Array<DecodedTranscriptRecord> = [];
            let cwd = Option.none<string>();
            let claudeFields = emptyClaudeFields;
            let historyBytes = 0;
            const projectionFiles: string[] = [];
            let projectedThread: AgentSessionThread | null = null;
            const getProjectedThread = (): AgentSessionThread | null => projectedThread;
            let messageCount = 0;
            let sessionMetadata: DecodedTranscriptRecord | undefined;
            const flushRecords = Effect.fn("AgentSessionScanner.flushProjection")(function* () {
              const parsed = parseAgentSessionRecords(metadata, records, claudeFields);
              if (parsed !== null) {
                const directory = path.join(
                  serverConfig.baseDir,
                  "imported-history",
                  "staging",
                  createDeterministicAttachmentId(
                    "history",
                    `${filePath}:${expected.size}:${expected.mtimeMs}`,
                  )!,
                );
                yield* fileSystem.makeDirectory(directory, { recursive: true });
                const projectionFile = path.join(directory, `${projectionFiles.length}.json`);
                yield* fileSystem.writeFileString(projectionFile, encodeMessages(parsed.messages));
                projectionFiles.push(projectionFile);
                messageCount += parsed.messages.length;
                projectedThread = {
                  ...parsed,
                  title: projectedThread?.title ?? parsed.title,
                  createdAt: projectedThread?.createdAt ?? parsed.createdAt,
                  messages: [],
                  partial: true,
                };
              }
              records.length = 0;
              if (sessionMetadata) records.push(sessionMetadata);
              historyBytes = 0;
            });
            let referenceFile: string | undefined;
            let referenceLines: string[] = [];
            const flushReferences = Effect.fn("AgentSessionScanner.flushReferences")(function* () {
              if (referenceLines.length === 0) return;
              const directory = path.join(
                serverConfig.baseDir,
                "imported-history",
                "staging",
                createDeterministicAttachmentId(
                  "history",
                  `${filePath}:${expected.size}:${expected.mtimeMs}`,
                )!,
              );
              yield* fileSystem.makeDirectory(directory, { recursive: true });
              const destination = path.join(directory, "references.jsonl");
              yield* fileSystem.writeFileString(destination, referenceLines.join("\n") + "\n", {
                flag: referenceFile ? "a" : "w",
              });
              referenceFile = destination;
              referenceLines = [];
            });
            let recordBytes = 0;
            let recordCount = 0;
            let bytesRead = 0;
            const reserve = (bytes: number) => {
              recordBytes += bytes;
              if (recordBytes > MAX_IMPORT_HISTORY_BYTES) {
                throw new TranscriptJsonLimitError(
                  "A single transcript record exceeds the projection memory budget; original history remains available in the archive",
                );
              }
            };
            let reader = createTranscriptJsonReader(reserve, selectTranscriptPath);
            let decoder = new TextDecoder();
            let recordStarted = false;

            const finishRecord = () => {
              reader.write(decoder.decode());
              recordCount += 1;
              if (recordCount > recordLimit) return false;
              const decoded = decodeTranscriptValue(reader.finish());
              if (Option.isSome(decoded)) {
                referenceLines.push(
                  ...normalizedReferences(decoded.value, recordCount).map((reference) =>
                    encodeReference(reference),
                  ),
                );
                if (Option.isNone(cwd)) cwd = Option.fromNullOr(extractDecodedCwd(decoded.value));
                if (decoded.value.type === "session_meta") sessionMetadata = decoded.value;
                if (source === "claudeAgent") {
                  claudeFields = foldClaudeFields(claudeFields, decoded.value);
                }
                if (shouldRetainDecodedRecord(source, decoded.value)) {
                  records.push(decoded.value);
                  historyBytes += recordBytes;
                }
              }
              recordBytes = 0;
              reader = createTranscriptJsonReader(reserve, selectTranscriptPath);
              decoder = new TextDecoder();
              recordStarted = false;
              return true;
            };

            while (bytesRead < expected.size) {
              const next = yield* file.readAlloc(
                Math.min(TRANSCRIPT_PREFIX_BYTES, expected.size - bytesRead),
              );
              if (Option.isNone(next)) {
                return null;
              }

              bytesRead += next.value.byteLength;
              const withinBudget = yield* Effect.try(() => {
                let start = 0;
                while (start < next.value.byteLength) {
                  const newline = next.value.indexOf(10, start);
                  const end = newline === -1 ? next.value.byteLength : newline;
                  recordStarted = true;
                  reader.write(decoder.decode(next.value.subarray(start, end), { stream: true }));
                  if (newline === -1) break;
                  if (!finishRecord()) return false;
                  start = newline + 1;
                }
                return true;
              });
              if (!withinBudget) return null;
              yield* flushReferences();
              if (historyBytes >= 4 * 1024 * 1024) yield* flushRecords();
            }

            if (recordStarted && !(yield* Effect.try(finishRecord))) return null;
            yield* flushReferences();
            if (projectionFiles.length > 0) yield* flushRecords();
            return sameTranscriptIdentity(expected, transcriptIdentity(filePath, yield* file.stat))
              ? {
                  records,
                  recordCount,
                  cwd,
                  claudeFields,
                  projectedThread: getProjectedThread(),
                  projectionFiles,
                  messageCount,
                  referenceFile,
                }
              : null;
          }),
        ),
      ),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read imported transcript", { filePath, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );
  });

  const resolveClaudeConfigDir = (homePath: string, environmentHome?: string): string => {
    const configured = homePath.trim();
    if (configured.length > 0) {
      return path.resolve(expandHomePath(configured, homeDir));
    }
    const fromEnvironment = environmentHome?.trim() ?? "";
    if (fromEnvironment.length > 0) {
      return path.resolve(expandHomePath(fromEnvironment, homeDir));
    }
    return path.join(homeDir, ".claude");
  };

  const discoverNativeTranscripts = Effect.fn("AgentSessionScanner.discoverNativeTranscripts")(
    function* (
      homePath: string,
      providerInstanceId: ProviderInstanceId,
      operationBudget: number,
      directories: ReadonlyArray<string>,
    ) {
      const transcripts: Array<TranscriptCandidate> = [];
      const pending = directories.map((directory) => path.join(homePath, directory));
      let operationsRemaining = operationBudget;
      while (pending.length > 0 && operationsRemaining > 0) {
        const directory = pending.pop()!;
        operationsRemaining -= 1;
        for (const name of (yield* listDirectory(directory)).toSorted()) {
          const filePath = path.join(directory, name);
          if (
            yield* fileSystem.readLink(filePath).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            )
          )
            continue;
          const stats = yield* statOption(filePath);
          if (Option.isNone(stats)) continue;
          if (stats.value.type === "Directory") {
            pending.push(filePath);
          } else if (
            stats.value.type === "File" &&
            name.endsWith(".jsonl") &&
            Option.isSome(stats.value.mtime)
          ) {
            transcripts.push({
              filePath,
              mtimeMs: stats.value.mtime.value.getTime(),
              providerInstanceId,
              size: Number(stats.value.size),
            });
          }
        }
      }
      return { transcripts, truncated: pending.length > 0 };
    },
  );

  const groupTranscriptsByCwd = Effect.fn("AgentSessionScanner.groupTranscriptsByCwd")(function* (
    source: AgentSessionSource,
    transcripts: ReadonlyArray<TranscriptCandidate>,
    budget: MetadataReadBudget,
    catalogs: ReadonlyMap<
      ProviderInstanceId,
      Effect.Success<ReturnType<typeof readCodexAppCatalog>>
    >,
  ) {
    const byOwnerAndCwd = new Map<
      string,
      {
        cwd: string;
        providerInstanceId: ProviderInstanceId;
        lastActiveAtMs: number;
        transcripts: Array<RawCandidate["transcripts"][number]>;
        projects: Map<
          string,
          { title: string | undefined; section: AgentSessionSourceSection | undefined }
        >;
      }
    >();

    for (const transcript of transcripts) {
      const metadata = yield* readCwd(source, transcript, budget);
      if (metadata === null) continue;
      const { cwd } = metadata;
      const native = catalogs
        .get(transcript.providerInstanceId)
        ?.resolve(cwd, transcript.filePath, metadata.sessionId);
      const nativeTitle =
        native?.threadTitle && !isAgentSessionGeneratedContextTitle(native.threadTitle)
          ? native.threadTitle
          : undefined;
      const transcriptTitle =
        source === "codex" && metadata.title && isAgentSessionGeneratedContextTitle(metadata.title)
          ? undefined
          : metadata.title;
      const preview: AgentSessionThreadCandidate = {
        ...threadProvenance(native ?? {}),
        key: threadCandidateKey(source, transcript.providerInstanceId, transcript.filePath),
        title:
          nativeTitle ??
          transcriptTitle ??
          metadata.sessionId ??
          path.basename(transcript.filePath, ".jsonl"),
        source,
        lastActiveAt: DateTime.formatIso(DateTime.makeUnsafe(transcript.mtimeMs)),
        ...(native?.threadSection ? { sourceSection: native.threadSection } : {}),
      };
      const entry = {
        filePath: transcript.filePath,
        mtimeMs: transcript.mtimeMs,
        preview,
        ...(nativeTitle ? { nativeTitle } : {}),
      };
      const key = `${transcript.providerInstanceId}\0${cwd}`;
      const existing = byOwnerAndCwd.get(key);
      if (existing) {
        existing.lastActiveAtMs = Math.max(existing.lastActiveAtMs, transcript.mtimeMs);
        existing.transcripts.push(entry);
        if (native?.projectId)
          existing.projects.set(native.projectId, {
            title: native.projectTitle,
            section: native.projectSection,
          });
      } else {
        byOwnerAndCwd.set(key, {
          cwd,
          providerInstanceId: transcript.providerInstanceId,
          lastActiveAtMs: transcript.mtimeMs,
          transcripts: [entry],
          projects: new Map(
            native?.projectId
              ? [[native.projectId, { title: native.projectTitle, section: native.projectSection }]]
              : [],
          ),
        });
      }
    }

    return Array.from(byOwnerAndCwd.values(), (group): RawCandidate => {
      const project = group.projects.size === 1 ? group.projects.values().next().value : undefined;
      return {
        cwd: group.cwd,
        source,
        providerInstanceId: group.providerInstanceId,
        threadCount: group.transcripts.length,
        lastActiveAtMs: group.lastActiveAtMs,
        transcripts: group.transcripts,
        ...(project?.title ? { title: project.title } : {}),
        ...(project?.section ? { sourceSection: project.section } : {}),
      };
    });
  });

  const collectCandidates = Effect.fn("AgentSessionScanner.collectCandidates")(function* (
    input: AgentSessionScanInput = {},
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-settings", cause })),
    );

    const raw: Array<RawCandidate> = [];
    const catalogReports: AgentSessionSourceReport[] = [];
    let truncated = false;

    for (const source of ["claudeAgent", "codex"] as const) {
      if (input.sources && !input.sources.includes(source)) continue;
      const instances: Array<{
        readonly instanceId: ProviderInstanceId;
        readonly config: ProviderInstanceConfig;
      }> = Object.entries(settings.providerInstances)
        .filter(([, instance]) => instance.driver === source)
        .map(([instanceId, config]) => ({
          instanceId: ProviderInstanceId.make(instanceId),
          config,
        }));
      if (!Object.hasOwn(settings.providerInstances, source)) {
        const defaultInstance = {
          instanceId: ProviderInstanceId.make(source),
          config: { driver: ProviderDriverKind.make(source) },
        };
        instances.push(defaultInstance);
      }

      instances.sort((left, right) => {
        const leftDefault = left.instanceId === source ? 0 : 1;
        const rightDefault = right.instanceId === source ? 0 : 1;
        return leftDefault - rightDefault;
      });
      const homes: Array<{ homePath: string; providerInstanceId: ProviderInstanceId }> = [];
      const seenHomes = new Set<string>();
      for (const { instanceId, config: instance } of instances) {
        const homeVariable = source === "claudeAgent" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
        const environmentHome =
          instance.environment?.findLast((variable) => variable.name === homeVariable)?.value ??
          hostEnvironment[homeVariable];

        let homePath: string;
        if (source === "claudeAgent") {
          const config = decodeClaudeSettings(instance.config ?? {});
          if (Option.isNone(config)) continue;
          homePath = resolveClaudeConfigDir(config.value.homePath, environmentHome);
        } else {
          const config = decodeCodexSettings(instance.config ?? {});
          if (Option.isNone(config)) continue;
          const codexSettings =
            config.value.homePath.trim().length === 0 &&
            config.value.shadowHomePath.trim().length === 0 &&
            environmentHome?.trim()
              ? { ...config.value, homePath: environmentHome }
              : config.value;
          const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
            Effect.provideService(Path.Path, path),
          );
          homePath = layout.sharedHomePath;
        }

        const homeKey = `${source}\0${yield* directoryIdentity(homePath)}`;
        if (seenHomes.has(homeKey)) continue;
        seenHomes.add(homeKey);
        homes.push({ homePath, providerInstanceId: instanceId });
      }

      const transcriptCandidates: Array<TranscriptCandidate> = [];
      const catalogs = new Map<
        ProviderInstanceId,
        Effect.Success<ReturnType<typeof readCodexAppCatalog>>
      >();
      for (const home of homes) {
        if (source === "codex") {
          const catalog = yield* readCodexAppCatalog(home.homePath).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
          catalogs.set(home.providerInstanceId, catalog);
          catalogReports.push(...catalog.reports);
        }
        const operationBudget = Number.MAX_SAFE_INTEGER;
        const discovered = yield* discoverNativeTranscripts(
          home.homePath,
          home.providerInstanceId,
          operationBudget,
          source === "claudeAgent" ? ["projects"] : ["sessions", "archived_sessions"],
        );
        truncated ||= discovered.truncated;
        transcriptCandidates.push(...discovered.transcripts);
      }
      if (source === "codex") {
        cachedCodexCatalogs = catalogs;
        cachedCodexCatalogKey = encodeScanInput({
          sources: input.sources,
          exportPaths: input.exportPaths,
        });
      }

      transcriptCandidates.sort(
        (left, right) =>
          right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath),
      );
      const selectedTranscripts = selectMetadataTranscripts(transcriptCandidates);
      const metadataBudget: MetadataReadBudget = {
        bytesRemaining: Number.POSITIVE_INFINITY,
        operationsRemaining: Number.POSITIVE_INFINITY,
        recordsRemaining: Number.POSITIVE_INFINITY,
        truncated: false,
      };
      raw.push(
        ...(yield* groupTranscriptsByCwd(source, selectedTranscripts, metadataBudget, catalogs)),
      );
      truncated ||= metadataBudget.truncated;
    }

    const openCodeRoots: Array<{ path: string; providerInstanceId: ProviderInstanceId }> = [];
    // Explicit source selection opts into additional local stores. Legacy callers keep their original scope.
    if (input.sources?.includes("opencode")) {
      const instances = Object.entries(settings.providerInstances).filter(
        ([, config]) => config.driver === "opencode",
      );
      if (!instances.some(([id]) => id === "opencode"))
        instances.push(["opencode", { driver: ProviderDriverKind.make("opencode") }]);
      for (const [id, config] of instances) {
        const environment = {
          ...hostEnvironment,
          ...Object.fromEntries(config.environment?.map(({ name, value }) => [name, value]) ?? []),
        };
        const dataHome = environment.XDG_DATA_HOME?.trim();
        const roots = environment.OPENCODE_DATA_DIR?.split(",")
          .map((root) => root.trim())
          .filter(Boolean);
        for (const root of roots?.length
          ? roots
          : [
              path.join(
                dataHome && path.isAbsolute(dataHome)
                  ? dataHome
                  : path.join(homeDir, ".local", "share"),
                "opencode",
              ),
            ]) {
          openCodeRoots.push({
            path: path.resolve(expandHomePath(root, homeDir)),
            providerInstanceId: ProviderInstanceId.make(id),
          });
        }
      }
    }
    const external = yield* discoverExternalSessions(
      { ...input, sources: input.sources ?? ["codex", "claudeAgent"] },
      openCodeRoots,
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    for (const candidate of external.candidates) {
      raw.push({
        cwd: candidate.cwd,
        source: candidate.source,
        providerInstanceId: candidate.providerInstanceId,
        threadCount: 1,
        lastActiveAtMs: candidate.mtimeMs,
        transcripts: [
          {
            filePath: candidate.filePath,
            mtimeMs: candidate.mtimeMs,
            external: candidate,
            preview: {
              key: threadCandidateKey(
                candidate.source,
                candidate.providerInstanceId,
                candidate.filePath,
                candidate.sessionId,
              ),
              title: candidate.sessionId,
              source: candidate.source,
              lastActiveAt: DateTime.formatIso(DateTime.makeUnsafe(candidate.mtimeMs)),
            },
          },
        ],
      });
    }
    const t3Code = input.sources?.includes("t3code")
      ? yield* discoverT3CodeSessions(input, homeDir).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        )
      : { candidates: [], reports: [] };
    for (const candidate of t3Code.candidates)
      raw.push({
        cwd: candidate.cwd,
        source: "t3code",
        providerInstanceId: candidate.providerInstanceId,
        threadCount: 1,
        lastActiveAtMs: candidate.mtimeMs,
        title: candidate.projectTitle ?? path.basename(candidate.cwd),
        transcripts: [
          {
            filePath: candidate.filePath,
            mtimeMs: candidate.mtimeMs,
            t3Code: candidate,
            preview: {
              key: threadCandidateKey(
                "t3code",
                candidate.providerInstanceId,
                candidate.filePath,
                candidate.sessionId,
              ),
              title: candidate.title,
              source: "t3code",
              lastActiveAt: DateTime.formatIso(DateTime.makeUnsafe(candidate.mtimeMs)),
            },
          },
        ],
      });
    const sourceReports: AgentSessionSourceReport[] = [
      ...external.reports,
      ...catalogReports,
      ...t3Code.reports,
    ];
    for (const source of ["codex", "claudeAgent"] as const) {
      if (input.sources && !input.sources.includes(source)) continue;
      sourceReports.push({
        source,
        status: raw.some((candidate) => candidate.source === source) ? "available" : "unavailable",
        message:
          "All retained history in configured profiles and archives is scanned regardless of age. Original tool records and attachment references are preserved in downloadable source archives.",
      });
    }
    return { candidates: raw, truncated, sourceReports };
  });

  let cachedCandidates: { key: string; candidates: ReadonlyArray<RawCandidate> } | null = null;

  const scan = Effect.fn("AgentSessionScanner.scan")(function* (input: AgentSessionScanInput = {}) {
    const { candidates: raw, truncated, sourceReports } = yield* collectCandidates(input);
    cachedCandidates = {
      key: encodeScanInput({ sources: input.sources, exportPaths: input.exportPaths }),
      candidates: raw,
    };

    const merged = new Map<
      string,
      {
        path: string;
        sources: Array<AgentSessionSource>;
        threadCount: number;
        lastActiveAtMs: number | null;
        git: AgentSessionProjectGit | null;
        sourceWorkspaceRoot?: string;
        title?: string;
        sourceSection?: AgentSessionSourceSection;
        threads: AgentSessionThreadCandidate[];
      }
    >();
    const directoryKeys = new Map<string, string>();
    const gitIdentities = new Map<string, AgentSessionProjectGit | null>();
    const missingRoots = new Map<string, string>();

    for (const candidate of raw) {
      const expanded = expandHomePath(candidate.cwd.trim(), homeDir);
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      let key = directoryKeys.get(resolved);
      if (key === undefined) {
        const stats = yield* statOption(resolved);
        if (Option.isNone(stats) || stats.value.type !== "Directory") {
          key = normalizeProjectPathForComparison(resolved);
          directoryKeys.set(resolved, key);
          missingRoots.set(key, resolved);
          sourceReports.push({
            source: candidate.source,
            status: "partial",
            message: `Workspace ${resolved} is unavailable. Its history can be imported into a separate history project; the original directory is not recreated.`,
          });
        } else {
          const gitIdentity = yield* readGitIdentity(resolved);
          key = yield* directoryIdentity(resolved, stats.value);
          gitIdentities.set(key, gitIdentity._tag === "Repository" ? gitIdentity.git : null);
          directoryKeys.set(resolved, key);
        }
      }
      if (key === "") continue;

      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          path: missingRoots.has(key)
            ? path.join(
                serverConfig.baseDir,
                "imported-history",
                "projects",
                createDeterministicAttachmentId("history", resolved)!,
              )
            : resolved,
          ...(missingRoots.has(key) ? { sourceWorkspaceRoot: resolved } : {}),
          sources: [candidate.source],
          threadCount: candidate.threadCount,
          lastActiveAtMs: candidate.lastActiveAtMs,
          git: gitIdentities.get(key) ?? null,
          ...(candidate.title ? { title: candidate.title } : {}),
          ...(candidate.sourceSection ? { sourceSection: candidate.sourceSection } : {}),
          threads: candidate.transcripts.map((transcript) => transcript.preview),
        });
        continue;
      }
      if (!existing.sources.includes(candidate.source)) {
        existing.sources.push(candidate.source);
      }
      existing.threadCount += candidate.threadCount;
      existing.threads.push(...candidate.transcripts.map((transcript) => transcript.preview));
      if (!existing.title && candidate.title) existing.title = candidate.title;
      if (!existing.sourceSection && candidate.sourceSection)
        existing.sourceSection = candidate.sourceSection;
      existing.lastActiveAtMs =
        existing.lastActiveAtMs === null || candidate.lastActiveAtMs === null
          ? (existing.lastActiveAtMs ?? candidate.lastActiveAtMs)
          : Math.max(existing.lastActiveAtMs, candidate.lastActiveAtMs);
    }

    // Resolve persisted roots too; transcripts may use different symlinks to the same directory.
    const importedProjects = yield* projectStore
      .listShells()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const importedProjectsByRoot = new Map<string, (typeof importedProjects)[number]>();
    for (const project of importedProjects) {
      const projectRoot = path.resolve(expandHomePath(project.workspaceRoot, homeDir));
      importedProjectsByRoot.set(normalizeProjectPathForComparison(projectRoot), project);
      importedProjectsByRoot.set(yield* directoryIdentity(projectRoot), project);
    }

    const candidates: Array<AgentSessionProjectCandidate> = [];
    for (const [key, entry] of merged.entries()) {
      const importedProject =
        importedProjectsByRoot.get(normalizeProjectPathForComparison(entry.path)) ??
        importedProjectsByRoot.get(key);
      const candidatePath = importedProject?.workspaceRoot ?? entry.path;
      const sourceProject = entry.threads[0]?.sourceProject;
      const sharedSourceProject =
        sourceProject !== undefined &&
        entry.threads.every((thread) =>
          sourceProject === null
            ? thread.sourceProject === null
            : thread.sourceProject?.id === sourceProject.id,
        );
      candidates.push({
        ...(sharedSourceProject ? { sourceProject } : {}),
        path: candidatePath,
        title:
          entry.title ??
          (path.basename(entry.sourceWorkspaceRoot ?? candidatePath) || candidatePath),
        ...(entry.sourceSection ? { sourceSection: entry.sourceSection } : {}),
        threads: entry.threads.toSorted(
          (left, right) =>
            (right.lastActiveAt ?? "").localeCompare(left.lastActiveAt ?? "") ||
            left.key.localeCompare(right.key),
        ),
        ...(entry.sourceWorkspaceRoot === undefined
          ? {}
          : { workspaceAvailable: false, sourceWorkspaceRoot: entry.sourceWorkspaceRoot }),
        ...(importedProject === undefined ? {} : { projectId: importedProject.id }),
        sources: entry.sources,
        threadCount: entry.threadCount,
        lastActiveAt:
          entry.lastActiveAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(entry.lastActiveAtMs)),
        alreadyImported: importedProject !== undefined,
        git: entry.git,
      });
    }

    candidates.sort((left, right) => {
      if (left.lastActiveAt === right.lastActiveAt) return left.path.localeCompare(right.path);
      if (left.lastActiveAt === null) return 1;
      if (right.lastActiveAt === null) return -1;
      return right.lastActiveAt.localeCompare(left.lastActiveAt);
    });

    return {
      candidates,
      scannedAt: DateTime.formatIso(yield* DateTime.now),
      sourceReports,
      ...(truncated ? { truncated: true } : {}),
    };
  });

  const prepareRecentThreads = Effect.fn("AgentSessionScanner.prepareRecentThreads")(function* (
    workspaceRoot: string,
    completedSources: ReadonlyArray<AgentSessionImportSource>,
    input: AgentSessionScanInput,
    titleRepairThreadIds: ReadonlyArray<ThreadId>,
  ) {
    const root = path.resolve(expandHomePath(input.sourceWorkspaceRoot ?? workspaceRoot, homeDir));
    const rootIdentity = yield* directoryIdentity(root);
    const key = encodeScanInput({ sources: input.sources, exportPaths: input.exportPaths });
    const candidates =
      cachedCandidates?.key === key
        ? cachedCandidates.candidates
        : (yield* collectCandidates(input)).candidates;
    cachedCandidates = { key, candidates };

    const eligibleTranscripts: Array<{
      readonly candidate: RawCandidate;
      readonly transcript: RawCandidate["transcripts"][number] & { readonly mtimeMs: number };
    }> = [];
    const selectedKeys = input.threadKeys === undefined ? undefined : new Set(input.threadKeys);
    const titleRepairs = new Set(titleRepairThreadIds);
    for (const candidate of candidates) {
      if (input.sources && !input.sources.includes(candidate.source)) continue;
      const expanded = expandHomePath(candidate.cwd.trim(), homeDir);
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      if ((yield* directoryIdentity(resolved)) !== rootIdentity) continue;

      for (const transcript of candidate.transcripts) {
        if (selectedKeys !== undefined && !selectedKeys.has(transcript.preview.key)) continue;
        if (transcript.mtimeMs === null) {
          continue;
        }
        eligibleTranscripts.push({
          candidate,
          transcript: { ...transcript, mtimeMs: transcript.mtimeMs },
        });
      }
    }

    eligibleTranscripts.sort((left, right) => {
      if (left.transcript.mtimeMs !== right.transcript.mtimeMs) {
        return right.transcript.mtimeMs - left.transcript.mtimeMs;
      }
      return left.transcript.filePath.localeCompare(right.transcript.filePath);
    });

    const completedByFile = Map.groupBy(
      completedSources,
      (source) => `${source.providerInstanceId}\0${source.filePath}`,
    );
    const importedSessions = new Set<string>();
    let bytesRemaining = MAX_IMPORT_BYTES;
    let transcriptsRemaining = MAX_IMPORT_TRANSCRIPTS;
    let recordsRemaining = MAX_IMPORT_RECORDS;
    return Stream.fromIterable(
      eligibleTranscripts.map((entry, index) => ({ ...entry, index })).slice(input.cursor ?? 0),
    ).pipe(
      Stream.mapEffect(({ candidate, transcript, index }) =>
        Effect.gen(function* () {
          const completed = completedByFile.get(
            `${candidate.providerInstanceId}\0${transcript.filePath}`,
          );
          if (
            completed === undefined &&
            (transcriptsRemaining === 0 || bytesRemaining === 0 || recordsRemaining === 0)
          ) {
            return Option.some<AgentSessionRecentThread>({
              _tag: "Skipped",
              reason: "deferred",
              cursor: index,
            });
          }
          const stats = yield* statOption(transcript.filePath);
          if (Option.isNone(stats) || stats.value.type !== "File") {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped", reason: "failed" });
          }
          const fileIdentity = transcriptIdentity(transcript.filePath, stats.value);
          const identity =
            transcript.t3Code || transcript.external?.format === "opencode-sqlite"
              ? {
                  ...fileIdentity,
                  mtimeMs: transcript.t3Code?.mtimeMs ?? transcript.external!.mtimeMs,
                }
              : fileIdentity;
          const completedSource = completed?.find(
            (source) =>
              source.provider === candidate.source &&
              (transcript.external === undefined ||
                source.providerSessionId === transcript.external.sessionId) &&
              (transcript.t3Code === undefined ||
                source.providerSessionId === transcript.t3Code.sessionId) &&
              sameTranscriptIdentity(source, identity),
          );
          if (completedSource !== undefined) {
            const sessionKey = `${completedSource.providerInstanceId}\0${completedSource.providerSessionId}`;
            if (importedSessions.has(sessionKey)) return Option.none<AgentSessionRecentThread>();
            importedSessions.add(sessionKey);
            const recoveredTitle =
              candidate.source === "codex" &&
              !transcript.nativeTitle &&
              titleRepairs.has(
                ThreadId.make(
                  `import:${completedSource.providerInstanceId}:${completedSource.providerSessionId}`,
                ),
              )
                ? yield* readCodexRequestTitle(transcript.filePath, identity)
                : transcript.nativeTitle;
            return Option.some<AgentSessionRecentThread>({
              ...threadProvenance(transcript.preview),
              _tag: "AlreadyImported",
              source: completedSource,
              title: recoveredTitle ?? transcript.preview.title,
              ...(recoveredTitle ? { nativeTitle: recoveredTitle } : {}),
              ...(transcript.preview.sourceSection
                ? { sourceSection: transcript.preview.sourceSection }
                : {}),
            });
          }
          if (
            transcriptsRemaining === 0 ||
            recordsRemaining === 0 ||
            (identity.size > bytesRemaining && transcriptsRemaining < MAX_IMPORT_TRANSCRIPTS)
          ) {
            return Option.some<AgentSessionRecentThread>({
              _tag: "Skipped",
              reason: "deferred",
              cursor: index,
            });
          }
          transcriptsRemaining -= 1;
          bytesRemaining = Math.max(0, bytesRemaining - identity.size);
          if (transcript.t3Code) {
            const loaded = yield* loadT3CodeSession(transcript.t3Code).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.provideService(ServerConfig.ServerConfig, serverConfig),
              Effect.orElseSucceed(() => null),
            );
            if (!loaded)
              return Option.some<AgentSessionRecentThread>({
                _tag: "Skipped",
                reason: "unavailable",
              });
            const source: AgentSessionImportSource = {
              ...identity,
              provider: "t3code",
              providerInstanceId: candidate.providerInstanceId,
              providerSessionId: transcript.t3Code.sessionId,
            };
            const sessionKey = `${source.providerInstanceId}\0${source.providerSessionId}`;
            if (importedSessions.has(sessionKey))
              return Option.some<AgentSessionRecentThread>({ _tag: "Duplicate", source });
            importedSessions.add(sessionKey);
            const archiveAttachments = yield* archiveSession(
              source,
              ThreadId.make(`import:${source.providerInstanceId}:${source.providerSessionId}`),
              fileSystem.stream(loaded.archiveFilePath),
            ).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.provideService(ServerConfig.ServerConfig, serverConfig),
              Effect.orElseSucceed(() => []),
            );
            return Option.some<AgentSessionRecentThread>({
              _tag: "Importable",
              source,
              thread: {
                ...loaded.thread,
                archiveAttachments,
                nativeContinuation: false,
                partial: loaded.thread.partial || archiveAttachments.length === 0,
              },
            });
          }
          if (transcript.external !== undefined) {
            const parsedThread = yield* loadExternalSession(transcript.external).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.orElseSucceed(() => null),
            );
            if (parsedThread === null)
              return Option.some<AgentSessionRecentThread>({
                _tag: "Skipped",
                reason: "unavailable",
              });
            const source = {
              ...identity,
              provider: parsedThread.source,
              providerInstanceId: parsedThread.providerInstanceId,
              providerSessionId: parsedThread.providerSessionId,
            };
            const sessionKey = `${parsedThread.providerInstanceId}\0${parsedThread.providerSessionId}`;
            if (importedSessions.has(sessionKey))
              return Option.some<AgentSessionRecentThread>({ _tag: "Duplicate", source });
            importedSessions.add(sessionKey);
            const archiveAttachments = yield* archiveSession(
              source,
              ThreadId.make(`import:${source.providerInstanceId}:${source.providerSessionId}`),
              transcript.external.format === "opencode-sqlite"
                ? externalSessionArchive(transcript.external)
                : undefined,
            ).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.provideService(ServerConfig.ServerConfig, serverConfig),
              Effect.orElseSucceed(() => []),
            );
            return Option.some<AgentSessionRecentThread>({
              _tag: "Importable",
              thread: {
                ...parsedThread,
                ...(input.sourceWorkspaceRoot ? { nativeContinuation: false } : {}),
                archiveAttachments,
                partial: parsedThread.partial || archiveAttachments.length === 0,
              },
              source,
            });
          }
          const snapshot = yield* readTranscript(transcript.filePath, identity, recordsRemaining, {
            source: candidate.source,
            providerInstanceId: candidate.providerInstanceId,
            fallbackSessionId: path.basename(transcript.filePath, ".jsonl"),
            lastActiveAtMs: transcript.mtimeMs,
          });
          if (snapshot === null) {
            const current = yield* statOption(transcript.filePath);
            if (
              Option.isNone(current) ||
              !sameTranscriptIdentity(
                identity,
                transcriptIdentity(transcript.filePath, current.value),
              )
            )
              return Option.some<AgentSessionRecentThread>({ _tag: "Skipped", reason: "failed" });
            const prefix = yield* Effect.scoped(
              fileSystem.open(transcript.filePath, { flag: "r" }).pipe(
                Effect.flatMap((file) => file.readAlloc(TRANSCRIPT_PREFIX_BYTES)),
                Effect.map((bytes) =>
                  Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : "",
                ),
              ),
            ).pipe(Effect.orElseSucceed(() => ""));
            const metadata = prefix
              .split("\n")
              .flatMap((line) => Option.toArray(decodeTranscriptRecord(line)));
            const nativeId =
              metadata.find((record) => record.type === "session_meta")?.payload?.id ??
              metadata.find((record) => record.sessionId)?.sessionId;
            const providerSessionId = nativeId ?? `archive:${path.basename(transcript.filePath)}`;
            const source = {
              ...identity,
              provider: candidate.source,
              providerInstanceId: candidate.providerInstanceId,
              providerSessionId,
            };
            const archiveAttachments = yield* archiveSession(
              source,
              ThreadId.make(`import:${source.providerInstanceId}:${source.providerSessionId}`),
            ).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.provideService(ServerConfig.ServerConfig, serverConfig),
              Effect.orElseSucceed(() => []),
            );
            if (archiveAttachments.length === 0)
              return Option.some<AgentSessionRecentThread>({ _tag: "Skipped", reason: "failed" });
            const timestamp = DateTime.formatIso(DateTime.makeUnsafe(transcript.mtimeMs));
            return Option.some<AgentSessionRecentThread>({
              _tag: "Importable",
              source,
              thread: {
                ...threadProvenance(transcript.preview),
                source: candidate.source,
                providerInstanceId: candidate.providerInstanceId,
                providerSessionId,
                title: transcript.preview.title,
                ...(transcript.preview.sourceSection
                  ? { sourceSection: transcript.preview.sourceSection }
                  : {}),
                model: null,
                createdAt: timestamp,
                updatedAt: timestamp,
                messages: [],
                archiveAttachments,
                partial: true,
                nativeContinuation:
                  transcript.preview.kind !== "subagent" &&
                  nativeId !== undefined &&
                  input.sourceWorkspaceRoot === undefined,
              },
            });
          }
          recordsRemaining -= snapshot.recordCount;

          if (Option.isNone(snapshot.cwd)) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped", reason: "failed" });
          }
          const expandedCwd = expandHomePath(snapshot.cwd.value.trim(), homeDir);
          if (
            !path.isAbsolute(expandedCwd) ||
            (yield* directoryIdentity(path.resolve(expandedCwd))) !== rootIdentity
          ) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped", reason: "failed" });
          }

          const parsedThread: AgentSessionThread | null =
            snapshot.projectedThread === null
              ? parseAgentSessionRecords(
                  {
                    source: candidate.source,
                    providerInstanceId: candidate.providerInstanceId,
                    fallbackSessionId: path.basename(transcript.filePath, ".jsonl"),
                    lastActiveAtMs: transcript.mtimeMs,
                  },
                  snapshot.records,
                  snapshot.claudeFields,
                )
              : {
                  ...snapshot.projectedThread,
                  projectionFiles: snapshot.projectionFiles,
                  messageCount: snapshot.messageCount,
                };
          if (parsedThread === null) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped", reason: "failed" });
          }

          const source: AgentSessionImportSource = {
            ...identity,
            provider: parsedThread.source,
            providerInstanceId: parsedThread.providerInstanceId,
            providerSessionId: parsedThread.providerSessionId,
          };
          const sessionKey = `${parsedThread.providerInstanceId}\0${parsedThread.providerSessionId}`;
          if (importedSessions.has(sessionKey)) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Duplicate", source });
          }
          importedSessions.add(sessionKey);
          const archiveAttachments = yield* archiveSession(
            source,
            ThreadId.make(`import:${source.providerInstanceId}:${source.providerSessionId}`),
            undefined,
            snapshot.referenceFile,
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(ServerConfig.ServerConfig, serverConfig),
            Effect.orElseSucceed(() => []),
          );
          const archivedStats = yield* statOption(transcript.filePath);
          if (
            Option.isNone(archivedStats) ||
            !sameTranscriptIdentity(
              identity,
              transcriptIdentity(transcript.filePath, archivedStats.value),
            )
          )
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped", reason: "failed" });
          if (snapshot.referenceFile && archiveAttachments.length > 0)
            yield* fileSystem.remove(snapshot.referenceFile).pipe(Effect.ignore);
          return Option.some<AgentSessionRecentThread>({
            _tag: "Importable",
            thread: {
              ...parsedThread,
              ...threadProvenance(transcript.preview),
              ...(transcript.preview.sourceSection
                ? { sourceSection: transcript.preview.sourceSection }
                : {}),
              ...(transcript.nativeTitle ? { title: transcript.nativeTitle } : {}),
              ...(input.sourceWorkspaceRoot ? { nativeContinuation: false } : {}),
              ...(transcript.preview.kind === "subagent" ? { nativeContinuation: false } : {}),
              archiveAttachments,
              partial:
                parsedThread.partial ||
                snapshot.referenceFile !== undefined ||
                archiveAttachments.length === 0,
            },
            source,
          });
        }).pipe(importReadLock.withPermits(1)),
      ),
      Stream.map(Option.toArray),
      Stream.flattenIterable,
    );
  });

  const recentThreads: AgentSessionScanner["Service"]["recentThreads"] = (
    workspaceRoot,
    completedSources = [],
    input = {},
    titleRepairThreadIds = [],
  ) =>
    Stream.unwrap(
      prepareRecentThreads(workspaceRoot, completedSources, input, titleRepairThreadIds),
    );

  const projectSourceSection = Effect.fn("AgentSessionScanner.projectSourceSection")(function* (
    workspaceRoot: string,
    input: AgentSessionScanInput = {},
  ) {
    const root = path.resolve(expandHomePath(input.sourceWorkspaceRoot ?? workspaceRoot, homeDir));
    const rootIdentity = yield* directoryIdentity(root);
    const sections = new Map<string, AgentSessionSourceSection>();
    const key = encodeScanInput({ sources: input.sources, exportPaths: input.exportPaths });
    for (const candidate of cachedCandidates?.key === key ? cachedCandidates.candidates : []) {
      if (!candidate.sourceSection || (input.sources && !input.sources.includes(candidate.source)))
        continue;
      const expanded = expandHomePath(candidate.cwd.trim(), homeDir);
      if (!path.isAbsolute(expanded) || (yield* directoryIdentity(expanded)) !== rootIdentity)
        continue;
      sections.set(candidate.sourceSection.id, candidate.sourceSection);
    }
    if (sections.size > 0) return sections.size === 1 ? sections.values().next().value : undefined;
    if (input.sources && !input.sources.includes("codex")) return undefined;
    if (cachedCodexCatalogKey !== key) return undefined;
    for (const catalog of cachedCodexCatalogs.values()) {
      const section = catalog.resolve(root, "").projectSection;
      if (section) sections.set(section.id, section);
    }
    return sections.size === 1 ? sections.values().next().value : undefined;
  });

  const streamMessages: AgentSessionScanner["Service"]["streamMessages"] = (thread) =>
    thread.projectionFiles
      ? Stream.fromIterable(thread.projectionFiles).pipe(
          Stream.mapEffect((file) =>
            fileSystem.readFileString(file).pipe(
              Effect.flatMap(decodeMessages),
              Effect.mapError(
                (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
              ),
            ),
          ),
          Stream.flattenIterable,
        )
      : Stream.fromIterable(thread.messages);
  return AgentSessionScanner.of({ scan, recentThreads, projectSourceSection, streamMessages });
});

export const layer = Layer.effect(AgentSessionScanner, make);
