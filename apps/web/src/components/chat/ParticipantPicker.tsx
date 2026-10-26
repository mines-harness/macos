import { useState, type SVGProps } from "react";
import { CheckIcon } from "lucide-react";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { InlineButton } from "../ui/button";
import { MinesIcon } from "../MinesWordmark";
import {
  participantKey,
  participantLabel,
  participantOptions,
  type ParticipantCandidate,
} from "./draftParticipants";

export type { ParticipantCandidate } from "./draftParticipants";

function AddParticipantsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <circle cx="9" cy="7" r="3.3" opacity=".55" />
      <path d="M2 19a7 7 0 0 1 14 0Z" opacity=".55" />
      <circle cx="14" cy="10" r="3.3" />
      <path d="M7 22a7 7 0 0 1 14 0Z" />
      <path
        d="M20 2v6m-3-3h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ParticipantPicker({
  threads,
  value,
  onChange,
  disabled = false,
  label = "Add participants",
  maxParticipants = 12,
}: {
  threads: ReadonlyArray<ParticipantCandidate>;
  value: ReadonlyArray<ParticipantCandidate>;
  onChange: (value: ReadonlyArray<ParticipantCandidate>) => void;
  disabled?: boolean;
  label?: string;
  maxParticipants?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const options = participantOptions(threads, value, query);
  const selected = new Set(value.map(participantKey));
  return (
    <Combobox
      multiple
      disabled={disabled}
      items={options}
      filteredItems={options}
      value={[...value]}
      inputValue={query}
      autoHighlight
      itemToStringLabel={(item) => item.title}
      isItemEqualToValue={(left, right) => participantKey(left) === participantKey(right)}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery("");
      }}
      onInputValueChange={setQuery}
      onValueChange={(next) => {
        onChange(next);
        setQuery("");
      }}
    >
      <ComboboxTrigger
        disabled={disabled}
        aria-label={value.length ? `Participants: ${participantLabel(value)}` : label}
        render={<InlineButton tone={value.length ? "default" : "muted"} />}
      >
        <span
          className={`inline-flex min-w-0 items-center gap-1.5 ${value.length ? "text-info-foreground" : ""}`}
        >
          {value.length ? (
            <MinesIcon className="size-4 shrink-0" aria-hidden />
          ) : (
            <AddParticipantsIcon className="size-4 shrink-0" aria-hidden />
          )}
          <span className="max-w-64 truncate">{participantLabel(value, label)}</span>
        </span>
      </ComboboxTrigger>
      <ComboboxPopup align="center" className="w-80">
        <ComboboxSearchInput aria-label="Search mines" placeholder="Search your mines…" />
        <ComboboxEmpty>No matching mines.</ComboboxEmpty>
        <ComboboxList>
          {(item: ParticipantCandidate) => (
            <ComboboxItem
              key={participantKey(item)}
              value={item}
              disabled={
                !selected.has(participantKey(item)) &&
                (!!item.disabledReason || value.length >= maxParticipants)
              }
            >
              <MinesIcon className="size-4" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.title}</span>
                {item.disabledReason || item.detail ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.disabledReason ?? item.detail}
                  </span>
                ) : null}
              </span>
              {selected.has(participantKey(item)) ? (
                <CheckIcon className="size-3.5 text-info-foreground" aria-label="Selected" />
              ) : null}
            </ComboboxItem>
          )}
        </ComboboxList>
        {value.length ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {value.length} selected · Click a selected mine to remove it
          </p>
        ) : null}
      </ComboboxPopup>
    </Combobox>
  );
}
