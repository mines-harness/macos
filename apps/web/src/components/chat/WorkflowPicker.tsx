import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import type { GroupWorkflow, ModelSelection } from "@t3tools/contracts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { GROUP_WORKFLOWS } from "../groups/GroupWorkspace";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { ComposerSelectControl } from "./ComposerControl";

export const draftWorkflowAtom = Atom.family((_key: string) =>
  Atom.make<GroupWorkflow>("compare").pipe(Atom.keepAlive),
);
export const workflowLauncherHandlerAtom = Atom.family((_key: string) =>
  Atom.make<{ readonly open: () => void } | null>(null).pipe(Atom.keepAlive),
);
export function requestWorkflowLauncher(routeKey: string): void {
  appAtomRegistry.get(workflowLauncherHandlerAtom(routeKey))?.open();
}
export function WorkflowPicker({
  routeKey,
  selections,
  onSelectionsChange,
}: {
  routeKey: string;
  selections: ReadonlyArray<ModelSelection>;
  onSelectionsChange: (value: ReadonlyArray<ModelSelection> | null) => void;
}) {
  const mode = useAtomValue(draftWorkflowAtom(routeKey));
  return (
    <>
      <Select
        value={mode}
        onValueChange={(value) => {
          if (value) appAtomRegistry.set(draftWorkflowAtom(routeKey), value);
        }}
      >
        <ComposerSelectControl size="sm" aria-label="Multi-model workflow">
          <SelectValue />
        </ComposerSelectControl>
        <SelectPopup>
          {GROUP_WORKFLOWS.map((workflow) => (
            <SelectItem key={workflow.id} value={workflow.id}>
              <span className="block">
                <span className="block text-sm">{workflow.label}</span>
                <span className="block max-w-72 text-xs text-muted-foreground">
                  {workflow.description}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {mode === "council" || mode === "build-review" ? (
        <Select
          value={selections[0]?.instanceId + ":" + selections[0]?.model}
          onValueChange={(key) => {
            const index = selections.findIndex(
              (selection) => `${selection.instanceId}:${selection.model}` === key,
            );
            if (index > 0)
              onSelectionsChange([
                selections[index]!,
                ...selections.filter((_, itemIndex) => itemIndex !== index),
              ]);
          }}
        >
          <ComposerSelectControl size="sm" aria-label="Lead model">
            <span>Lead</span>
            <SelectValue />
          </ComposerSelectControl>
          <SelectPopup>
            {selections.map((selection) => (
              <SelectItem
                key={`${selection.instanceId}:${selection.model}`}
                value={`${selection.instanceId}:${selection.model}`}
              >
                {selection.model}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
    </>
  );
}
