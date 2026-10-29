import { GroupMessage, type GroupMessageChunk, type GroupSnapshot } from "@t3tools/contracts";
import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import * as Schema from "effect/Schema";

const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 192 * 1024;
const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(GroupMessage));

export const groupMessageSourceKey = (message: GroupMessage) =>
  JSON.stringify([
    message.id,
    message.text,
    message.truncated,
    message.contextDeferred,
    message.streaming,
    message.attachments?.map((attachment) => attachment.id),
  ]);

export function pruneGroupHistoryProjections(
  live: GroupSnapshot,
  pages: ReadonlyArray<GroupSnapshot>,
) {
  return pages.map((page) => ({
    ...page,
    ...(page.runProjections
      ? {
          runProjections: page.runProjections.filter((projection) => {
            const member = live.members.find((member) => member.id === projection.memberId);
            const round = page.rounds.find((round) =>
              round.deliveries.some(
                (delivery) =>
                  delivery.id === projection.deliveryId && delivery.runId === projection.runId,
              ),
            );
            const original = round?.members.find((member) => member.id === projection.memberId);
            return (
              member &&
              original &&
              member.threadId === projection.threadId &&
              member.threadId === original.threadId &&
              member.environmentId === original.environmentId &&
              (member.environmentId === null || member.environmentId === projection.environmentId)
            );
          }),
        }
      : {}),
  }));
}

export function mergeGroupHistory(
  live: GroupSnapshot,
  pages: ReadonlyArray<GroupSnapshot>,
): GroupSnapshot {
  const messages = new Map<string, GroupMessage>();
  const rounds = new Map<string, GroupSnapshot["rounds"][number]>();
  const projections = new Map<string, NonNullable<GroupSnapshot["runProjections"]>[number]>();
  for (const page of [...pruneGroupHistoryProjections(live, pages), live]) {
    for (const message of page.messages) messages.set(message.id, message);
    for (const round of page.rounds) rounds.set(round.id, round);
    for (const projection of page.runProjections ?? [])
      projections.set(projection.deliveryId, projection);
  }
  return {
    ...live,
    messages: [...messages.values()].toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
    rounds: [...rounds.values()],
    ...(projections.size ? { runProjections: [...projections.values()] } : {}),
  };
}

export async function readCompleteGroupMessage(
  visible: GroupMessage,
  read: (offset: number) => Promise<GroupMessageChunk>,
  isCurrent: () => boolean = () => true,
  localized = false,
): Promise<GroupMessage> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let total: number | undefined;
  while (isCurrent()) {
    const chunk = await read(offset);
    if (!isCurrent()) throw new Error("The conversation changed while loading its message.");
    if (
      chunk.data.length > 262_144 ||
      !Number.isSafeInteger(chunk.totalBytes) ||
      chunk.totalBytes < 0
    )
      throw new Error("The group message returned an invalid range.");
    const raw = atob(chunk.data);
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    if (
      btoa(raw) !== chunk.data ||
      chunk.offset !== offset ||
      bytes.length > CHUNK_BYTES ||
      chunk.totalBytes > MAX_MESSAGE_BYTES ||
      chunk.totalBytes < offset + bytes.length ||
      (total !== undefined && total !== chunk.totalBytes) ||
      (!chunk.complete && bytes.length !== CHUNK_BYTES) ||
      chunk.complete !== (offset + bytes.length === chunk.totalBytes)
    )
      throw new Error("The group message changed or returned an invalid range. Retry loading it.");
    total = chunk.totalBytes;
    parts.push(bytes);
    offset += bytes.length;
    if (!chunk.complete) continue;
    const assembled = new Uint8Array(offset);
    let position = 0;
    for (const part of parts) {
      assembled.set(part, position);
      position += part.length;
    }
    const message = decodeMessage(new TextDecoder("utf-8", { fatal: true }).decode(assembled));
    if (message.id !== visible.id || message.groupId !== visible.groupId)
      throw new Error("The loaded message belongs to another conversation.");
    if (!localized || !message.attachments?.length) return message;
    if (message.attachments.length !== visible.attachments?.length)
      throw new Error("The shared message attachments changed. Reconnect before loading it.");
    const attachments = message.attachments.map((attachment, index) => ({
      ...attachment,
      ...visible.attachments![index]!,
    }));
    const context = remapComposerContextAttachments(
      message.context,
      message.attachments,
      attachments,
    );
    return { ...message, attachments, ...(context ? { context } : {}) };
  }
  throw new Error("The conversation changed while loading its message.");
}
