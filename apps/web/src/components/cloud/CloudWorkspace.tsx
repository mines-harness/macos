import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  type CloudDiffResult,
  type CloudTarget,
  type CloudTask,
} from "@t3tools/contracts";
import { CloudIcon, ExternalLinkIcon, LinkIcon, RefreshCwIcon, SendIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import {
  cloudApply,
  cloudDiff,
  cloudFollowUp,
  cloudLink,
  cloudRefresh,
  cloudSnapshot,
  cloudStatus,
  cloudSubmit,
  cloudUnlink,
} from "../../state/cloudTasks";
import { useProjects } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";

const statusLabels: Record<CloudTask["status"], string> = {
  linked: "Linked · progress unknown",
  submitted: "Sent to cloud",
  "submission-unknown": "Check submission with provider",
  running: "Running in cloud",
  completed: "Completed",
  failed: "Stopped or failed",
  unknown: "Progress unavailable",
};

export function CloudWorkspace({
  environmentId: rawEnvironmentId,
  targetId,
}: {
  environmentId: string;
  targetId: string;
}) {
  const environmentId = EnvironmentId.make(rawEnvironmentId);
  const environment = useEnvironment(environmentId);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const snapshot = useEnvironmentQuery(cloudSnapshot({ environmentId, input: {} }));
  const refresh = useAtomCommand(cloudRefresh);
  const link = useAtomCommand(cloudLink);
  const submit = useAtomCommand(cloudSubmit);
  const canSubmit = useAtomValue(cloudSubmit.permissionAtom(environmentId));
  const canLink = useAtomValue(cloudLink.permissionAtom(environmentId));
  const canRefresh = useAtomValue(cloudRefresh.permissionAtom(environmentId));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [providerEnvironmentId, setProviderEnvironmentId] = useState("");
  const [url, setUrl] = useState("");
  const [requestId, setRequestId] = useState(randomUUID);
  const [cursor, setCursor] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = snapshot.data?.targets.find((item) => item.id === targetId);
  const tasks = (snapshot.data?.tasks.filter((task) => task.targetId === targetId) ?? []).toSorted(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  );
  const selected = tasks.find((task) => task.id === selectedId) ?? tasks[0];
  const connected = environment?.connection.phase === "connected";
  const available = connected && target?.bridgeStatus === "available";
  const workspace = cwd || projects[0]?.workspaceRoot || "";

  const loadTasks = async (nextPage = false) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await refresh({
      environmentId,
      input: { targetId, ...(nextPage && cursor ? { cursor } : {}) },
    });
    if (result._tag === "Success") {
      setCursor(result.value.cursor);
      snapshot.refresh();
    } else setError(formatEnvironmentQueryError(result.cause));
    setBusy(false);
  };

  const submitTask = async () => {
    if (busy || !prompt.trim() || !workspace) return;
    setBusy(true);
    setError(null);
    const result = await submit({
      environmentId,
      input: {
        requestId,
        targetId,
        cwd: workspace,
        prompt,
        ...(target?.provider === "codex" ? { environmentId: providerEnvironmentId.trim() } : {}),
      },
    });
    if (result._tag === "Success") {
      setSelectedId(result.value.id);
      setPrompt("");
      setRequestId(randomUUID());
      snapshot.refresh();
    } else setError(formatEnvironmentQueryError(result.cause));
    setBusy(false);
  };

  return (
    <SidebarInset>
      <main className="flex h-dvh min-h-0 flex-1 flex-col bg-background text-foreground">
        <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border px-6">
          <CloudIcon className="size-5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">{target?.label ?? "Cloud device"}</h1>
            <p className="text-xs text-muted-foreground">
              Runs with {target?.provider === "claude" ? "Anthropic" : "OpenAI"} · Controlled
              through {environment?.label ?? "your computer"}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={snapshot.isPending}
            onClick={snapshot.refresh}
            aria-label="Check cloud connection"
          >
            <RefreshCwIcon />
            Check connection
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
          <div className="mx-auto max-w-5xl space-y-7 px-6 py-8">
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full border border-border px-2.5 py-1">
                  Provider cloud
                </span>
                <span className="rounded-full border border-border px-2.5 py-1">
                  {available ? "Computer bridge connected" : "Computer bridge unavailable"}
                </span>
                {target?.cliVersion ? (
                  <span className="text-muted-foreground">CLI {target.cliVersion}</span>
                ) : null}
              </div>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                {connected
                  ? (target?.reason ?? "Checking configured provider accounts…")
                  : "Connect to your computer to send from mines. Existing cloud tasks can keep running; open the provider to continue directly."}
              </p>
              <p className="text-xs text-muted-foreground">
                Full conversations and stop controls are available in the provider app. Saved links
                and summaries appear here.
              </p>
            </section>

            {target ? (
              <section className="grid gap-5 md:grid-cols-2">
                <details className="rounded-xl border border-border p-4" open={tasks.length === 0}>
                  <summary className="cursor-pointer text-sm font-medium">
                    Start a cloud task
                  </summary>
                  <form
                    className="mt-4 space-y-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submitTask();
                    }}
                  >
                    <label className="block space-y-2 text-xs font-medium">
                      Repository on {environment?.label ?? "your computer"}
                      <Input
                        value={workspace}
                        list="cloud-workspaces"
                        onChange={(event) => {
                          setCwd(event.target.value);
                          setRequestId(randomUUID());
                        }}
                        placeholder="/absolute/path/to/project"
                      />
                      <datalist id="cloud-workspaces">
                        {projects.map((project) => (
                          <option key={project.id} value={project.workspaceRoot} />
                        ))}
                      </datalist>
                    </label>
                    {target.provider === "codex" ? (
                      <label className="block space-y-2 text-xs font-medium">
                        Codex cloud environment ID
                        <Input
                          value={providerEnvironmentId}
                          onChange={(event) => {
                            setProviderEnvironmentId(event.target.value);
                            setRequestId(randomUUID());
                          }}
                          placeholder="Choose the ID from codex cloud"
                        />
                        <span className="block font-normal leading-relaxed text-muted-foreground">
                          Choose an environment in the provider first, then paste its ID here.
                        </span>
                      </label>
                    ) : (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        Claude uses this repository and branch. It may upload the local repository
                        and its history when a GitHub clone is unavailable. Review the provider task
                        to confirm its starting branch.
                      </p>
                    )}
                    <Textarea
                      aria-label="Cloud task prompt"
                      value={prompt}
                      onChange={(event) => {
                        setPrompt(event.target.value);
                        setRequestId(randomUUID());
                      }}
                      placeholder="What should this cloud device work on?"
                      rows={4}
                      maxLength={100_000}
                    />
                    <Button
                      type="submit"
                      disabled={
                        busy ||
                        !available ||
                        !canSubmit ||
                        !target.capabilities.submit ||
                        !prompt.trim() ||
                        !workspace ||
                        (target.provider === "codex" && !providerEnvironmentId.trim())
                      }
                    >
                      <SendIcon />
                      {busy ? "Sending…" : "Send to cloud"}
                    </Button>
                  </form>
                </details>
                <details className="rounded-xl border border-border p-4" open={tasks.length === 0}>
                  <summary className="cursor-pointer text-sm font-medium">
                    Link an existing cloud task
                  </summary>
                  <form
                    className="mt-4 space-y-4"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (busy || !url.trim()) return;
                      setBusy(true);
                      setError(null);
                      const result = await link({ environmentId, input: { targetId, url } });
                      if (result._tag === "Success") {
                        setSelectedId(result.value.id);
                        setUrl("");
                        snapshot.refresh();
                      } else setError(formatEnvironmentQueryError(result.cause));
                      setBusy(false);
                    }}
                  >
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Paste a task URL from {target.provider === "codex" ? "ChatGPT" : "Claude"}.
                      Linking keeps the original conversation with its provider.
                    </p>
                    <Input
                      aria-label="Provider task URL"
                      type="url"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder={
                        target.provider === "codex"
                          ? "https://chatgpt.com/codex/tasks/…"
                          : "https://claude.ai/code/session_…"
                      }
                      maxLength={4096}
                    />
                    <Button
                      type="submit"
                      variant="outline"
                      disabled={busy || !connected || !canLink || !url.trim()}
                    >
                      <LinkIcon />
                      Link task
                    </Button>
                  </form>
                </details>
              </section>
            ) : null}

            {error || snapshot.error ? (
              <p role="alert" className="text-sm text-destructive">
                {error ?? snapshot.error}
              </p>
            ) : null}

            <section className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">
                  Cloud tasks{" "}
                  <span className="font-normal text-muted-foreground">{tasks.length}</span>
                </h2>
                {target?.capabilities.list ? (
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || !available || !canRefresh}
                      onClick={() => void loadTasks()}
                    >
                      <RefreshCwIcon />
                      Fetch tasks
                    </Button>
                    {cursor ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || !available || !canRefresh}
                        onClick={() => void loadTasks(true)}
                      >
                        Load more
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {tasks.length === 0 ? (
                <p className="py-6 text-sm text-muted-foreground">
                  No cloud tasks linked yet. Start one or add a provider link above.
                </p>
              ) : (
                <div className="grid gap-6 md:grid-cols-[minmax(180px,280px)_1fr]">
                  <nav aria-label="Cloud tasks" className="space-y-1">
                    {tasks.map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        aria-current={selected?.id === task.id ? "page" : undefined}
                        onClick={() => setSelectedId(task.id)}
                        className="block w-full rounded-lg px-3 py-3 text-left transition-colors duration-150 hover:bg-accent aria-[current=page]:bg-accent motion-reduce:transition-none"
                      >
                        <span className="block truncate text-sm font-medium">{task.title}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {statusLabels[task.status]}
                        </span>
                      </button>
                    ))}
                  </nav>
                  {selected && target ? (
                    <CloudTaskDetail
                      key={selected.id}
                      task={selected}
                      target={target}
                      environmentId={environmentId}
                      available={Boolean(available)}
                      workspace={workspace}
                      onChanged={snapshot.refresh}
                    />
                  ) : null}
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
    </SidebarInset>
  );
}

function CloudTaskDetail({
  task,
  target,
  environmentId,
  available,
  workspace,
  onChanged,
}: {
  task: CloudTask;
  target: CloudTarget;
  environmentId: EnvironmentId;
  available: boolean;
  workspace: string;
  onChanged: () => void;
}) {
  const followUp = useAtomCommand(cloudFollowUp);
  const status = useAtomCommand(cloudStatus);
  const diff = useAtomCommand(cloudDiff);
  const apply = useAtomCommand(cloudApply);
  const unlink = useAtomCommand(cloudUnlink);
  const canFollowUp = useAtomValue(cloudFollowUp.permissionAtom(environmentId));
  const canStatus = useAtomValue(cloudStatus.permissionAtom(environmentId));
  const canDiff = useAtomValue(cloudDiff.permissionAtom(environmentId));
  const canApply = useAtomValue(cloudApply.permissionAtom(environmentId));
  const canUnlink = useAtomValue(cloudUnlink.permissionAtom(environmentId));
  const [message, setMessage] = useState("");
  const [requestId, setRequestId] = useState(randomUUID);
  const [attempt, setAttempt] = useState(1);
  const [review, setReview] = useState<CloudDiffResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const nativeTask = Boolean(task.providerTaskId);

  return (
    <article className="min-w-0 space-y-5 rounded-xl border border-border p-5">
      <div className="space-y-2">
        <h3 className="text-base font-semibold">{task.title}</h3>
        <p className="text-xs text-muted-foreground">{statusLabels[task.status]}</p>
        {task.summary ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
            {task.summary}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {task.url ? (
          <Button
            variant="outline"
            size="sm"
            render={<a href={task.url} target="_blank" rel="noopener noreferrer" />}
          >
            <ExternalLinkIcon />
            Open in {target.provider === "codex" ? "ChatGPT" : "Claude"}
          </Button>
        ) : null}
        {target.capabilities.status && nativeTask ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={!available || !canStatus || busy}
            onClick={async () => {
              setBusy(true);
              setFeedback(null);
              const result = await status({ environmentId, input: { taskId: task.id } });
              if (result._tag === "Success") onChanged();
              else setFeedback(formatEnvironmentQueryError(result.cause));
              setBusy(false);
            }}
          >
            Check progress
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || !canUnlink}
          onClick={async () => {
            setBusy(true);
            const result = await unlink({ environmentId, input: { taskId: task.id } });
            if (result._tag === "Success") onChanged();
            else setFeedback(formatEnvironmentQueryError(result.cause));
            setBusy(false);
          }}
        >
          Remove link
        </Button>
      </div>
      {target.capabilities.followUp && nativeTask ? (
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || !message.trim()) return;
            setBusy(true);
            setFeedback(null);
            const result = await followUp({
              environmentId,
              input: { requestId, taskId: task.id, prompt: message },
            });
            if (result._tag === "Success") {
              setMessage("");
              setRequestId(randomUUID());
              onChanged();
            } else setFeedback(formatEnvironmentQueryError(result.cause));
            setBusy(false);
          }}
        >
          <Textarea
            aria-label="Cloud task follow-up"
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
              setRequestId(randomUUID());
            }}
            placeholder="Send a follow-up to this cloud task…"
            rows={3}
            maxLength={100_000}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Replies stay in Claude. Sending confirms delivery.
            </p>
            <Button
              type="submit"
              size="sm"
              disabled={!available || !canFollowUp || busy || !message.trim()}
            >
              Send follow-up
            </Button>
          </div>
        </form>
      ) : null}
      {target.capabilities.diff && nativeTask ? (
        <details className="space-y-3">
          <summary className="cursor-pointer text-sm font-medium">Review cloud changes</summary>
          <div className="flex items-end gap-3">
            <label className="w-24 space-y-1 text-xs">
              Attempt
              <Input
                type="number"
                min={1}
                max={4}
                value={attempt}
                onChange={(event) => {
                  setAttempt(Math.max(1, Math.min(4, Number(event.target.value) || 1)));
                  setReview(null);
                }}
              />
            </label>
            <Button
              variant="outline"
              size="sm"
              disabled={!available || !canDiff || busy}
              onClick={async () => {
                setBusy(true);
                setFeedback(null);
                const result = await diff({ environmentId, input: { taskId: task.id, attempt } });
                if (result._tag === "Success") setReview(result.value);
                else setFeedback(formatEnvironmentQueryError(result.cause));
                setBusy(false);
              }}
            >
              Load diff
            </Button>
          </div>
          {review ? (
            <>
              <pre className="max-h-96 overflow-auto rounded-lg bg-muted/40 p-3 font-mono text-xs leading-6">
                {review.text || "No diff returned."}
              </pre>
              <p className="text-xs text-muted-foreground">
                Apply attempt {review.attempt} to {workspace || "a repository selected above"}.
                Local changes must be committed or stashed.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={!available || !canApply || busy || !workspace || !review.text}
                onClick={async () => {
                  setBusy(true);
                  setFeedback(null);
                  const result = await apply({
                    environmentId,
                    input: {
                      taskId: task.id,
                      attempt: review.attempt,
                      cwd: workspace,
                      reviewedDigest: review.digest,
                    },
                  });
                  if (result._tag === "Success") {
                    setFeedback("Cloud changes applied to your local repository.");
                    setReview(null);
                  } else setFeedback(formatEnvironmentQueryError(result.cause));
                  setBusy(false);
                }}
              >
                Apply reviewed changes
              </Button>
            </>
          ) : null}
        </details>
      ) : null}
      {feedback ? (
        <p role="status" className="text-sm text-muted-foreground">
          {feedback}
        </p>
      ) : null}
    </article>
  );
}
