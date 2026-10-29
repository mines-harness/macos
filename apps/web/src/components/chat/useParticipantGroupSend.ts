import { useNavigate } from "@tanstack/react-router";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ChatAttachment, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  composerTargetKey,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "../../hooks/useLocalStorage";
import {
  buildMessageContext,
  previewAnnotationContextReference,
} from "../../lib/composerContextRecords";
import { ensureInlineContextReferences } from "../../lib/composerContextReferences";
import { filterTerminalContextsWithText } from "../../lib/terminalContext";
import {
  awaitAttachmentUploads,
  readAttachmentUpload,
  releaseDraftAttachments,
  retryAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { groupCreate, groupSend } from "../../state/groups";
import { refreshGroupMemberships } from "../../state/groupMemberships";
import { environmentServerConfigsAtom } from "../../state/server";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import {
  boundAttachmentIds,
  mergeDirectPreviewAnnotation,
  sendTitleFallbackLabels,
  snapshotComposerSend,
  type makeThreadErrorSetter,
} from "../ChatView.logic";
import { toastManager } from "../ui/toast";
import { draftSendState, prepareTurnAttachments } from "./chatViewSend";
import {
  participantDraftKey,
  participantSendBusyAtom,
  useDraftParticipants,
} from "./draftParticipantState";
import { completeParticipantDraft, ParticipantDraft } from "./draftParticipants";
import {
  nextParticipantSendReceipt,
  assertParticipantRichMessages,
  participantDraftIdentity,
  ParticipantSendReceipt,
  submitParticipantGroup,
} from "./participantGroupSend";

const isChatAttachment = Schema.is(ChatAttachment);

export function useParticipantGroupSend({
  environmentId,
  composerDraftTarget,
  routeThreadKey,
  currentRouteThreadKeyRef,
  composerRef,
  promptRef,
  setThreadError,
}: {
  environmentId: EnvironmentId;
  composerDraftTarget: ComposerThreadTarget;
  routeThreadKey: string;
  currentRouteThreadKeyRef: { readonly current: string | null };
  composerRef: ComposerHandleRef;
  promptRef: { current: string };
  setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}) {
  const [draft, setDraft] = useDraftParticipants(composerDraftTarget);
  const create = useOrchestrationCommand(groupCreate, { reportFailure: false });
  const send = useOrchestrationCommand(groupSend, { reportFailure: false });
  const navigate = useNavigate();
  const targetKey = composerTargetKey(composerDraftTarget);
  const receiptKey = `mines:participant-send:${targetKey}`;

  return {
    hasParticipants: draft.members.length > 0,
    send: async (
      threadId: ThreadId,
      directAnnotation?: Parameters<typeof mergeDirectPreviewAnnotation>[0]["direct"],
    ) => {
      const sending = draftSendState(routeThreadKey).sendInFlight;
      if (sending.current) return;
      sending.current = true;
      appAtomRegistry.set(participantSendBusyAtom(targetKey), true);
      setThreadError(threadId, null);
      const original = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
      const originalIdentity = participantDraftIdentity(original);
      const result = await settlePromise(async () => {
        if (!draft.members.length || draft.members.length > 12)
          throw new Error("Choose between 1 and 12 participants.");
        const sendContext = composerRef.current?.getSendContext();
        if (!sendContext) throw new Error("The composer is still preparing. Try sending again.");
        const merged = mergeDirectPreviewAnnotation({
          images: sendContext.images,
          fileCount: sendContext.files.length,
          previewAnnotations: sendContext.previewAnnotations,
          direct: directAnnotation,
        });
        if (
          original?.persistedAttachments.some(
            (attachment) => !merged.images.some((image) => image.id === attachment.id),
          )
        )
          throw new Error("Wait for the attached images to finish preparing before sending.");
        const snapshot = snapshotComposerSend({
          prompt: directAnnotation
            ? ensureInlineContextReferences(sendContext.prompt, [
                previewAnnotationContextReference(directAnnotation.annotation),
              ])
            : sendContext.prompt,
          images: merged.images,
          files: sendContext.files,
          terminalContexts: sendContext.terminalContexts,
          sendableTerminalContexts: filterTerminalContextsWithText(sendContext.terminalContexts),
          previewAnnotations: merged.previewAnnotations,
          reviewComments: sendContext.reviewComments,
          threadContexts: sendContext.threadContexts,
        });
        if (snapshot.attachments.length > 20)
          throw new Error("Groups support up to 20 attachments per message.");
        const draftContext = buildMessageContext({ ...snapshot, attachments: [] });
        assertParticipantRichMessages(
          {
            message: snapshot.messageText,
            attachments: snapshot.attachments,
            ...(draftContext ? { context: draftContext } : {}),
            ...(original?.interactionMode ? { interactionMode: sendContext.interactionMode } : {}),
          },
          appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment
            .capabilities.groupRichMessages === true,
        );
        if (snapshot.attachments.length) {
          if (
            appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment
              .capabilities.attachmentUploads !== true
          )
            throw new Error("Update this server before sending attachments to participants.");
          for (const attachment of snapshot.attachments) {
            const upload =
              readAttachmentUpload(attachment.id)?.status === "failed"
                ? retryAttachmentUpload
                : startAttachmentUpload;
            upload({ environmentId, image: attachment, draftTarget: composerDraftTarget });
          }
          await awaitAttachmentUploads(snapshot.attachments.map((attachment) => attachment.id));
        }
        const attachments = await prepareTurnAttachments({
          environmentId,
          attachments: snapshot.attachments,
          usesAttachmentUploads: true,
        });
        if (!attachments.every(isChatAttachment))
          throw new Error("Retry or remove failed uploads before sending to participants.");
        const attachmentIds = boundAttachmentIds(attachments, snapshot.attachments);
        const context = buildMessageContext({
          terminalContexts: snapshot.terminalContexts,
          previewAnnotations: snapshot.previewAnnotations,
          reviewComments: snapshot.reviewComments,
          threadContexts: snapshot.threadContexts,
          attachments: snapshot.attachments.map((attachment, index) => ({
            attachment,
            attachmentId: attachmentIds[index]!,
          })),
        });
        const payload = {
          message: snapshot.messageText,
          ...(attachments.length ? { attachments } : {}),
          ...(context ? { context } : {}),
          ...(original?.interactionMode ? { interactionMode: sendContext.interactionMode } : {}),
        };
        const key = JSON.stringify([environmentId, draft.members]);
        const receipt = nextParticipantSendReceipt(
          getLocalStorageItem(receiptKey, ParticipantSendReceipt),
          {
            key,
            title: deriveThreadTitleSeed({
              text: snapshot.messageText,
              attachments,
              fallbackLabels: sendTitleFallbackLabels(snapshot),
            }),
            payload,
          },
          randomUUID,
        );
        setLocalStorageItem(receiptKey, receipt, ParticipantSendReceipt);
        const group = await submitParticipantGroup(
          {
            environmentId,
            members: draft.members,
            title: receipt.title,
            ...payload,
            requestId: receipt.requestId,
            sendRequestId: receipt.sendRequestId,
          },
          {
            create: async (input) => {
              const created = await create({ environmentId, input });
              if (created._tag === "Failure") throw squashAtomCommandFailure(created);
              refreshGroupMemberships(environmentId);
              return created.value;
            },
            send: async (input) => {
              const sent = await send({ environmentId, input });
              if (sent._tag === "Failure") throw squashAtomCommandFailure(sent);
              return sent.value;
            },
          },
        );
        return { snapshot: group, attachments: snapshot.attachments };
      });
      sending.current = false;
      appAtomRegistry.set(participantSendBusyAtom(targetKey), false);
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setThreadError(
          threadId,
          failure instanceof Error
            ? failure.message
            : "The group message could not be accepted. Your participants and draft are saved; retry when connected.",
        );
        return;
      }
      const participantsUnchanged =
        getLocalStorageItem(participantDraftKey(composerDraftTarget), ParticipantDraft)
          ?.revision === draft.revision;
      setDraft((current) => completeParticipantDraft(current, draft.revision));
      removeLocalStorageItem(receiptKey);
      if (
        participantsUnchanged &&
        participantDraftIdentity(
          useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
        ) === originalIdentity
      ) {
        useComposerDraftStore.getState().clearComposerContent(composerDraftTarget);
        releaseDraftAttachments(result.value.attachments);
        if (currentRouteThreadKeyRef.current === routeThreadKey) {
          promptRef.current = "";
          composerRef.current?.resetCursorState();
        }
      }
      const openGroup = () =>
        navigate({
          to: "/$environmentId/groups/$groupId",
          params: { environmentId, groupId: result.value.snapshot.group.id },
        });
      if (currentRouteThreadKeyRef.current === routeThreadKey) await openGroup();
      else
        toastManager.add({
          type: "success",
          title: "Your group is ready",
          actionProps: { children: "Open group", onClick: () => void openGroup() },
        });
    },
  };
}
