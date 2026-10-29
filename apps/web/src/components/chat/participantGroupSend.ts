import type {
  EnvironmentId,
  GroupCreateInput,
  GroupSendInput,
  GroupSnapshot,
} from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";
import * as Schema from "effect/Schema";
import type { ComposerThreadDraftState } from "../../composerDraftStore";
import { participantGroupMembers, type ParticipantCandidate } from "./draftParticipants";

export type ParticipantGroupPayload = Pick<
  GroupSendInput,
  "message" | "attachments" | "context" | "interactionMode"
>;

export function assertParticipantRichMessages(
  payload: ParticipantGroupPayload,
  supported: boolean,
) {
  if (
    !supported &&
    (payload.attachments?.length || payload.context || payload.interactionMode !== undefined)
  )
    throw new Error(
      "Update the group host before sending attachments, structured context, or a turn mode.",
    );
}

export const ParticipantSendReceipt = Schema.Struct({
  key: Schema.String,
  requestId: Schema.String,
  title: Schema.String,
  sendRequestId: Schema.String,
  payloadDigest: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
type ParticipantSendReceipt = typeof ParticipantSendReceipt.Type;

const fingerprint = (value: unknown) =>
  Array.from(sha256(new TextEncoder().encode(JSON.stringify(value))), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

export function nextParticipantSendReceipt(
  previous: ParticipantSendReceipt | null,
  input: {
    readonly key: string;
    readonly title: string;
    readonly payload: ParticipantGroupPayload;
  },
  makeId: () => string,
): ParticipantSendReceipt {
  const payloadDigest = fingerprint(input.payload);
  const retained = previous?.key === input.key ? previous : null;
  const samePayload =
    retained?.payloadDigest === payloadDigest ||
    (retained?.payloadDigest === undefined &&
      retained?.message === input.payload.message &&
      !input.payload.attachments?.length &&
      !input.payload.context &&
      !input.payload.interactionMode);
  return {
    key: input.key,
    title: retained?.title ?? input.title,
    requestId: retained?.requestId ?? makeId(),
    sendRequestId: retained && samePayload ? retained.sendRequestId : makeId(),
    payloadDigest,
  };
}

export function participantDraftIdentity(draft: ComposerThreadDraftState | null | undefined) {
  if (!draft) return "";
  return fingerprint({
    ...draft,
    images: draft.images.map(({ id, name, mimeType, sizeBytes, source }) => ({
      id,
      name,
      mimeType,
      sizeBytes,
      source,
    })),
    files: draft.files.map(({ id, name, mimeType, sizeBytes, source }) => ({
      id,
      name,
      mimeType,
      sizeBytes,
      source,
    })),
    persistedAttachments: draft.persistedAttachments.map(
      ({ id, name, mimeType, sizeBytes, source }) => ({ id, name, mimeType, sizeBytes, source }),
    ),
  });
}

export async function submitParticipantGroup(
  input: {
    readonly environmentId: EnvironmentId;
    readonly members: ReadonlyArray<ParticipantCandidate>;
    readonly title: string;
    readonly requestId: string;
    readonly sendRequestId?: string;
  } & ParticipantGroupPayload,
  commands: {
    readonly create: (input: GroupCreateInput) => Promise<GroupSnapshot>;
    readonly send: (input: GroupSendInput) => Promise<unknown>;
  },
) {
  if (!input.message.trim() && !input.attachments?.length && !input.context?.records.length)
    throw new Error("Add a message, attachment, or context for your participants first.");
  if (input.message.length > 120_000)
    throw new Error("This group message exceeds 120,000 characters.");
  if ((input.attachments?.length ?? 0) > 20)
    throw new Error("Groups support up to 20 attachments per message.");
  const members = participantGroupMembers(input.members);
  const lead = members[0];
  const snapshot = await commands.create({
    name: input.title.slice(0, 120),
    workflow: "team",
    members,
    ...(lead ? { leadThreadId: lead.threadId, leadEnvironmentId: lead.environmentId } : {}),
    clientRequestId: input.requestId,
  });
  await commands.send({
    groupId: snapshot.group.id,
    message: input.message,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    mentionEveryone: true,
    clientRequestId: input.sendRequestId ?? input.requestId,
  });
  return snapshot;
}
