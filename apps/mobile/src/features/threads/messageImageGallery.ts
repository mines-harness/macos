import { redactDeletedGuestMessage } from "@t3tools/client-runtime/user-message";
import type {
  ChatAttachment,
  EnvironmentId,
  OrchestrationMessageContext,
  ThreadId,
} from "@t3tools/contracts";
import { imageMimeType } from "@t3tools/shared/image";
import type { FilePreviewItem } from "../../components/FilePreviewModal.types";
import { markdownImageSources } from "../../lib/markdownImageSources";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";

export function messageImageGallery(
  message: {
    readonly text: string;
    readonly attachments?: readonly ChatAttachment[];
    readonly context?: OrchestrationMessageContext;
  },
  context: {
    environmentId: EnvironmentId;
    threadId: ThreadId;
    workspaceRoot: string | null | undefined;
  },
): FilePreviewItem[] {
  const visible = redactDeletedGuestMessage(message);
  const images: FilePreviewItem[] = [];
  for (const attachment of visible.attachments ?? []) {
    if (attachment.type !== "image" && imageMimeType(attachment) === null) continue;
    images.push({
      kind: "image",
      name: attachment.name,
      environmentId: context.environmentId,
      resource: {
        _tag: "attachment",
        attachmentId: attachment.id,
        fileName: attachment.name,
        mimeType: attachment.mimeType,
      },
    });
  }
  for (const href of markdownImageSources(visible.text)) {
    const preview = resolveMarkdownMediaPreview(href, { ...context, imageEmbed: true });
    if (preview?.kind === "image") images.push(preview.source);
  }
  return images;
}
