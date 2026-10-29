import { act, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { ComposerContextId, EnvironmentId } from "@t3tools/contracts";
import type { ComposerDraft } from "../state/use-composer-drafts";
import { openGroupDraft } from "./groupDraft";

const state = vi.hoisted(() => ({
  draft: { text: "", attachments: [] } as ComposerDraft,
  listeners: new Set<() => void>(),
  flush: vi.fn(async () => {}),
  richMessages: true,
}));
const update = (draft: ComposerDraft) => {
  state.draft = draft;
  for (const listener of state.listeners) listener();
};
vi.mock("../state/use-composer-drafts", () => ({
  useComposerDraft: () =>
    useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      },
      () => state.draft,
      () => state.draft,
    ),
  getComposerDraftSnapshot: () => state.draft,
  setComposerDraftText: (_key: string, text: string) => update({ ...state.draft, text }),
  replaceComposerDraftAttachments: (_key: string, attachments: ComposerDraft["attachments"]) =>
    update({ ...state.draft, attachments }),
  updateComposerDraftSettings: (_key: string, settings: Partial<ComposerDraft>) =>
    update({ ...state.draft, ...settings }),
  clearComposerDraftContent: () =>
    update({ ...state.draft, text: "", attachments: [], context: undefined }),
  waitForComposerDraftsLoaded: async () => {},
  flushComposerDrafts: () => state.flush(),
}));
vi.mock("../state/entities", () => ({
  useEnvironmentServerConfig: () => ({
    environment: { capabilities: { groupRichMessages: state.richMessages } },
  }),
}));
vi.mock("../lib/attachmentUpload", () => ({
  prepareTurnAttachments: async (input: {
    attachments: ComposerDraft["attachments"];
    persistUploadedReferences: (attachments: ComposerDraft["attachments"]) => Promise<string>;
  }) => {
    const drafts = input.attachments.map((attachment) => ({
      ...attachment,
      uploadedAttachmentId: `uploaded-${attachment.id}`,
    }));
    if ((await input.persistUploadedReferences(drafts)) === "abandon")
      return { status: "abandoned" };
    return {
      status: "ready",
      attachments: drafts.map((attachment) => ({
        type: attachment.type,
        id: attachment.uploadedAttachmentId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      })),
    };
  },
}));

import { useGroupConversationComposer } from "./useGroupConversationComposer";

async function setup(draft: ComposerDraft, richMessages = true) {
  state.draft = draft;
  state.richMessages = richMessages;
  state.listeners.clear();
  state.flush.mockClear();
  let request = 0;
  const store = await openGroupDraft({
    environmentId: "server",
    groupId: "group",
    createId: () => `request-${++request}`,
    storage: { read: async () => null, write: async () => {} },
  });
  let composer: ReturnType<typeof useGroupConversationComposer> | null = null;
  function Harness() {
    const current = useGroupConversationComposer({
      environmentId: EnvironmentId.make("server"),
      groupId: "group",
      store,
    });
    useLayoutEffect(() => {
      composer = current;
    }, [current]);
    return null;
  }
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  return {
    get composer() {
      return composer!;
    },
    async prepare() {
      let prepared: Awaited<ReturnType<NonNullable<typeof composer>["prepare"]>> | undefined;
      await act(async () => {
        prepared = await composer!.prepare(true);
      });
      return prepared!;
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
    },
  };
}

it("uploads and binds group context and carries explicit Plan choice without a thread", async () => {
  const contextId = ComposerContextId.make("notes");
  using ui = await setup({
    text: "Review [notes.md](mines-context://v1/file/notes)",
    attachments: [
      {
        id: "notes",
        type: "file",
        name: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 8,
        fileUri: "file:///notes.md",
      },
    ],
    context: {
      version: 1,
      records: [
        {
          version: 1,
          kind: "file",
          contextId,
          attachmentId: "notes",
          label: "notes.md",
          name: "notes.md",
          mimeType: "text/markdown",
          sizeBytes: 8,
        },
      ],
    },
    interactionMode: "plan",
  });
  const prepared = await ui.prepare();
  expect(prepared.payload.interactionMode).toBe("plan");
  expect(prepared.payload.attachments?.[0]?.id).toBe("uploaded-notes");
  expect(prepared.payload.context?.records[0]).toMatchObject({ attachmentId: "uploaded-notes" });
  expect(state.flush).toHaveBeenCalled();
});

it("keeps plain old-host retries idempotent and preserves a newer normal composer draft on acknowledgement", async () => {
  using ui = await setup({ text: "First", attachments: [] }, false);
  const first = await ui.prepare();
  expect((await ui.prepare()).payload.clientRequestId).toBe(first.payload.clientRequestId);
  act(() => ui.composer.setText("Next"));
  act(() => first.acknowledge());
  expect(state.draft.text).toBe("Next");
  expect((await ui.prepare()).payload.clientRequestId).not.toBe(first.payload.clientRequestId);
});

it("refuses rich payloads before upload when an older host would silently drop them", async () => {
  using ui = await setup(
    {
      text: "Keep this file",
      attachments: [
        {
          id: "file",
          type: "file",
          name: "notes.md",
          mimeType: "text/markdown",
          sizeBytes: 8,
          fileUri: "file:///notes.md",
        },
      ],
    },
    false,
  );
  await expect(ui.prepare()).rejects.toThrow("Update Mines on this computer from Devices");
  expect(state.flush).not.toHaveBeenCalled();
  expect(state.draft.attachments).toHaveLength(1);
});

it("sends attachment-only messages while inheriting each mine's mode", async () => {
  using ui = await setup({
    text: "",
    attachments: [
      {
        id: "image",
        type: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 24,
        previewUri: "file:///image.png",
        fileUri: "file:///image.png",
      },
    ],
  });
  expect(ui.composer.hasContent).toBe(true);
  const prepared = await ui.prepare();
  expect(prepared.payload.message).toBe("");
  expect(prepared.payload.attachments).toHaveLength(1);
  expect(prepared.payload.interactionMode).toBeUndefined();
});

it("does not send when composer persistence fails", async () => {
  using ui = await setup({ text: "Keep me", attachments: [] });
  state.flush.mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(ui.prepare()).rejects.toThrow("Storage unavailable");
  expect(state.draft.text).toBe("Keep me");
});
