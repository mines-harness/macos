import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  GroupRunProjection,
  GroupSnapshot,
  GroupRunRespondInput,
  RuntimeRequestId,
  UserInputAttachments as UserInputAttachmentsType,
} from "@t3tools/contracts";
import { UserInputAttachments } from "@t3tools/contracts";
import type { SharedGroupGetInput } from "@t3tools/contracts/sharedGroups";
import { seedUserInputDraftAnswers } from "@t3tools/client-runtime/state/thread-requests";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useRef, useState } from "react";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import * as Schema from "effect/Schema";
import { randomUUID } from "../../lib/utils";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  projectPendingUserInputAnswer,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { groupRespondToRuntimeRequest } from "../../state/groups";
import { sharedGroupRespondToRuntimeRequest } from "../../state/sharedGroups";
import { ComposerPendingApprovalPanel } from "../chat/ComposerPendingApprovalPanel";
import { ComposerPendingApprovalActions } from "../chat/ComposerPendingApprovalActions";
import { ComposerPendingUserInputPanel } from "../chat/ComposerPendingUserInputPanel";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { GroupMessageComposer, type GroupComposerMessage } from "./GroupMessageComposer";
import { prepareGroupComposerPayload } from "./groupComposerPayload";
import { groupComposerReceiptKey } from "./groupComposerTargets";
import { groupRunRequests } from "./groupRunRequestState";

type Response = Omit<
  GroupRunRespondInput,
  "groupId" | "deliveryId" | "requestId" | "clientRequestId"
>;
type Respond = (requestId: RuntimeRequestId, response: Response) => Promise<boolean>;
const decodeQuestionAttachments = Schema.decodeUnknownSync(UserInputAttachments);

function Approval({
  approval,
  allowed,
  busy,
  respond,
}: {
  approval: PendingApproval;
  allowed: boolean;
  busy: boolean;
  respond: Respond;
}) {
  const [feedback, setFeedback] = useState("");
  return (
    <div className="space-y-3 rounded-xl border border-border p-3">
      <ComposerPendingApprovalPanel approval={approval} pendingCount={1} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ComposerPendingApprovalActions
          requestId={approval.requestId}
          isResponding={busy}
          disabled={!allowed}
          canRespond={allowed && approval.responseCapability === "live"}
          options={approval.options}
          onRespondToApproval={(requestId, decision) => respond(requestId, { decision })}
        />
      </div>
      {approval.supportsFeedback && allowed ? (
        <div className="space-y-2">
          <Textarea
            size="sm"
            aria-label="Feedback for this approval"
            value={feedback}
            disabled={busy}
            onChange={(event) => setFeedback(event.currentTarget.value)}
          />
          <div className="flex justify-end">
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !feedback.trim()}
              onClick={() => void respond(approval.requestId, { decision: "decline", feedback })}
            >
              Send feedback
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Question({
  environmentId,
  projection,
  prompt,
  allowed,
  busy,
  respond,
}: {
  environmentId: EnvironmentId;
  projection: GroupRunProjection;
  prompt: PendingUserInput;
  allowed: boolean;
  busy: boolean;
  respond: Respond;
}) {
  const [storedAnswers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [attachmentsByQuestionId, setAttachments] = useState<UserInputAttachmentsType>({});
  const [preparing, setPreparing] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composerRef = useRef<ChatComposerHandle>(null);
  const answering = useRef(false);
  const answers = seedUserInputDraftAnswers(prompt.questions, storedAnswers);
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const question = progress.activeQuestion;
  const disabled = !allowed || busy || preparing || voiceBusy;
  const advance = async (submitted?: GroupComposerMessage) => {
    if (disabled || answering.current || !question) return false;
    if (composerRef.current?.hasPendingAttachments()) {
      setError("Wait for the answer’s attachments to finish preparing.");
      return false;
    }
    answering.current = true;
    setPreparing(true);
    setError(null);
    return (async () => {
      const draft = composerRef.current?.getSendContext();
      const payload =
        submitted ?? (draft ? await prepareGroupComposerPayload(environmentId, draft) : null);
      const customText = payload
        ? projectPendingUserInputAnswer(payload.message, draft?.threadContexts ?? [])
        : progress.customAnswer;
      const nextAttachments = payload
        ? decodeQuestionAttachments({
            ...attachmentsByQuestionId,
            [question.id]: payload.attachments ?? [],
          })
        : attachmentsByQuestionId;
      const nextAnswers = payload
        ? {
            ...answers,
            [question.id]: {
              ...setPendingUserInputCustomAnswer(
                answers[question.id],
                typeof customText === "string" ? customText : payload.message,
                question,
              ),
              attachmentCount: nextAttachments[question.id]?.length ?? 0,
            },
          }
        : answers;
      setAnswers(nextAnswers);
      setAttachments(nextAttachments);
      const nextProgress = derivePendingUserInputProgress(
        prompt.questions,
        nextAnswers,
        questionIndex,
      );
      if (!nextProgress.canAdvance) return false;
      if (!nextProgress.isLastQuestion) {
        setQuestionIndex(nextProgress.questionIndex + 1);
        return false;
      }
      const resolved = buildPendingUserInputAnswers(prompt.questions, nextAnswers);
      if (!resolved) return false;
      return await respond(prompt.requestId, {
        answers: resolved,
        ...(Object.keys(nextAttachments).length
          ? { attachmentsByQuestionId: nextAttachments }
          : {}),
      });
    })()
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "The answer could not be prepared.");
        return false;
      })
      .finally(() => {
        answering.current = false;
        setPreparing(false);
      });
  };
  return (
    <div
      className="space-y-3 rounded-xl border border-border p-3"
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setFocused(false);
      }}
    >
      <BackgroundThreadContext value={!focused}>
        <ComposerPendingUserInputPanel
          pendingUserInputs={[{ ...prompt, dismissible: prompt.dismissible && allowed }]}
          cwd={undefined}
          threadRef={{ environmentId: projection.environmentId, threadId: projection.threadId }}
          disabled={disabled}
          respondingRequestIds={busy ? [prompt.requestId] : []}
          answers={answers}
          questionIndex={progress.questionIndex}
          onToggleOption={(id, value) => {
            const selected = prompt.questions.find((candidate) => candidate.id === id);
            if (!disabled && selected)
              setAnswers((current) => ({
                ...current,
                [id]: togglePendingUserInputOptionSelection(selected, current[id], value),
              }));
          }}
          onAdvance={() => void advance()}
          onDismiss={(requestId) => {
            if (!disabled && prompt.dismissible) void respond(requestId, { dismiss: true });
          }}
        />
        {question?.allowCustomAnswer !== false && allowed ? (
          <GroupMessageComposer
            key={question?.id}
            environmentId={environmentId}
            draftKey={JSON.stringify([
              "group-runtime-question",
              projection.deliveryId,
              prompt.requestId,
              question?.id,
            ])}
            purpose="question-answer"
            literalText={question?.initialAnswer !== undefined}
            value={progress.customAnswer}
            onChange={(text) => {
              if (question)
                setAnswers((current) => ({
                  ...current,
                  [question.id]: setPendingUserInputCustomAnswer(
                    current[question.id],
                    text,
                    question,
                  ),
                }));
            }}
            onSubmit={(_alternate, message) => advance(message)}
            ariaLabel="Answer this question"
            placeholder="Type your answer…"
            disabled={!allowed || busy}
            isSendBusy={preparing}
            editorRef={composerRef}
            onVoiceInputBusyChange={setVoiceBusy}
          >
            <span className="text-xs text-muted-foreground">
              Answer {progress.questionIndex + 1} of {prompt.questions.length}
            </span>
          </GroupMessageComposer>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={disabled || progress.questionIndex === 0}
            onClick={() => setQuestionIndex((index) => Math.max(0, index - 1))}
          >
            Previous
          </Button>
          <Button
            size="xs"
            disabled={disabled || !progress.canAdvance}
            onClick={() => void advance()}
          >
            {progress.isLastQuestion ? "Submit answers" : "Next question"}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </BackgroundThreadContext>
    </div>
  );
}

function RunRequests({
  environmentId,
  snapshot,
  projection,
  sharedAddress,
}: {
  environmentId: EnvironmentId;
  snapshot: GroupSnapshot;
  projection: GroupRunProjection;
  sharedAddress?: SharedGroupGetInput;
}) {
  const privateRespond = useAtomCommand(groupRespondToRuntimeRequest, { reportFailure: false });
  const sharedRespond = useAtomCommand(sharedGroupRespondToRuntimeRequest, {
    reportFailure: false,
  });
  const permission = useAtomValue(
    (sharedAddress
      ? sharedGroupRespondToRuntimeRequest
      : groupRespondToRuntimeRequest
    ).permissionAtom(environmentId),
  );
  const requests = groupRunRequests(projection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const receipt = useRef<{ fingerprint: string; id: string } | null>(null);
  const inFlight = useRef(false);
  const allowed = projection.canRespond === true && permission;
  const respond: Respond = async (requestId, response) => {
    if (!allowed || !requests.canRespond(requestId) || inFlight.current) return false;
    const fingerprint = groupComposerReceiptKey(
      JSON.stringify([projection.deliveryId, requestId, response]),
      "runtime-response",
      false,
    );
    const clientRequestId =
      receipt.current?.fingerprint === fingerprint ? receipt.current.id : randomUUID();
    receipt.current = { fingerprint, id: clientRequestId };
    inFlight.current = true;
    setBusy(true);
    setError(null);
    return (async () => {
      const fields = { deliveryId: projection.deliveryId, requestId, clientRequestId, ...response };
      const result = sharedAddress
        ? await sharedRespond({ environmentId, input: { ...sharedAddress, ...fields } })
        : await privateRespond({ environmentId, input: { groupId: snapshot.group.id, ...fields } });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "This request could not be answered.");
        return false;
      }
      return true;
    })()
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "This request could not be answered.");
        return false;
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };
  if (requests.approvals.length + requests.userInputs.length + requests.incomplete.length === 0)
    return null;
  const alias =
    snapshot.members.find((member) => member.id === projection.memberId)?.alias ??
    snapshot.rounds
      .flatMap((round) => round.members)
      .find((member) => member.id === projection.memberId)?.alias ??
    "Mine";
  return (
    <section className="chat-content-lane space-y-3 py-3" aria-label={`Requests from ${alias}`}>
      <p className="text-xs font-medium text-muted-foreground">{alias} is waiting for a response</p>
      {!allowed ? (
        <p className="text-xs text-muted-foreground">
          The mine’s owner can respond to these requests.
        </p>
      ) : null}
      {requests.incomplete.length ? (
        <p className="text-xs text-muted-foreground">
          Load the complete request details above before responding.
        </p>
      ) : null}
      {requests.approvals.map((approval) => (
        <Approval
          key={approval.requestId}
          approval={approval}
          allowed={allowed && requests.canRespond(approval.requestId)}
          busy={busy}
          respond={respond}
        />
      ))}
      {requests.userInputs.map((prompt) => (
        <Question
          key={prompt.requestId}
          environmentId={environmentId}
          projection={projection}
          prompt={prompt}
          allowed={allowed && requests.canRespond(prompt.requestId)}
          busy={busy}
          respond={respond}
        />
      ))}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function GroupRunRequests({
  environmentId,
  snapshot,
  sharedAddress,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: GroupSnapshot;
  readonly sharedAddress?: SharedGroupGetInput;
}) {
  return snapshot.runProjections?.map((projection) => (
    <RunRequests
      key={`${projection.deliveryId}:${projection.runId}`}
      environmentId={environmentId}
      snapshot={snapshot}
      projection={projection}
      {...(sharedAddress ? { sharedAddress } : {})}
    />
  ));
}
