import { useRef, useState, type ReactNode } from "react";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { ComposerSurface } from "../chat/ComposerSurface";

const EMPTY_CONTEXT_RECORDS = new Map<string, never>();
const EMPTY_SKILLS: ReadonlyArray<never> = [];

export function GroupMessageComposer({
  draftKey,
  value,
  onChange,
  onSubmit,
  ariaLabel,
  placeholder,
  disabled,
  submitOnEnter = false,
  children,
}: {
  readonly draftKey: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (alternate: boolean) => void;
  readonly ariaLabel: string;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly submitOnEnter?: boolean;
  readonly children: ReactNode;
}) {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [selection, setSelection] = useState({ value, cursor: value.length });
  return (
    <ComposerSurface.Shell>
      <ComposerSurface.Host>
        <ComposerSurface.Main>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit(false);
            }}
          >
            <div className="px-4 pt-4 pb-3">
              <ComposerPromptEditor
                draftKey={draftKey}
                value={value}
                cursor={selection.value === value ? selection.cursor : value.length}
                literalText
                contextRecords={EMPTY_CONTEXT_RECORDS}
                skills={EMPTY_SKILLS}
                disabled={disabled}
                ariaLabel={ariaLabel}
                placeholder={placeholder}
                editorRef={editorRef}
                onChange={(text, cursor) => {
                  setSelection({ value: text, cursor });
                  onChange(text);
                }}
                onCommandKeyDown={(key, event) => {
                  if (
                    key !== "Enter" ||
                    event.shiftKey ||
                    (!submitOnEnter && !event.metaKey && !event.ctrlKey)
                  )
                    return false;
                  onSubmit(event.metaKey || event.ctrlKey);
                  return true;
                }}
                onPaste={() => {}}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 px-3 pb-3 sm:px-4 sm:pb-4">
              {children}
            </div>
          </form>
        </ComposerSurface.Main>
      </ComposerSurface.Host>
    </ComposerSurface.Shell>
  );
}
