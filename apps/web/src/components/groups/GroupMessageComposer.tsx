import { useAtomValue } from "@effect/atom-react";
import type {
  ChatAttachment,
  EnvironmentId,
  GroupSnapshot,
  OrchestrationMessageContext,
} from "@t3tools/contracts";
import { MessageId, type ModelSelection, type ProviderInteractionMode } from "@t3tools/contracts";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  useComposerDraftStore,
  useComposerThreadDraft,
  DraftId,
  type ComposerImageAttachment,
  type ComposerFileAttachment,
} from "../../composerDraftStore";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { randomUUID } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { prepareGroupComposerPayload } from "./groupComposerPayload";
import type { ChatMessage } from "../../types";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import { ChatComposer, type ChatComposerHandle } from "../chat/ChatComposer";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { ComposerSurface } from "../chat/ComposerSurface";
import { ComposerPlanControl } from "../chat/ComposerFooterControls";
import { ComposerControl } from "../chat/ComposerControl";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogHeader,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { AttachmentFilePreview } from "../files/AttachmentFilePreview";
import type { GroupMember } from "@t3tools/contracts";
import { UsersIcon } from "lucide-react";
import { toastManager } from "../ui/toast";
import * as Schema from "effect/Schema";
import { groupComposerReceiptKey, groupPlanModeBlockReason } from "./groupComposerTargets";

export interface GroupComposerMessage {
  readonly message: string;
  readonly clientRequestId: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext;
  readonly interactionMode?: ProviderInteractionMode;
}

const RetryDraft = Schema.Struct({ content: Schema.String, requestId: Schema.String });
const noop = () => {};
const nothingSelected = () => null;
const emptySelections: ReadonlyArray<ModelSelection> = [];

export function GroupMessageComposer({
  draftKey,
  environmentId,
  snapshot = null,
  value,
  onChange,
  onSubmit,
  ariaLabel,
  placeholder,
  disabled,
  sendDisabledReason = null,
  isSendBusy = false,
  editorRef: providedEditorRef,
  onDraftActivity,
  getTimelineScrollableNode = nothingSelected,
  authorFriendId,
  submissionKey = "",
  onPlanModeChange,
  onOpenMember,
  canOpenMember,
  purpose = "group-message",
  literalText = false,
  onVoiceInputBusyChange,
  children,
}: {
  readonly draftKey: string;
  readonly environmentId: EnvironmentId;
  readonly snapshot?: GroupSnapshot | null;
  readonly authorFriendId?: string;
  readonly submissionKey?: string;
  readonly onPlanModeChange?: (active: boolean) => void;
  readonly onOpenMember?: (member: GroupMember) => void;
  readonly canOpenMember?: (member: GroupMember) => boolean;
  readonly purpose?: "group-message" | "question-answer";
  readonly literalText?: boolean;
  readonly onVoiceInputBusyChange?: (busy: boolean) => void;
  readonly getTimelineScrollableNode?: () => HTMLElement | null;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (alternate: boolean, message: GroupComposerMessage) => Promise<boolean>;
  readonly ariaLabel: string;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly sendDisabledReason?: string | null;
  readonly isSendBusy?: boolean;
  readonly submitOnEnter?: boolean;
  readonly editorRef?: RefObject<ChatComposerHandle | null>;
  readonly onDraftActivity?: (kind: "typing" | "voice" | "idle") => void;
  readonly children: ReactNode;
}) {
  const target = DraftId.make(`group-composer:${draftKey}`);
  const draft = useComposerThreadDraft(target);
  const lastExternalText = useRef(value);
  const initialized = useRef(false);
  const localComposerRef = useRef<ChatComposerHandle>(null);
  const composerRef = providedEditorRef ?? localComposerRef;
  const promptRef = useRef(draft.prompt);
  const imagesRef = useRef<ComposerImageAttachment[]>([]);
  const filesRef = useRef<ComposerFileAttachment[]>([]);
  const terminalsRef = useRef<TerminalContextDraft[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const inFlight = useRef(false);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const settings = useEnvironmentSettings(environmentId);
  const { resolvedTheme } = useTheme();
  const environment = useEnvironment(environmentId);
  const [retry, setRetry] = useLocalStorage(
    `mines:group-composer-retry:${draftKey}`,
    { content: "", requestId: randomUUID() },
    RetryDraft,
  );

  // oxlint-disable-next-line mines/react-effect-budget -- Migrates saved plain group drafts into the shared rich draft store and accepts external draft replacements.
  useLayoutEffect(() => {
    const store = useComposerDraftStore.getState();
    if (!initialized.current) {
      initialized.current = true;
      if (purpose === "question-answer") {
        if (draft.prompt !== value) store.setPrompt(target, value);
        lastExternalText.current = value;
        return;
      }
      if (!store.getComposerDraft(target) && value) store.setPrompt(target, value);
      else if (draft.prompt !== value) {
        lastExternalText.current = draft.prompt;
        onChange(draft.prompt);
      }
      return;
    }
    if (value !== lastExternalText.current) {
      lastExternalText.current = value;
      store.setPrompt(target, value);
    }
  }, [target, value, draft.prompt, onChange, purpose]);
  // oxlint-disable-next-line mines/react-effect-budget -- Mirrors rich-composer text into the pre-existing durable group draft while older app versions still read it.
  useEffect(() => {
    if (draft.prompt === lastExternalText.current) return;
    lastExternalText.current = draft.prompt;
    onChange(draft.prompt);
  }, [draft.prompt, onChange]);

  const richMessagesSupported = config?.environment.capabilities.groupRichMessages === true;
  const richDraft =
    draft.images.length +
      draft.files.length +
      draft.terminalContexts.length +
      draft.threadContexts.length +
      draft.previewAnnotations.length +
      draft.reviewComments.length >
      0 || draft.interactionMode !== null;
  const richBlockReason =
    purpose === "group-message" && richDraft && !richMessagesSupported
      ? "Update this computer’s Mines CLI to send group attachments, context, or Plan mode. Your draft is saved."
      : null;
  const planModeBlockReason = !richMessagesSupported
    ? "Update this computer’s Mines CLI to use group Plan mode."
    : groupPlanModeBlockReason(draft.prompt, snapshot?.members ?? []);
  const effectiveSendDisabledReason =
    sendDisabledReason ??
    richBlockReason ??
    (draft.interactionMode === "plan" ? planModeBlockReason : null);
  const focus = () => composerRef.current?.focusAtEnd();
  const changePlanMode = (mode: ProviderInteractionMode) => {
    useComposerDraftStore.getState().setInteractionMode(target, mode);
    onPlanModeChange?.(mode === "plan");
  };
  const reportError = (_threadId: unknown, message: string | null) => setError(message);
  const contextIdentity = () => {
    const current = useComposerDraftStore.getState().getComposerDraft(target);
    return JSON.stringify(
      current && {
        prompt: current.prompt,
        interactionMode: current.interactionMode,
        images: current.images.map((file) => file.id),
        files: current.files.map((file) => file.id),
        terminalContexts: current.terminalContexts,
        previewAnnotations: current.previewAnnotations,
        reviewComments: current.reviewComments,
        threadContexts: current.threadContexts,
      },
    );
  };
  const send = async (alternate: boolean) => {
    if (disabled || isSendBusy || inFlight.current || effectiveSendDisabledReason) return;
    const context = composerRef.current?.getSendContext();
    if (!context) return;
    const staged = [...context.images, ...context.files];
    if (
      !context.prompt.trim() &&
      staged.length === 0 &&
      context.terminalContexts.length === 0 &&
      context.threadContexts.length === 0 &&
      context.previewAnnotations.length === 0 &&
      context.reviewComments.length === 0
    )
      return;
    const identity = contextIdentity();
    const content = groupComposerReceiptKey(identity, submissionKey, alternate);
    const requestId = retry.content === content ? retry.requestId : randomUUID();
    setRetry({ content, requestId });
    inFlight.current = true;
    setSending(true);
    setError(null);
    return (async () => {
      const payload = await prepareGroupComposerPayload(environmentId, context);
      const accepted = await onSubmit(alternate, {
        ...payload,
        clientRequestId: requestId,
        ...(draft.interactionMode ? { interactionMode: draft.interactionMode } : {}),
      });
      if (accepted && contextIdentity() === identity) {
        useComposerDraftStore.getState().clearDraftThread(target);
        lastExternalText.current = "";
        onChange("");
        setRetry({ content: "", requestId: randomUUID() });
        onDraftActivity?.("idle");
        focus();
      }
    })()
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Your message could not be sent. Your draft is saved.",
        );
      })
      .finally(() => {
        inFlight.current = false;
        setSending(false);
      });
  };
  const history: ChatMessage[] =
    snapshot?.messages
      .filter(
        (message) =>
          message.kind === "user" &&
          (message.authorFriendId === undefined || message.authorFriendId === authorFriendId),
      )
      .map((message) => ({
        id: MessageId.make(message.id),
        role: "user",
        text: message.text,
        runId: null,
        streaming: false,
        createdAt: message.createdAt,
        updatedAt: message.createdAt,
        ...(message.attachments ? { attachments: message.attachments } : {}),
        ...(message.context ? { context: message.context } : {}),
      })) ?? [];
  const fileLimit = config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null;
  return (
    <>
      <Dialog
        open={workspacePath !== null}
        onOpenChange={(open) => {
          if (!open) setWorkspacePath(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{workspacePath?.split(/[\\/]/).at(-1) ?? "File"}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {workspacePath && config ? (
              <AttachmentFilePreview
                name={workspacePath.split(/[\\/]/).at(-1) ?? workspacePath}
                mimeType="application/octet-stream"
                sizeBytes={0}
                asset={{
                  environmentId,
                  resource: { _tag: "draft-workspace-file", cwd: config.cwd, path: workspacePath },
                }}
                onClose={() => setWorkspacePath(null)}
              />
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      <Dialog open={targetsOpen} onOpenChange={setTargetsOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Group mines</DialogTitle>
            <DialogDescription>
              Each mine keeps its own model, effort, account, and access settings. Open a mine to
              adjust its settings.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-3">
              {snapshot?.members.map((member) => (
                <div key={member.id} className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{member.alias}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {member.modelSelection.model}
                    </p>
                  </div>
                  {onOpenMember && (canOpenMember?.(member) ?? true) ? (
                    <Button size="xs" variant="outline" onClick={() => onOpenMember(member)}>
                      Open mine
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      {preview ? <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} /> : null}
      {error ? (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ChatComposer
            composerDraftTarget={target}
            environmentId={environmentId}
            routeKind="draft"
            routeThreadRef={null}
            groupComposer={{
              controls: (
                <>
                  {purpose === "group-message" ? (
                    <ComposerControl
                      size="sm"
                      onClick={() => setTargetsOpen(true)}
                      data-composer-shortcut="composer.model"
                    >
                      <UsersIcon className="size-4" />
                      {snapshot?.members.length ?? 0} mines
                    </ComposerControl>
                  ) : null}
                  {children}
                  {purpose === "group-message" ? (
                    <ComposerPlanControl
                      active={draft.interactionMode === "plan"}
                      onToggle={() =>
                        changePlanMode(draft.interactionMode === "plan" ? "default" : "plan")
                      }
                      disabled={
                        disabled ||
                        sending ||
                        isSendBusy ||
                        (draft.interactionMode !== "plan" && planModeBlockReason !== null)
                      }
                      {...(planModeBlockReason ? { disabledReason: planModeBlockReason } : {})}
                    />
                  ) : null}
                </>
              ),
              aliases: snapshot?.members.map((member) => member.alias) ?? [],
              supportsPlanMode: purpose === "group-message" && planModeBlockReason === null,
              questionAnswer: purpose === "question-answer",
              literalText,
              onOpenModelPicker: () => setTargetsOpen(true),
              modelPickerOpen: targetsOpen,
              onOpenPath: setWorkspacePath,
            }}
            editorAriaLabel={ariaLabel}
            editorPlaceholder={placeholder}
            {...(onDraftActivity ? { onDraftActivity } : {})}
            {...(onVoiceInputBusyChange ? { onVoiceInputBusyChange } : {})}
            draftId={target}
            canOperateThread={!disabled}
            attachmentUploadsCapabilityKnown={config !== null}
            supportsAttachmentUploads={config?.environment.capabilities.attachmentUploads === true}
            supportsQuestionAttachments={
              purpose === "question-answer" &&
              config?.environment.capabilities.questionAttachments === true
            }
            maxFileAttachmentBytes={fileLimit}
            multipleModelSelections={emptySelections}
            supportsMultipleModels={false}
            onMultipleModelSelectionsChange={noop}
            activeThreadId={null}
            activeThreadEnvironmentId={undefined}
            activeThread={undefined}
            activeThreadShell={null}
            promptHistoryMessages={history}
            isServerThread={false}
            isLocalDraftThread={true}
            forceExpandedOnMobile
            projectSelectionRequired={false}
            phase="ready"
            canInterrupt={false}
            isConnecting={environment?.connection.phase !== "connected"}
            isSendBusy={sending || isSendBusy}
            canResume={false}
            sendDisabledReason={disabled ? "This group is read only." : effectiveSendDisabledReason}
            isPreparingWorktree={false}
            isCompacting={false}
            bannerItems={[]}
            resumeCompactionTokens={null}
            keepFullHistory
            onToggleKeepFullHistory={noop}
            environmentUnavailable={null}
            activePendingApproval={null}
            pendingApprovals={[]}
            pendingUserInputs={[]}
            activePendingProgress={null}
            activePendingResolvedAnswers={null}
            activePendingIsResponding={false}
            activePendingDraftAnswers={{}}
            activePendingQuestionIndex={0}
            respondingRequestIds={[]}
            showPlanFollowUpPrompt={false}
            activeProposedPlan={null}
            threadSyncPhase={null}
            runtimeMode={draft.runtimeMode ?? "full-access"}
            interactionMode={draft.interactionMode ?? "default"}
            lockedProvider={null}
            providerStatuses={[...(config?.providers ?? [])]}
            providerCatalogKnown={config !== null}
            activeProjectDefaultModelSelection={null}
            activeThreadModelSelection={null}
            activeProjectId={null}
            activeContextWindow={null}
            compactThreadUnavailable
            compactDisabled
            compactDisabledReason="Open a member mine to compact its context."
            resolvedTheme={resolvedTheme}
            settings={settings}
            keybindings={keybindings}
            terminalOpen={false}
            gitCwd={config?.cwd ?? null}
            pullRequestProjectId={null}
            pullRequestRepository={null}
            threadPullRequests={undefined}
            restingControlsHost={null}
            restingControlsHaveLeadingContext={false}
            onRestingControlsVisibilityChange={noop}
            getTimelineScrollableNode={getTimelineScrollableNode}
            isTimelineAtLogicalEnd={() => {
              const node = getTimelineScrollableNode();
              return node === null || node.scrollHeight - node.scrollTop - node.clientHeight < 48;
            }}
            timelineOverflows={false}
            onComposerOverlayHeightChange={noop}
            onRestingChange={noop}
            promptRef={promptRef}
            composerImagesRef={imagesRef}
            composerFilesRef={filesRef}
            composerTerminalContextsRef={terminalsRef}
            composerRef={composerRef}
            onPageScrollKeyDown={(key) => {
              const node = getTimelineScrollableNode();
              node?.scrollBy({ top: node.clientHeight * (key === "PageDown" ? 1 : -1) });
            }}
            onPageScrollKeyUp={noop}
            onPageScrollRelease={noop}
            editingQueuedAttachments={null}
            onRemoveEditingQueuedAttachment={noop}
            onCompactContext={noop}
            onPrepareLiveVoiceStart={async () => {
              throw new Error("Choose a member mine for a live voice conversation.");
            }}
            onSend={(event, _dispatch, intent) => {
              event?.preventDefault();
              void send(intent === "alternate");
            }}
            onResume={noop}
            onInterrupt={noop}
            onImplementPlanInNewThread={noop}
            onRespondToApproval={async () => {
              throw new Error("Open the member mine to answer its pending request.");
            }}
            onSelectActivePendingUserInputOption={noop}
            onAdvanceActivePendingUserInput={noop}
            onDismissActivePendingUserInput={noop}
            onPreviousActivePendingUserInputQuestion={noop}
            onChangeActivePendingUserInputCustomAnswer={noop}
            onProviderModelSelect={() =>
              toastManager.add({
                type: "info",
                title: "Choose a mine in the group",
                description: "Each mine keeps its own model and account.",
              })
            }
            onOpenProviderSetup={noop}
            getModelDisabledReason={() => "Each mine keeps its own model and account."}
            toggleInteractionMode={() =>
              changePlanMode(draft.interactionMode === "plan" ? "default" : "plan")
            }
            handleRuntimeModeChange={(mode) =>
              useComposerDraftStore.getState().setRuntimeMode(target, mode)
            }
            handleInteractionModeChange={changePlanMode}
            focusComposer={focus}
            scheduleComposerFocus={focus}
            setThreadError={reportError}
            onExpandImage={setPreview}
            onFileOpen={noop}
          />
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </>
  );
}
