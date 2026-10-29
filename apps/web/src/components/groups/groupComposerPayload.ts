import type { EnvironmentId } from "@t3tools/contracts";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import { awaitAttachmentUploads, getUploadedAttachments } from "../../lib/attachmentUploadQueue";
import { buildMessageContext } from "../../lib/composerContextRecords";

export async function prepareGroupComposerPayload(
  environmentId: EnvironmentId,
  draft: ReturnType<ChatComposerHandle["getSendContext"]>,
) {
  const staged = [...draft.images, ...draft.files];
  await awaitAttachmentUploads(staged.map((file) => file.id));
  const attachments = getUploadedAttachments({ environmentId, images: staged });
  if (staged.length > 0 && !attachments)
    throw new Error("Wait for attached files to finish uploading, or retry the failed upload.");
  const context = buildMessageContext({
    terminalContexts: draft.terminalContexts,
    reviewComments: draft.reviewComments,
    previewAnnotations: draft.previewAnnotations,
    threadContexts: draft.threadContexts,
    attachments: staged.map((attachment, index) => ({
      attachment,
      attachmentId: attachments?.[index]?.id ?? attachment.id,
    })),
  });
  return {
    message: draft.prompt,
    ...(attachments?.length ? { attachments } : {}),
    ...(context ? { context } : {}),
  };
}
