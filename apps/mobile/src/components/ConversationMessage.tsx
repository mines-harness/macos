import { useState } from "react";
import { View } from "react-native";
import type {
  ChatAttachment,
  ComposerContextRecord,
  EnvironmentId,
  OrchestrationMessageContext,
} from "@t3tools/contracts";
import {
  parseComposerContextHref,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import {
  SelectableMarkdownText,
  type MarkdownImageRenderer,
} from "../native/SelectableMarkdownText";
import { enrichedContextLinkCustomization } from "../native/useEnrichedLinkVariants";
import { tryOpenExternalUrl } from "../lib/openExternalUrl";
import { MessageAttachmentList, useMarkdownStyles } from "../features/threads/ThreadFeed";
import { FilePreviewModal, type FilePreviewSource } from "./FilePreviewModal";
import { ComposerContextSheet } from "./ComposerContextSheet";
import { useOpenLinkedThread } from "../features/threads/useOpenLinkedThread";
import { CopyTextButton } from "../features/threads/CopyTextButton";

export function ConversationMessage({
  environmentId,
  text,
  user,
  attachments,
  context,
  renderImage,
}: {
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly user: boolean;
  readonly attachments?: readonly ChatAttachment[];
  readonly context?: OrchestrationMessageContext;
  readonly renderImage?: MarkdownImageRenderer;
}) {
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const [selectedContext, setSelectedContext] = useState<ComposerContextRecord | null>(null);
  const openThread = useOpenLinkedThread();
  const styles = useMarkdownStyles();
  const markdownStyle = user ? styles.user : styles.assistant;
  return (
    <View className="gap-2">
      {text ? (
        <SelectableMarkdownText
          markdown={replaceComposerContextReferences(
            text,
            (reference) =>
              `[${reference.label}](mines-context://v1/${reference.kind}/${reference.contextId})`,
          )}
          preserveSoftBreaks={user}
          textStyle={markdownStyle.nativeTextStyle}
          renderImage={renderImage}
          contextClipboardFragment={
            context
              ? (encodeComposerContextFragment({
                  version: 1,
                  source: { environmentId },
                  records: context.records,
                }) ?? undefined)
              : undefined
          }
          onLinkPress={(href) => {
            const reference = parseComposerContextHref(href);
            const record = context?.records.find(
              (candidate) => candidate.contextId === reference?.contextId,
            );
            if (record) setSelectedContext(record);
            else void tryOpenExternalUrl(href, "markdown-link");
          }}
          linkCustomization={(href) =>
            enrichedContextLinkCustomization(href, context?.records ?? []) ?? undefined
          }
        />
      ) : null}
      {attachments?.length ? (
        <MessageAttachmentList
          attachments={attachments}
          environmentId={environmentId}
          onPressPreview={setPreview}
        />
      ) : null}
      {text ? (
        <CopyTextButton
          text={text}
          accessibilityLabel="Copy message"
          tintColor={markdownStyle.nativeTextStyle.mutedColor}
          buttonSize={28}
          iconSize={13}
        />
      ) : null}
      {selectedContext ? (
        <ComposerContextSheet
          label={selectedContext.label}
          record={selectedContext}
          records={context?.records}
          environmentId={environmentId}
          onClose={() => setSelectedContext(null)}
          onOpenThread={(thread) => {
            setSelectedContext(null);
            openThread(thread);
          }}
        />
      ) : null}
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </View>
  );
}
