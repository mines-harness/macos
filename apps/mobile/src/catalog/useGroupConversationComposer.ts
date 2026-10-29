import { useEffect, useState } from "react";
import type {
  ChatAttachment,
  EnvironmentId,
  OrchestrationMessageContext,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import { prepareTurnAttachments } from "../lib/attachmentUpload";
import {
  composerContextSendBlockReason,
  referencedComposerContext,
  uploadedComposerContext,
} from "../lib/composerContext";
import { useEnvironmentServerConfig } from "../state/entities";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  flushComposerDrafts,
  replaceComposerDraftAttachments,
  setComposerDraftText,
  useComposerDraft,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "../state/use-composer-drafts";
import {
  groupComposerContentKey,
  groupRichSendBlockReason,
  type openGroupDraft,
} from "./groupDraft";

type GroupDraftStore = Awaited<ReturnType<typeof openGroupDraft>>;
interface GroupComposerPayload {
  readonly message: string;
  readonly attachments?: readonly ChatAttachment[];
  readonly context?: OrchestrationMessageContext;
  readonly clientRequestId: string;
  readonly interactionMode?: ProviderInteractionMode;
}

export function useGroupConversationComposer(input: {
  readonly environmentId: EnvironmentId;
  readonly groupId: string;
  readonly store: GroupDraftStore | undefined;
}) {
  const draftKey = `${input.environmentId}:group/${encodeURIComponent(input.groupId)}`;
  const draft = useComposerDraft(draftKey);
  const serverConfig = useEnvironmentServerConfig(input.environmentId);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { store } = input;
  // oxlint-disable-next-line mines/react-effect-budget -- Group text drafts must migrate after normal composer persistence restores its attachments and context.
  useEffect(() => {
    if (!store) return;
    let disposed = false;
    void waitForComposerDraftsLoaded()
      .then(() => {
        if (disposed) return;
        const current = getComposerDraftSnapshot(draftKey);
        if (!current.text && !current.attachments.length && store.getSnapshot().draft.text)
          setComposerDraftText(draftKey, store.getSnapshot().draft.text);
        setError(null);
        setReadyKey(draftKey);
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setError(
            cause instanceof Error ? cause.message : "Your saved composer could not be opened.",
          );
      });
    return () => {
      disposed = true;
    };
  }, [draftKey, store]);
  const ready = readyKey === draftKey && store !== undefined;
  // oxlint-disable-next-line mines/react-effect-budget -- Native context pastes and transcription update normal draft storage directly; mirror text into encrypted group retry identity.
  useEffect(() => {
    if (ready) store?.setText(draft.text);
  }, [draft.text, ready, store]);
  return {
    draftKey,
    draft,
    serverConfig,
    ready,
    error,
    sendBlockReason: groupRichSendBlockReason(
      draft,
      serverConfig?.environment.capabilities.groupRichMessages === true,
    ),
    setInteractionMode: (interactionMode: ProviderInteractionMode | undefined) =>
      updateComposerDraftSettings(draftKey, { interactionMode }),
    hasContent:
      !!draft.text.trim() || draft.attachments.length > 0 || !!draft.context?.records.length,
    setText: (text: string | ((value: string) => string)) => {
      const next =
        typeof text === "function" ? text(getComposerDraftSnapshot(draftKey).text) : text;
      setComposerDraftText(draftKey, next);
      store?.setText(next);
    },
    clear: () => {
      clearComposerDraftContent(draftKey);
      store?.clear();
    },
    prepare: async (requestAiResponse?: boolean) => {
      if (!store || !ready) throw new Error("Your saved composer is still loading.");
      const captured = getComposerDraftSnapshot(draftKey);
      const context = referencedComposerContext(captured.text, captured.context);
      const blocked = composerContextSendBlockReason(context);
      if (blocked) throw new Error(blocked);
      const unsupported = groupRichSendBlockReason(
        { ...captured, context },
        serverConfig?.environment.capabilities.groupRichMessages === true,
      );
      if (unsupported) throw new Error(unsupported);
      await flushComposerDrafts();
      store.setContent(
        captured.text,
        groupComposerContentKey({ ...captured, context }, requestAiResponse),
      );
      const sent = store.markAttempted();
      await store.flush();
      const prepared = await prepareTurnAttachments({
        environmentId: input.environmentId,
        attachments: captured.attachments,
        supportsImageUploads: true,
        persistUploadedReferences: async (attachments) => {
          const current = getComposerDraftSnapshot(draftKey);
          if (
            captured.text !== current.text ||
            groupComposerContentKey(captured) !== groupComposerContentKey(current)
          )
            return "abandon";
          replaceComposerDraftAttachments(draftKey, attachments);
          await flushComposerDrafts();
          return "persisted";
        },
      });
      if (prepared.status !== "ready")
        throw new Error(
          "Your composer changed while files were uploading. Send the updated message again.",
        );
      const attachments: ChatAttachment[] = prepared.attachments.map((attachment) => {
        if (attachment.id === undefined)
          throw new Error("Reconnect to a server that supports file uploads.");
        return { ...attachment, id: attachment.id };
      });
      const payload: GroupComposerPayload = {
        message: captured.text,
        clientRequestId: sent.requestId,
        ...(captured.interactionMode === undefined
          ? {}
          : { interactionMode: captured.interactionMode }),
        ...(attachments.length ? { attachments } : {}),
        ...(context
          ? { context: uploadedComposerContext(context, captured.attachments, attachments) }
          : {}),
      };
      return {
        payload,
        acknowledge: () => {
          const current = getComposerDraftSnapshot(draftKey);
          const same =
            current.text === captured.text &&
            groupComposerContentKey(current) === groupComposerContentKey(captured);
          if (same) clearComposerDraftContent(draftKey);
          store.acknowledge(sent.requestId);
        },
      };
    },
  };
}
