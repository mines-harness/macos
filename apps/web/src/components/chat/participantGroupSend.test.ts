import { describe, expect, it, vi } from "vite-plus/test";
import {
  ComposerContextId,
  EnvironmentId,
  GroupId,
  ThreadId,
  type GroupSnapshot,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import {
  assertParticipantRichMessages,
  nextParticipantSendReceipt,
  participantDraftIdentity,
  submitParticipantGroup,
} from "./participantGroupSend";
import type { ComposerThreadDraftState } from "../../composerDraftStore";

const environmentId = EnvironmentId.make("mac");
const snapshot: GroupSnapshot = {
  group: {
    id: GroupId.make("team"),
    name: "Build it",
    workflow: "team",
    leadMemberId: "lead",
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
    archivedAt: null,
  },
  members: [],
  messages: [],
  rounds: [],
  hasMoreMessages: false,
};
const input = {
  environmentId,
  members: [{ environmentId, threadId: ThreadId.make("design"), title: "Design" }],
  title: "Build it",
  message: "Build it with the selected mines",
  requestId: "retained-request",
};

describe("participant group submission", () => {
  it("keeps plain text compatible and refuses rich payloads until the coordinator advertises support", () => {
    expect(() => assertParticipantRichMessages({ message: "Plain" }, false)).not.toThrow();
    expect(() =>
      assertParticipantRichMessages(
        {
          message: "",
          attachments: [
            { type: "file", id: "notes", name: "notes.txt", mimeType: "text/plain", sizeBytes: 1 },
          ],
        },
        false,
      ),
    ).toThrow("Update the group host");
    expect(() =>
      assertParticipantRichMessages({ message: "Plan", interactionMode: "plan" }, false),
    ).toThrow("Update the group host");
    expect(() =>
      assertParticipantRichMessages(
        { message: "Context", context: { version: 1, records: [] } },
        false,
      ),
    ).toThrow("Update the group host");
    expect(() =>
      assertParticipantRichMessages({ message: "Plan", interactionMode: "plan" }, true),
    ).not.toThrow();
  });
  it("preserves legacy retry receipts while removing their stored message payload", () => {
    const ids = vi.fn();
    const next = nextParticipantSendReceipt(
      {
        key: "same",
        title: "Original",
        requestId: "created",
        sendRequestId: "sent",
        message: "Retry me",
      },
      {
        key: "same",
        title: "Edited title",
        payload: { message: "Retry me" },
      },
      ids,
    );
    expect(next.requestId).toBe("created");
    expect(next.sendRequestId).toBe("sent");
    expect(next.title).toBe("Original");
    expect(next.message).toBeUndefined();
    expect(ids).not.toHaveBeenCalled();
  });

  it("keeps draft identity through upload metadata changes but detects new content or plan choices", () => {
    const file = {
      type: "file" as const,
      id: "notes",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      file: null,
    };
    const draft: ComposerThreadDraftState = {
      prompt: "Inspect",
      images: [],
      files: [file],
      persistedAttachments: [],
      nonPersistedImageIds: [],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
      modelSelectionByProvider: {},
      activeProvider: null,
      runtimeMode: null,
      interactionMode: null,
    };
    expect(
      participantDraftIdentity({
        ...draft,
        files: [{ ...file, uploadedAttachmentId: "server-id", uploadEnvironmentId: environmentId }],
      }),
    ).toBe(participantDraftIdentity(draft));
    expect(participantDraftIdentity({ ...draft, prompt: "A new draft" })).not.toBe(
      participantDraftIdentity(draft),
    );
    expect(participantDraftIdentity({ ...draft, interactionMode: "plan" })).not.toBe(
      participantDraftIdentity(draft),
    );
    expect(participantDraftIdentity({ ...draft, files: [] })).not.toBe(
      participantDraftIdentity(draft),
    );
  });

  it("forwards uploaded files, structured context and the explicit per-turn plan mode", async () => {
    const create = vi.fn().mockResolvedValue(snapshot);
    const send = vi.fn().mockResolvedValue(undefined);
    const attachments = [
      {
        type: "file",
        id: "uploaded-notes",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
      },
    ];
    const context: OrchestrationMessageContext = {
      version: 1,
      records: [
        {
          version: 1,
          kind: "file",
          contextId: ComposerContextId.make("file_notes"),
          attachmentId: "uploaded-notes",
          label: "notes.txt",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 12,
        },
      ],
    };
    await submitParticipantGroup(
      { ...input, attachments, context, interactionMode: "plan" },
      { create, send },
    );
    expect(send).toHaveBeenCalledWith({
      groupId: snapshot.group.id,
      message: input.message,
      attachments,
      context,
      interactionMode: "plan",
      mentionEveryone: true,
      clientRequestId: input.requestId,
    });
  });

  it("keeps attachment-only and context-only messages and rejects an empty send before creating a group", async () => {
    const create = vi.fn().mockResolvedValue(snapshot);
    const send = vi.fn().mockResolvedValue(undefined);
    await submitParticipantGroup(
      {
        ...input,
        message: "",
        attachments: [
          {
            type: "image",
            id: "uploaded-image",
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
        ],
      },
      { create, send },
    );
    await submitParticipantGroup(
      {
        ...input,
        message: "",
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId: ComposerContextId.make("terminal_log"),
              label: "Terminal",
              kind: "terminal",
              terminalId: "terminal",
              terminalLabel: "Build",
              lineStart: 1,
              lineEnd: 1,
              text: "Build failed",
            },
          ],
        },
      },
      { create, send },
    );
    expect(send.mock.calls[0]?.[0].message).toBe("");
    expect(send.mock.calls[1]?.[0].context.records[0].text).toBe("Build failed");
    await expect(
      submitParticipantGroup({ ...input, message: " " }, { create, send }),
    ).rejects.toThrow("Add a message, attachment, or context");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("changes the send receipt for structured payload edits without persisting raw payloads", () => {
    const ids = vi
      .fn()
      .mockReturnValueOnce("create-id")
      .mockReturnValueOnce("send-first")
      .mockReturnValueOnce("send-edited")
      .mockReturnValueOnce("send-plan")
      .mockReturnValueOnce("send-file");
    const context = (screenshot: string): OrchestrationMessageContext => ({
      version: 1,
      records: [
        {
          version: 1,
          contextId: ComposerContextId.make("fixture_preview"),
          label: "Preview",
          kind: "fixture-preview",
          payload: { screenshot },
        },
      ],
    });
    const payload = {
      message: "Inspect this",
      context: context("data:image/png;base64,private"),
    };
    const first = nextParticipantSendReceipt(
      null,
      { key: "same-group", title: "Inspect", payload },
      ids,
    );
    const replay = nextParticipantSendReceipt(
      first,
      { key: "same-group", title: "Inspect", payload },
      ids,
    );
    expect(replay).toEqual(first);
    const editedPayload = { ...payload, context: context("data:image/png;base64,changed") };
    const changed = nextParticipantSendReceipt(
      first,
      {
        key: "same-group",
        title: "Inspect",
        payload: editedPayload,
      },
      ids,
    );
    expect(changed.requestId).toBe("create-id");
    expect(changed.sendRequestId).toBe("send-edited");
    const plan = nextParticipantSendReceipt(
      changed,
      {
        key: "same-group",
        title: "Inspect",
        payload: { ...editedPayload, interactionMode: "plan" },
      },
      ids,
    );
    expect(plan.sendRequestId).toBe("send-plan");
    const file = nextParticipantSendReceipt(
      plan,
      {
        key: "same-group",
        title: "Inspect",
        payload: {
          ...editedPayload,
          interactionMode: "plan",
          attachments: [
            {
              type: "file",
              id: "uploaded-file",
              name: "notes.txt",
              mimeType: "text/plain",
              sizeBytes: 12,
            },
          ],
        },
      },
      ids,
    );
    expect(file.requestId).toBe("create-id");
    expect(file.sendRequestId).toBe("send-file");
    expect(JSON.stringify(first)).not.toContain("data:image");
    expect(JSON.stringify(first)).not.toContain("Inspect this");
    expect(first.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("sends the initial prompt to selected existing mines and reuses both receipt ids after a lost send response", async () => {
    const create = vi.fn().mockResolvedValue(snapshot);
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockResolvedValueOnce(undefined);
    await expect(submitParticipantGroup(input, { create, send })).rejects.toThrow("Response lost");
    await expect(submitParticipantGroup(input, { create, send })).resolves.toBe(snapshot);
    expect(create.mock.calls[0]?.[0]).toEqual(create.mock.calls[1]?.[0]);
    expect(send.mock.calls[0]?.[0]).toEqual(send.mock.calls[1]?.[0]);
    expect(create).toHaveBeenLastCalledWith({
      name: "Build it",
      workflow: "team",
      members: [{ environmentId, threadId: input.members[0]!.threadId, alias: "design" }],
      leadThreadId: input.members[0]!.threadId,
      leadEnvironmentId: environmentId,
      clientRequestId: "retained-request",
    });
    expect(send).toHaveBeenLastCalledWith({
      groupId: snapshot.group.id,
      message: input.message,
      mentionEveryone: true,
      clientRequestId: "retained-request",
    });
  });

  it("does not send a prompt when the group could not be created", async () => {
    const create = vi.fn().mockRejectedValue(new Error("This mine is already grouped"));
    const send = vi.fn();
    await expect(submitParticipantGroup(input, { create, send })).rejects.toThrow(
      "already grouped",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the group creation receipt while a changed prompt gets its own send receipt", async () => {
    const create = vi.fn().mockResolvedValue(snapshot);
    const send = vi.fn().mockResolvedValue(undefined);
    await submitParticipantGroup({ ...input, sendRequestId: "first-message" }, { create, send });
    await submitParticipantGroup(
      { ...input, message: "An edited message", sendRequestId: "edited-message" },
      { create, send },
    );
    expect(create.mock.calls[0]?.[0]).toEqual(create.mock.calls[1]?.[0]);
    expect(send.mock.calls[0]?.[0].clientRequestId).toBe("first-message");
    expect(send.mock.calls[1]?.[0]).toEqual({
      groupId: snapshot.group.id,
      message: "An edited message",
      mentionEveryone: true,
      clientRequestId: "edited-message",
    });
  });
});
