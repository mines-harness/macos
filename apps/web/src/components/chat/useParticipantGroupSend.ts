import { useNavigate } from "@tanstack/react-router";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
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
import { buildMessageContext } from "../../lib/composerContextRecords";
import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { groupCreate, groupSend } from "../../state/groups";
import { refreshGroupMemberships } from "../../state/groupMemberships";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { withMessageContext, type makeThreadErrorSetter } from "../ChatView.logic";
import { toastManager } from "../ui/toast";
import { draftSendState } from "./chatViewSend";
import { participantSendBusyAtom, useDraftParticipants } from "./draftParticipantState";
import { completeParticipantDraft } from "./draftParticipants";
import { submitParticipantGroup } from "./participantGroupSend";

const ParticipantSendReceipt = Schema.Struct({
  key: Schema.String,
  requestId: Schema.String,
  title: Schema.String,
  message: Schema.String,
  sendRequestId: Schema.String,
});

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
    send: async (threadId: ThreadId) => {
      const sending = draftSendState(routeThreadKey).sendInFlight;
      if (sending.current) return;
      sending.current = true;
      appAtomRegistry.set(participantSendBusyAtom(targetKey), true);
      setThreadError(threadId, null);
      const original = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
      const result = await settlePromise(async () => {
        if (!original?.prompt.trim())
          throw new Error("Write a message for your participants first.");
        if (original.images.length || original.files.length || original.persistedAttachments.length)
          throw new Error(
            "Groups accept text and workspace references. Remove attachments before sending to participants.",
          );
        if (!draft.members.length || draft.members.length > 12)
          throw new Error("Choose between 1 and 12 participants.");
        const message = withMessageContext({
          text: original.prompt,
          context: buildMessageContext(original),
          supportsInlineMessageContext: false,
        }).text;
        if (message.length > 120_000)
          throw new Error("This group message and its context exceed 120,000 characters.");
        const key = JSON.stringify([environmentId, draft.members]);
        let receipt = getLocalStorageItem(receiptKey, ParticipantSendReceipt);
        if (!receipt || receipt.key !== key) {
          receipt = {
            key,
            requestId: randomUUID(),
            title: deriveThreadTitleSeed({ text: original.prompt, attachments: [] }),
            message,
            sendRequestId: randomUUID(),
          };
          setLocalStorageItem(receiptKey, receipt, ParticipantSendReceipt);
        } else if (receipt.message !== message) {
          receipt = { ...receipt, message, sendRequestId: randomUUID() };
          setLocalStorageItem(receiptKey, receipt, ParticipantSendReceipt);
        }
        return submitParticipantGroup(
          {
            environmentId,
            members: draft.members,
            title: receipt.title,
            message,
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
      setDraft((current) => completeParticipantDraft(current, draft.revision));
      removeLocalStorageItem(receiptKey);
      if (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget) === original) {
        useComposerDraftStore.getState().clearComposerContent(composerDraftTarget);
        if (currentRouteThreadKeyRef.current === routeThreadKey) {
          promptRef.current = "";
          composerRef.current?.resetCursorState();
        }
      }
      const openGroup = () =>
        navigate({
          to: "/$environmentId/groups/$groupId",
          params: { environmentId, groupId: result.value.group.id },
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
