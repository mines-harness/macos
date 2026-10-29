import { useRef, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import type { ConversationActivityKind, EnvironmentId } from "@t3tools/contracts";
import type { GroupMember } from "@t3tools/contracts/groupChat";
import { groupPlanModeBlockReason } from "@t3tools/client-runtime/group-chat";
import { pastedTextDisposition, replaceTextSelection } from "@t3tools/client-runtime/text-paste";
import { appAtomRegistry } from "../state/atom-registry";
import {
  composerDraftsAtom,
  getComposerDraftSnapshot,
  removeComposerDraftAttachment,
} from "../state/use-composer-drafts";
import { useThreadShells } from "../state/entities";
import { useComposerAttachmentActions } from "../state/use-composer-attachment-actions";
import { composerStripAttachments } from "../lib/composerImages";
import * as Dialog from "../components/ui/Dialog";
import { ComposerEditor, type ComposerEditorHandle } from "../components/ComposerEditor";
import { ComposerAttachmentStrip } from "../components/ComposerAttachmentStrip";
import {
  ComposerActionButton,
  ComposerInlineControl,
  ComposerToolbarRow,
  ComposerToolbarScroller,
} from "../components/ComposerToolbar";
import { FilePreviewModal, type FilePreviewSource } from "../components/FilePreviewModal";
import { VideoPreviewModal, type VideoPreviewSource } from "../components/VideoPreviewModal";
import { ComposerAttachmentButton } from "../features/threads/ComposerAttachmentButton";
import { Menu } from "../components/ui/Menu";
import { SymbolView } from "../components/ui/AppSymbol";
import { AppText as Text } from "../components/ui/AppText";
import { ComposerSurface } from "../features/threads/ThreadComposer";
import { ComposerCommandPopover } from "../features/threads/ComposerCommandPopover";
import { useComposerCommandMenu } from "../features/threads/use-composer-command-menu";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import { useVoiceInputController } from "../features/voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../features/voice-input/voiceInputPresentation";
import {
  ComposerDictationCancelAction,
  ComposerDictationPrimaryAction,
  ComposerDictationStatus,
} from "../features/voice-input/ComposerDictationControl";
import type { useGroupConversationComposer } from "./useGroupConversationComposer";
import { useConversationActivityPublisher } from "../state/conversationActivity";

type GroupComposer = ReturnType<typeof useGroupConversationComposer>;
const silentActivity = (_kind: ConversationActivityKind) => {};

export function GroupConversationComposer({
  composer,
  environmentId,
  label,
  disabled,
  busy,
  canSend,
  onSend,
  publishActivity,
  activityEnabled = true,
  members,
  planApplies = true,
  children,
}: {
  readonly composer: GroupComposer;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly canSend: boolean;
  readonly onSend: () => void;
  readonly publishActivity?: (kind: ConversationActivityKind) => void;
  readonly activityEnabled?: boolean;
  readonly members: readonly GroupMember[];
  readonly planApplies?: boolean;
  readonly children?: ReactNode;
}) {
  const editor = useRef<ComposerEditorHandle>(null);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const [video, setVideo] = useState<VideoPreviewSource | null>(null);
  const textStyle = useScaledTextRole("body");
  const richSupported = composer.serverConfig?.environment.capabilities.groupRichMessages === true;
  const blockReason =
    composer.sendBlockReason ??
    (planApplies && composer.draft.interactionMode === "plan"
      ? groupPlanModeBlockReason(composer.draft.text, members)
      : null);
  const menu = useComposerCommandMenu({
    draftMessage: composer.draft.text,
    ownerKey: composer.draftKey,
    environmentId,
    threadShells: useThreadShells(),
    projectCwd: null,
    selectedProviderStatus: null,
    hasThread: false,
    hasCompactableConversation: false,
    enabled: !disabled && !busy,
    onChangeDraftMessage: composer.setText,
    onUpdateInteractionMode: richSupported ? composer.setInteractionMode : undefined,
  });
  const voice = useVoiceInputController({
    ownerKey: composer.draftKey,
    label,
    readDraftMessage: () => getComposerDraftSnapshot(composer.draftKey).text,
    subscribeToDraftChanges: (onChange) => appAtomRegistry.subscribe(composerDraftsAtom, onChange),
    selection: menu.selection,
    disabled: disabled || busy,
    onChangeDraftMessage: composer.setText,
    onChangeSelection: menu.onSelectionChange,
  });
  const activity = useConversationActivityPublisher({
    scopeKey: composer.draftKey,
    enabled: !disabled && composer.ready && activityEnabled,
    captureActive: voice.state.phase === "recording",
    publish: publishActivity ?? silentActivity,
  });
  const locked = disabled || busy || !composer.ready || voice.freezesEditor;
  const stripAttachments = composerStripAttachments(composer.draft.attachments);
  const attachments = useComposerAttachmentActions({
    draftKey: composer.draftKey,
    serverConfig: composer.serverConfig,
    locked,
  });
  const voicePresentation = resolveVoiceComposerPresentation(voice.state, voice.elapsedSeconds);
  const menuItems = menu.items.filter(
    (item) => item.type !== "slash-command" || item.command !== "model",
  );
  const submit = () => {
    if (!canSend || locked || voice.blocksSubmission || blockReason) return;
    activity.onSubmit();
    onSend();
  };
  return (
    <View className="shrink-0 px-3 pt-2 pb-3">
      {menu.trigger && menuItems.length ? (
        <View className="absolute right-3 bottom-full left-3">
          <ComposerCommandPopover
            items={menuItems}
            triggerKind={menu.trigger.kind}
            isLoading={menu.isLoading}
            error={menu.error}
            onSelect={menu.onSelect}
          />
        </View>
      ) : null}
      <ComposerSurface
        animateLayout={false}
        style={{
          borderRadius: 27,
          borderCurve: "circular",
          overflow: "hidden",
          paddingVertical: 2,
        }}
      >
        {blockReason ? (
          <Text accessibilityRole="alert" className="px-3 pt-2 text-xs text-foreground-muted">
            {blockReason}
          </Text>
        ) : null}
        {stripAttachments.length ? (
          <View className="px-3 pt-3">
            <ComposerAttachmentStrip
              environmentId={environmentId}
              attachments={stripAttachments}
              onRemove={(id) => {
                if (!locked) removeComposerDraftAttachment(composer.draftKey, id);
              }}
              onPressPreview={setPreview}
              onPressVideo={(attachment) => setVideo({ type: "local", attachment })}
              onPressDocument={(attachment) =>
                setPreview({
                  kind: /pdf/i.test(attachment.mimeType) ? "pdf" : "document",
                  attachment,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                })
              }
            />
          </View>
        ) : null}
        <View className="px-3 pt-2">
          <ComposerEditor
            ref={editor}
            draftKey={composer.draftKey}
            environmentId={environmentId}
            accessibilityLabel={label}
            multiline
            value={composer.draft.text}
            selection={menu.selection}
            onSelectionChange={menu.onSelectionChange}
            onChangeText={(value) => {
              composer.setText(value);
              activity.onEdit();
            }}
            onBlur={activity.onBlur}
            onPasteImages={(uris) => void attachments.onNativePasteImages(uris)}
            onPasteText={(paste) => {
              if (locked) return;
              const insertion = replaceTextSelection({
                value: paste.value,
                selection: paste.selection,
                text: paste.text,
              });
              const tooLong = insertion.value.length > 120_000;
              const supportsFiles =
                !!composer.serverConfig?.environment.capabilities.attachmentUploads &&
                !!composer.serverConfig.environment.capabilities.fileAttachments;
              if (
                pastedTextDisposition({
                  text: paste.text,
                  wouldExceedInputLimit: tooLong,
                  canAttach: true,
                }) === "attachment" &&
                supportsFiles
              ) {
                void attachments.onNativePasteText(paste);
              } else if (!tooLong) {
                composer.setText(insertion.value);
                menu.onSelectionChange({ start: insertion.cursor, end: insertion.cursor });
                activity.onEdit(!!insertion.value);
              } else
                Dialog.alert(
                  "Pasted text is too large",
                  "Attach it as a file or use a shorter message.",
                );
            }}
            onSubmit={submit}
            placeholder="Message the group"
            editable={!locked}
            maxLength={120_000}
            contentInsetVertical={8}
            textStyle={textStyle}
            style={{ maxHeight: 160, minHeight: 44 }}
          />
        </View>
        <ComposerToolbarRow paddingTop={0} paddingBottom={0}>
          {voicePresentation.statusLabel ? (
            <>
              <ComposerDictationCancelAction
                presentation={voicePresentation}
                onCancel={voice.cancel}
              />
              <ComposerDictationStatus
                audioLevels={voice.audioLevels}
                elapsedSeconds={voice.elapsedSeconds}
                phase={voice.state.phase}
                presentation={voicePresentation}
                onDismissError={voice.cancel}
              />
            </>
          ) : (
            <>
              {richSupported &&
              composer.serverConfig?.environment.capabilities.attachmentUploads ? (
                <ComposerAttachmentButton
                  disabled={locked}
                  supportsFiles={!!composer.serverConfig.environment.capabilities.fileAttachments}
                  onPickMedia={attachments.onPickDraftMedia}
                  onPickFiles={attachments.onPickDraftFiles}
                />
              ) : null}
              <ComposerToolbarScroller>
                <View className="min-w-0">{children}</View>
                {composer.draft.interactionMode === "plan" ? (
                  <ComposerInlineControl
                    label="Plan"
                    accessibilityLabel="Exit plan mode"
                    icon="pencil"
                    selected
                    showChevron={false}
                    disabled={locked}
                    onPress={() => composer.setInteractionMode("default")}
                  />
                ) : null}
                <Menu
                  actions={[
                    {
                      id: "plan",
                      title: "Plan mode",
                      image: "pencil",
                      state: composer.draft.interactionMode === "plan" ? "on" : "off",
                      attributes: { disabled: locked || !richSupported },
                    },
                    {
                      id: "default",
                      title: "Default mode",
                      image: "arrow.up",
                      state: composer.draft.interactionMode === "default" ? "on" : "off",
                      attributes: { disabled: locked || !richSupported },
                    },
                    {
                      id: "inherit",
                      title: "Use each mine’s mode",
                      state: composer.draft.interactionMode === undefined ? "on" : "off",
                      attributes: { disabled: locked },
                    },
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    if (nativeEvent.event === "plan" || nativeEvent.event === "default")
                      composer.setInteractionMode(nativeEvent.event);
                    else if (nativeEvent.event === "inherit")
                      composer.setInteractionMode(undefined);
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Composer options"
                    disabled={locked}
                    className="h-11 w-9 items-center justify-center"
                  >
                    <SymbolView name="ellipsis" size={20} tintColorClassName="accent-icon-muted" />
                  </Pressable>
                </Menu>
              </ComposerToolbarScroller>
            </>
          )}
          <ComposerDictationPrimaryAction
            state={voice.state}
            presentation={voicePresentation}
            isAvailable={voice.isAvailable}
            disabled={disabled || busy}
            onStart={voice.start}
            onConfirm={voice.stop}
            onCancel={voice.cancel}
          />
          {voicePresentation.showsSend ? (
            <ComposerActionButton
              accessibilityLabel="Send to group"
              icon="arrow.up"
              variant="primary"
              disabled={!canSend || locked || blockReason !== null}
              onPress={submit}
            />
          ) : null}
        </ComposerToolbarRow>
      </ComposerSurface>
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
      <VideoPreviewModal source={video} onRequestClose={() => setVideo(null)} />
    </View>
  );
}
