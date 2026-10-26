import type { AgentSessionProjectCandidate } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import {
  groupImportSections,
  importThreadScope,
  type ImportThreadNode,
  type ImportSelection,
  type ImportSelectionChange,
} from "../../onboarding/projectImport.logic";
import { importSourceLabel } from "../../onboarding/importIssues.logic";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ImportProjectPreview<
  T extends AgentSessionProjectCandidate & { readonly key: string },
>({
  candidates,
  selection,
  onSelectionChange,
}: {
  candidates: readonly T[];
  selection: ImportSelection;
  onSelectionChange: (changes: readonly ImportSelectionChange[]) => void;
}) {
  const selected = (candidate: T) => ({
    checked: selection.projects.has(candidate.key),
    indeterminate: selection.threads.has(candidate.key),
  });
  const stateFor = (nodes: readonly ImportThreadNode<T>[]) => {
    let total = 0;
    let count = 0;
    for (const [key, keys] of importThreadScope(nodes)) {
      total += keys.length;
      if (selection.projects.has(key))
        count += keys.filter((id) => selection.threads.get(key)?.has(id) ?? true).length;
    }
    return { checked: total > 0 && count === total, indeterminate: count > 0 && count < total };
  };
  const changesFor = (
    nodes: readonly ImportThreadNode<T>[],
    checked: boolean,
  ): ImportSelectionChange[] =>
    [...importThreadScope(nodes)].map(([projectKey, threadKeys]) => ({
      projectKey,
      threadKeys,
      checked,
    }));
  const renderThread = (node: ImportThreadNode<T>, depth: number): React.ReactNode => {
    const { thread, candidate } = node;
    const label = thread.kind === "subagent" ? (thread.agentName ?? "Subagent") : thread.title;
    return (
      <Collapsible key={thread.key} defaultOpen={node.children.length > 0}>
        <div
          className="flex items-center gap-2.5 rounded-md py-1.5 pr-2 hover:bg-muted/40"
          style={{ paddingLeft: 8 + depth * 20 }}
        >
          <Checkbox
            aria-label={
              thread.kind === "subagent"
                ? `Import subagent ${label}`
                : `Import mine ${thread.title}`
            }
            {...stateFor([node])}
            onCheckedChange={(checked) => onSelectionChange(changesFor([node], checked === true))}
          />
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs">
            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground group-data-panel-open:rotate-90" />
            <span className="truncate">{label}</span>
            {thread.kind === "subagent" ? (
              <span className="text-2xs text-muted-foreground">Subagent</span>
            ) : node.children.length ? (
              <span className="ml-auto text-2xs text-muted-foreground">
                {node.children.length} subagents
              </span>
            ) : null}
          </CollapsibleTrigger>
        </div>
        <CollapsiblePanel>
          <p
            className="py-1 pr-2 text-2xs text-muted-foreground [overflow-wrap:anywhere]"
            style={{ paddingLeft: 28 + depth * 20 }}
          >
            {importSourceLabel(thread.source)}
            {thread.lastActiveAt ? ` · ${new Date(thread.lastActiveAt).toLocaleString()}` : ""}
            <span className="block font-mono">
              Workspace: {candidate.sourceWorkspaceRoot ?? candidate.path}
            </span>
          </p>
          {node.children.map((child) => renderThread(child, depth + 1))}
        </CollapsiblePanel>
      </Collapsible>
    );
  };
  return groupImportSections(candidates).map((group) => {
    const states = [
      ...group.projects.map((view) =>
        view.nodes ? stateFor(view.nodes) : selected(view.candidate),
      ),
      ...group.threads.map((node) => stateFor([node])),
    ];
    const checked = states.every((state) => state.checked);
    const any = states.some((state) => state.checked || state.indeterminate);
    const entries = (
      <>
        {group.projects.map((view) => (
          <Collapsible key={`${view.candidate.key}:${view.sourceProjectId ?? "legacy"}`}>
            <div className="flex items-center gap-2.5 rounded-md py-1.5 pr-2 pl-7 hover:bg-muted/40">
              <Checkbox
                aria-label={`Import project ${view.title}`}
                {...(view.nodes ? stateFor(view.nodes) : selected(view.candidate))}
                onCheckedChange={(value) =>
                  onSelectionChange(
                    view.nodes
                      ? changesFor(view.nodes, value === true)
                      : [{ projectKey: view.candidate.key, checked: value === true }],
                  )
                }
              />
              <CollapsibleTrigger
                aria-label={`Show mines in ${view.title}`}
                className="group flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground group-data-panel-open:rotate-90" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{view.title}</span>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="block truncate font-mono text-2xs text-muted-foreground" />
                      }
                    >
                      {view.candidate.sourceWorkspaceRoot ?? view.candidate.path}
                    </TooltipTrigger>
                    <TooltipPopup variant="code">
                      {view.candidate.sourceWorkspaceRoot ?? view.candidate.path}
                    </TooltipPopup>
                  </Tooltip>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {view.nodes?.length ?? view.candidate.threadCount} conversations
                </span>
              </CollapsibleTrigger>
            </div>
            <CollapsiblePanel>
              {view.nodes === undefined ? (
                <p className="py-2 pr-2 pl-12 text-xs text-muted-foreground">
                  This computer does not provide a conversation preview. Import includes all
                  retained history in this project.
                </p>
              ) : view.nodes.length === 0 ? (
                <p className="py-2 pr-2 pl-12 text-xs text-muted-foreground">
                  No readable conversations found.
                </p>
              ) : (
                view.nodes.map((node) => renderThread(node, 2))
              )}
            </CollapsiblePanel>
          </Collapsible>
        ))}
        {group.threads.map((node) => renderThread(node, group.sourceSection ? 1 : 0))}
      </>
    );
    if (!group.sourceSection) return <div key={group.key}>{entries}</div>;
    return (
      <Collapsible key={group.key} defaultOpen>
        <div className="flex items-center gap-2.5 rounded-md px-2 py-2">
          <Checkbox
            aria-label={`Import section ${group.title}`}
            checked={checked}
            indeterminate={!checked && any}
            onCheckedChange={(value) =>
              onSelectionChange([
                ...group.projects.flatMap((view) =>
                  view.nodes
                    ? changesFor(view.nodes, value === true)
                    : [{ projectKey: view.candidate.key, checked: value === true }],
                ),
                ...changesFor(group.threads, value === true),
              ])
            }
          />
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium">
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground group-data-panel-open:rotate-90" />
            <span className="truncate">{group.title}</span>
          </CollapsibleTrigger>
        </div>
        <CollapsiblePanel>{entries}</CollapsiblePanel>
      </Collapsible>
    );
  });
}
