import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, Trash2Icon } from "lucide-react";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  RuntimeMode,
  type ModelSelection,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  type ComposerThreadTarget,
  composerTargetKey,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useProjects, useQuietThreadShell } from "../../state/entities";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { groupCreate, groupLaunchThread, groupSend } from "../../state/groups";
import { readGroupHostRoutes } from "../../state/groupHostRoutes";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
} from "../../providerInstances";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
  useLocalStorage,
} from "../../hooks/useLocalStorage";
import { buildMessageContext } from "../../lib/composerContextRecords";
import { newThreadId, randomUUID } from "../../lib/utils";
import { withMessageContext } from "../ChatView.logic";
import { GROUP_WORKFLOWS } from "../groups/GroupWorkspace";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { ComposerDevicePicker } from "./ComposerDevicePicker";
import { composerDeviceLabel } from "./composerDeviceLabel";
import { draftSendState } from "./chatViewSend";
import { draftWorkflowAtom, workflowLauncherHandlerAtom } from "./WorkflowPicker";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  WorkflowLaunchReceipt,
  WorkflowTargetDraft,
  retargetWorkflowDevice,
  workflowLaunchKey,
  type WorkflowTarget,
} from "./workflowTargets";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";

export function RetainedWorkflowLauncher({
  environmentId,
  composerTarget,
  routeThreadKey,
  selections,
  runtimeMode,
  interactionMode,
  size,
  disabled,
}: {
  environmentId: EnvironmentId;
  composerTarget: ComposerThreadTarget;
  routeThreadKey: string;
  selections: ReadonlyArray<ModelSelection>;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  size: "sm" | "xs";
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { environments } = useEnvironments();
  const providers = useEnvironmentProviders();
  const projects = useProjects();
  const sourceThread = useQuietThreadShell(
    typeof composerTarget === "string" ? null : composerTarget,
  );
  const targetKey = composerTargetKey(composerTarget);
  const navigate = useNavigate();
  const launch = useOrchestrationCommand(groupLaunchThread, { reportFailure: false });
  const create = useOrchestrationCommand(groupCreate, { reportFailure: false });
  const send = useOrchestrationCommand(groupSend, { reportFailure: false });
  const readRoutes = useOrchestrationCommand(readGroupHostRoutes, { reportFailure: false });
  const draftKey = `mines:workflow-targets:${targetKey}`;
  const receiptKey = `mines:workflow-launch:${targetKey}`;
  const [emptyDraft] = useState<typeof WorkflowTargetDraft.Type>(() => ({
    workflow: "team",
    targets: [],
    leadId: "",
  }));
  const [draft, setDraft] = useLocalStorage(draftKey, emptyDraft, WorkflowTargetDraft);
  const persistDraft = (next: typeof WorkflowTargetDraft.Type) => {
    setLocalStorageItem(draftKey, next, WorkflowTargetDraft);
    setDraft(next);
  };
  const makeTarget = (selection: ModelSelection | null, index: number): WorkflowTarget => {
    const session =
      typeof composerTarget === "string"
        ? useComposerDraftStore.getState().getDraftSession(composerTarget)
        : null;
    return {
      id: randomUUID(),
      environmentId,
      projectId: session?.projectId ?? sourceThread?.projectId ?? null,
      selection,
      branch: session?.branch ?? sourceThread?.branch ?? "HEAD",
      startFromOrigin: session?.startFromOrigin ?? false,
      runtimeMode,
      interactionMode,
      alias: `member-${index + 1}`,
      role: "",
    };
  };
  const edit = (id: string, changes: Partial<WorkflowTarget>) =>
    persistDraft({
      ...draft,
      targets: draft.targets.map((target) =>
        target.id === id ? { ...target, ...changes } : target,
      ),
    });
  const openLauncher = () => {
    setError(null);
    if (draft.targets.length === 0) {
      const targets = selections.map(makeTarget);
      persistDraft({
        ...draft,
        workflow: appAtomRegistry.get(draftWorkflowAtom(routeThreadKey)),
        targets,
        leadId: targets[0]?.id ?? "",
      });
    }
    setOpen(true);
  };
  useEffect(() => {
    const atom = workflowLauncherHandlerAtom(routeThreadKey);
    const handler = { open: openLauncher };
    appAtomRegistry.set(atom, handler);
    return () => {
      if (appAtomRegistry.get(atom) === handler) appAtomRegistry.set(atom, null);
    };
  }, [routeThreadKey, openLauncher]);
  const launchWorkflow = async () => {
    const sending = draftSendState(routeThreadKey).sendInFlight;
    if (busy || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const original = useComposerDraftStore.getState().getComposerDraft(composerTarget);
      if (!original?.prompt.trim()) throw new Error("Write your message in the composer first.");
      if (original.images.length || original.files.length || original.persistedAttachments.length)
        throw new Error(
          "Multi-device workflows currently accept text and workspace references. Remove attachments before launching.",
        );
      if (draft.targets.length < 2 || draft.targets.length > 12)
        throw new Error("Choose between 2 and 12 participants.");
      const aliases = draft.targets.map((target) => target.alias.trim().toLowerCase());
      if (
        aliases.some((alias) => !/^[a-z][a-z0-9_-]{0,31}$/.test(alias) || alias === "everyone") ||
        new Set(aliases).size !== aliases.length
      )
        throw new Error(
          "Give each participant a unique @name: start with a letter and use up to 32 letters, numbers, hyphens or underscores.",
        );
      const selectedProjects = draft.targets.map((target) => {
        const host = environments.find((entry) => entry.environmentId === target.environmentId);
        if (host?.connection.phase !== "connected")
          throw new Error(`${host ? composerDeviceLabel(host) : "A selected device"} is offline.`);
        const project = projects.find(
          (entry) => entry.environmentId === target.environmentId && entry.id === target.projectId,
        );
        if (!project) throw new Error(`Choose a workspace for @${target.alias}.`);
        const account = deriveProviderInstanceEntries(
          providers.get(target.environmentId) ?? [],
        ).find((entry) => entry.instanceId === target.selection?.instanceId);
        if (
          !account ||
          !isProviderInstancePickerReady(account) ||
          !account.models.some((model) => model.slug === target.selection?.model)
        )
          throw new Error(`Choose an available account and model for @${target.alias}.`);
        if (!target.branch.trim()) throw new Error(`Choose a Git base ref for @${target.alias}.`);
        return project;
      });
      const message = withMessageContext({
        text: original.prompt,
        context: buildMessageContext(original),
        supportsInlineMessageContext: false,
      }).text;
      if (message.length > 120_000)
        throw new Error("The message and selected context exceed 120,000 characters.");
      const remoteHosts = [...new Set(draft.targets.map((target) => target.environmentId))].filter(
        (host) => host !== environmentId,
      );
      setProgress("Checking direct device connections…");
      if (remoteHosts.length) {
        const coordinatorRoutes = await readRoutes({ environmentId, input: {} });
        if (coordinatorRoutes._tag === "Failure") throw squashAtomCommandFailure(coordinatorRoutes);
        for (const host of remoteHosts) {
          if (!coordinatorRoutes.value.routes.some((route) => route.environmentId === host))
            throw new Error(
              "Connect each participant device from Settings → Devices → Group hosts before launching.",
            );
          const returnRoutes = await readRoutes({ environmentId: host, input: {} });
          if (returnRoutes._tag === "Failure") throw squashAtomCommandFailure(returnRoutes);
          if (!returnRoutes.value.routes.some((route) => route.environmentId === environmentId))
            throw new Error(
              "Connect the coordinator on each participant device too, so replies and invitations can return directly.",
            );
        }
      }
      const key = workflowLaunchKey({
        coordinator: environmentId,
        message,
        draft,
        workspaceRoots: selectedProjects.map((project) => project.workspaceRoot),
      });
      let receipt = getLocalStorageItem(receiptKey, WorkflowLaunchReceipt);
      if (!receipt || receipt.key !== key) {
        receipt = {
          key,
          requestId: randomUUID(),
          launches: draft.targets.map((target) => ({
            targetId: target.id,
            threadId: newThreadId(),
            commandId: CommandId.make(randomUUID()),
          })),
        };
        // Persist every native id before the first request so a lost response or restart cannot duplicate a launch.
        setLocalStorageItem(receiptKey, receipt, WorkflowLaunchReceipt);
      }
      const title = deriveThreadTitleSeed({ text: original.prompt, attachments: [] });
      const members = [];
      for (const [index, target] of draft.targets.entries()) {
        const native = receipt.launches.find((entry) => entry.targetId === target.id);
        if (!native || !target.selection || !target.projectId)
          throw new Error("The saved workflow target is incomplete.");
        setProgress(`Preparing @${target.alias} (${index + 1}/${draft.targets.length})…`);
        const result = await launch({
          environmentId: target.environmentId,
          input: {
            commandId: native.commandId,
            threadId: native.threadId,
            projectId: target.projectId,
            title: `${title} · ${target.alias}`,
            modelSelection: target.selection,
            runtimeMode: target.runtimeMode,
            interactionMode: target.interactionMode,
            workspaceStrategy: {
              type: "worktree",
              baseRef: target.branch.trim(),
              ...(target.startFromOrigin ? { startFromOrigin: true } : {}),
            },
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        members.push({
          environmentId: target.environmentId,
          threadId: result.value.threadId,
          alias: target.alias.trim(),
          ...(target.role.trim() ? { role: target.role.trim() } : {}),
        });
      }
      const leadIndex = Math.max(
        0,
        draft.targets.findIndex((target) => target.id === draft.leadId),
      );
      const lead = members[leadIndex];
      setProgress("Creating your group…");
      const created = await create({
        environmentId,
        input: {
          name: title.slice(0, 120),
          workflow: draft.workflow,
          members,
          clientRequestId: receipt.requestId,
          ...(lead ? { leadThreadId: lead.threadId, leadEnvironmentId: lead.environmentId } : {}),
        },
      });
      if (created._tag === "Failure") throw squashAtomCommandFailure(created);
      const sent = await send({
        environmentId,
        input: { groupId: created.value.group.id, message, clientRequestId: receipt.requestId },
      });
      if (sent._tag === "Failure") throw squashAtomCommandFailure(sent);
      if (useComposerDraftStore.getState().getComposerDraft(composerTarget) === original)
        useComposerDraftStore.getState().clearComposerContent(composerTarget);
      removeLocalStorageItem(receiptKey);
      setOpen(false);
      const openGroup = () =>
        navigate({
          to: "/$environmentId/groups/$groupId",
          params: { environmentId, groupId: created.value.group.id },
        });
      if (mounted.current) await openGroup();
      else
        toastManager.add({
          type: "success",
          title: "Your group is ready",
          actionProps: { children: "Open group", onClick: () => void openGroup() },
        });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sending.current = false;
      setBusy(false);
      setProgress("");
    }
  };
  return (
    <>
      <ComposerDevicePicker
        environmentId={environmentId}
        size={size}
        disabled={disabled || busy}
        onConfigureWorkflow={openLauncher}
      />
      {/* eslint-disable-next-line mines/no-low-value-comments -- User requested retaining this control in comments. */}
      {/* <ComposerControl
        size={size}
        disabled={disabled || busy}
        onClick={openLauncher}
        aria-label="Choose models and devices"
      >
        <UsersIcon aria-hidden="true" />
        <span data-composer-control-label className="@max-[400px]/composer-surface:hidden">
          Models &amp; devices{draft.targets.length ? ` · ${draft.targets.length}` : ""}
        </span>
      </ComposerControl> */}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogPopup className="max-w-2xl">
          <DialogTitle>Run a workflow across devices</DialogTitle>
          <DialogDescription>
            Choose a device, account and model for each participant. They receive your composer
            message and selected references in separate mines and Git worktrees.
          </DialogDescription>
          <div className="max-h-[65dvh] space-y-4 overflow-y-auto py-4">
            <label className="block space-y-1 text-sm">
              Workflow
              <select
                className={selectClass}
                value={draft.workflow}
                disabled={busy}
                onChange={(event) =>
                  persistDraft({ ...draft, workflow: event.target.value as typeof draft.workflow })
                }
              >
                {GROUP_WORKFLOWS.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.label} · {workflow.description}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-sm text-muted-foreground">
              {draft.workflow === "compare"
                ? "Compare sends the same prompt to independent mines in separate worktrees."
                : GROUP_WORKFLOWS.find((workflow) => workflow.id === draft.workflow)?.description}
            </p>
            {draft.targets.map((target, index) => {
              const accounts = deriveProviderInstanceEntries(
                providers.get(target.environmentId) ?? [],
              );
              const account = accounts.find(
                (entry) => entry.instanceId === target.selection?.instanceId,
              );
              const models = account?.models ?? [];
              const model = models.find((entry) => entry.slug === target.selection?.model);
              return (
                <fieldset
                  aria-label={`Workflow target ${index + 1}`}
                  key={target.id}
                  disabled={busy}
                  className="space-y-3 rounded-xl border border-border p-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <Input
                        aria-label={`Participant ${index + 1} name`}
                        value={target.alias}
                        maxLength={32}
                        onChange={(event) => edit(target.id, { alias: event.target.value })}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${target.alias}`}
                      onClick={() =>
                        persistDraft({
                          ...draft,
                          targets: draft.targets.filter((entry) => entry.id !== target.id),
                          leadId:
                            draft.leadId === target.id
                              ? (draft.targets.find((entry) => entry.id !== target.id)?.id ?? "")
                              : draft.leadId,
                        })
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-xs">
                      Device
                      <select
                        className={selectClass}
                        value={target.environmentId}
                        onChange={(event) =>
                          edit(
                            target.id,
                            retargetWorkflowDevice(target, EnvironmentId.make(event.target.value)),
                          )
                        }
                      >
                        {environments.map((host) => (
                          <option
                            key={host.environmentId}
                            value={host.environmentId}
                            disabled={host.connection.phase !== "connected"}
                          >
                            {composerDeviceLabel(host)}
                            {host.connection.phase !== "connected" ? " · offline" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1 text-xs">
                      Workspace
                      <select
                        className={selectClass}
                        value={target.projectId ?? ""}
                        onChange={(event) =>
                          edit(target.id, {
                            projectId: event.target.value
                              ? ProjectId.make(event.target.value)
                              : null,
                          })
                        }
                      >
                        <option value="">Choose a workspace</option>
                        {projects
                          .filter((project) => project.environmentId === target.environmentId)
                          .map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.title}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="space-y-1 text-xs">
                      Account
                      <select
                        className={selectClass}
                        value={account?.instanceId ?? ""}
                        onChange={(event) => {
                          const next = accounts.find(
                            (entry) => entry.instanceId === event.target.value,
                          );
                          const nextModel =
                            next?.models.find((entry) => entry.isDefault) ?? next?.models[0];
                          edit(target.id, {
                            selection:
                              next && nextModel
                                ? { instanceId: next.instanceId, model: nextModel.slug }
                                : null,
                          });
                        }}
                      >
                        <option value="">Choose an account</option>
                        {accounts.map((entry) => (
                          <option
                            key={entry.instanceId}
                            value={entry.instanceId}
                            disabled={!isProviderInstancePickerReady(entry)}
                          >
                            {entry.displayName}
                            {!isProviderInstancePickerReady(entry) ? " · unavailable" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1 text-xs">
                      Model
                      <select
                        className={selectClass}
                        value={target.selection?.model ?? ""}
                        onChange={(event) => {
                          if (account)
                            edit(target.id, {
                              selection: {
                                instanceId: account.instanceId,
                                model: event.target.value,
                              },
                            });
                        }}
                      >
                        <option value="">Choose a model</option>
                        {models.map((entry) => (
                          <option key={entry.slug} value={entry.slug}>
                            {entry.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1 text-xs">
                      Git base ref
                      <Input
                        value={target.branch}
                        placeholder="HEAD"
                        onChange={(event) => edit(target.id, { branch: event.target.value })}
                      />
                    </label>
                    <label className="space-y-1 text-xs">
                      Permissions
                      <select
                        className={selectClass}
                        value={target.runtimeMode}
                        onChange={(event) =>
                          edit(target.id, { runtimeMode: event.target.value as RuntimeMode })
                        }
                      >
                        <option value="approval-required">Ask for approval</option>
                        <option value="auto-accept-edits">Accept edits</option>
                        <option value="auto">Auto</option>
                        <option value="full-access">Full access</option>
                      </select>
                    </label>
                    {model?.capabilities?.optionDescriptors?.map((option) => {
                      const value =
                        target.selection?.options?.find((item) => item.id === option.id)?.value ??
                        option.currentValue;
                      const setOption = (value: string | boolean) => {
                        if (target.selection)
                          edit(target.id, {
                            selection: {
                              ...target.selection,
                              options: [
                                ...(target.selection.options ?? []).filter(
                                  (item) => item.id !== option.id,
                                ),
                                { id: option.id, value },
                              ],
                            },
                          });
                      };
                      return (
                        <label key={option.id} className="space-y-1 text-xs">
                          {option.label}
                          {option.type === "boolean" ? (
                            <input
                              className="ms-2"
                              type="checkbox"
                              checked={value === true}
                              onChange={(event) => setOption(event.target.checked)}
                            />
                          ) : (
                            <select
                              className={selectClass}
                              value={typeof value === "string" ? value : ""}
                              onChange={(event) => setOption(event.target.value)}
                            >
                              <option value="" disabled>
                                Provider default
                              </option>
                              {option.options.map((choice) => (
                                <option key={choice.id} value={choice.id}>
                                  {choice.label}
                                </option>
                              ))}
                            </select>
                          )}
                        </label>
                      );
                    })}
                  </div>
                  <Input
                    aria-label={`Role for ${target.alias}`}
                    placeholder="Role or specialty (optional)"
                    value={target.role}
                    maxLength={500}
                    onChange={(event) => edit(target.id, { role: event.target.value })}
                  />
                  <div className="flex flex-wrap gap-4 text-xs">
                    <label>
                      <input
                        type="checkbox"
                        checked={target.interactionMode === "plan"}
                        onChange={(event) =>
                          edit(target.id, {
                            interactionMode: event.target.checked ? "plan" : "default",
                          })
                        }
                      />{" "}
                      Plan mode
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={target.startFromOrigin}
                        onChange={(event) =>
                          edit(target.id, { startFromOrigin: event.target.checked })
                        }
                      />{" "}
                      Start from origin
                    </label>
                    {draft.workflow === "council" || draft.workflow === "build-review" ? (
                      <label>
                        <input
                          type="radio"
                          name={`workflow-lead-${targetKey}`}
                          checked={draft.leadId === target.id}
                          onChange={() => persistDraft({ ...draft, leadId: target.id })}
                        />{" "}
                        {draft.workflow === "build-review" ? "Builder" : "Lead"}
                      </label>
                    ) : null}
                  </div>
                </fieldset>
              );
            })}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy || draft.targets.length >= 12}
                onClick={() => {
                  const target = makeTarget(selections[0] ?? null, draft.targets.length);
                  persistDraft({
                    ...draft,
                    targets: [...draft.targets, target],
                    leadId: draft.leadId || target.id,
                  });
                }}
              >
                <PlusIcon />
                Add participant
              </Button>
              <Button
                variant="ghost"
                disabled={busy || draft.targets.length + selections.length > 12}
                onClick={() => {
                  const targets = selections.map((selection, index) =>
                    makeTarget(selection, draft.targets.length + index),
                  );
                  persistDraft({
                    ...draft,
                    targets: [...draft.targets, ...targets],
                    leadId: draft.leadId || targets[0]?.id || "",
                  });
                }}
              >
                Add selected models
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The coordinator stays on{" "}
              {composerDeviceLabel(
                environments.find((host) => host.environmentId === environmentId),
              )}
              . Other devices need a direct group-host connection in both directions. Cloud task
              devices remain in their dedicated workspaces until they support full conversations.
            </p>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <div className="flex items-center justify-between gap-3">
            <p aria-live="polite" className="text-xs text-muted-foreground">
              {busy ? progress : "Uses the message currently in your composer."}
            </p>
            <Button
              disabled={busy || draft.targets.length < 2}
              onClick={() => void launchWorkflow()}
            >
              {busy ? "Preparing…" : "Launch workflow"}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
