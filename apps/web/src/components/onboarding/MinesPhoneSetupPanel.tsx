import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { MinesPeerSettings } from "../settings/MinesPeerSettings";
import { MinesIcon } from "../MinesWordmark";
import "./MinesPhoneSetupPanel.css";

function ExampleActivity({ width }: { readonly width: number }) {
  return (
    <g fontFamily="Inter, ui-sans-serif, system-ui, sans-serif" fontSize="9">
      {[
        { stage: "reading", text: "Reading files" },
        { stage: "updating", text: "Updating interface" },
        { stage: "ready", text: "Ready for review" },
      ].map(({ stage, text }, index) => (
        <g key={stage} transform={`translate(0 ${index * 31})`}>
          <g data-phone-example-stage={stage}>
            <rect width={width} height="25" rx="6" fill="var(--color-white)" fillOpacity="0.035" />
            <circle
              cx="11"
              cy="12.5"
              r="2.5"
              fill={stage === "ready" ? "var(--color-emerald-300)" : "var(--color-slate-400)"}
            />
            <text x="21" y="15.5" fill="var(--color-zinc-200)">
              {text}
            </text>
          </g>
        </g>
      ))}
    </g>
  );
}

function RemoteWorkIllustration() {
  return (
    <svg
      viewBox="0 0 620 300"
      className="mx-auto block w-full max-w-xl"
      role="img"
      aria-label="Example: the same mine’s activity appears on a phone and a remote computer."
      data-phone-illustration
    >
      <defs>
        <linearGradient id="phone-frame" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="var(--color-zinc-500)" />
          <stop offset="0.35" stopColor="var(--color-zinc-800)" />
          <stop offset="1" stopColor="var(--color-zinc-600)" />
        </linearGradient>
        <linearGradient id="computer-frame" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="var(--color-zinc-800)" />
          <stop offset="1" stopColor="var(--color-zinc-950)" />
        </linearGradient>
        <radialGradient id="device-shadow">
          <stop stopColor="var(--color-black)" stopOpacity="0.6" />
          <stop offset="1" stopColor="var(--color-black)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="382" cy="253" rx="186" ry="22" fill="url(#device-shadow)" />
      <ellipse cx="155" cy="276" rx="104" ry="17" fill="url(#device-shadow)" />
      <g transform="translate(284 48) rotate(5 150 100) scale(.86)">
        <rect
          width="300"
          height="192"
          rx="13"
          fill="url(#computer-frame)"
          stroke="var(--color-zinc-700)"
        />
        <rect x="8" y="8" width="284" height="176" rx="7" fill="var(--color-neutral-950)" />
        <g fill="var(--color-zinc-700)">
          <circle cx="20" cy="19" r="2" />
          <circle cx="28" cy="19" r="2" />
          <circle cx="36" cy="19" r="2" />
        </g>
        <MinesIcon x="27" y="35" width="19" height="19" color="var(--color-zinc-300)" />
        <text
          x="53"
          y="48"
          fill="var(--color-zinc-200)"
          fontSize="11"
          fontFamily="system-ui, sans-serif"
        >
          Interface polish
        </text>
        <g transform="translate(29 67)">
          <ExampleActivity width={242} />
        </g>
        <path
          d="M0 192h300l23 16c2 2 0 5-4 5H-19c-4 0-6-3-4-5z"
          fill="var(--color-zinc-800)"
          stroke="var(--color-zinc-700)"
        />
        <path d="M118 193h64l-4 5h-56z" fill="var(--color-zinc-700)" />
      </g>
      <path
        d="M294 161c-28 0-26-12-54-12"
        fill="none"
        stroke="var(--color-slate-400)"
        strokeWidth="1.5"
        strokeDasharray="3 6"
        data-phone-example-connection
      />
      <g transform="translate(77 11) rotate(-7 83 137)">
        <rect
          width="166"
          height="274"
          rx="27"
          fill="var(--color-black)"
          stroke="url(#phone-frame)"
          strokeWidth="2.5"
        />
        <rect
          x="9"
          y="10"
          width="148"
          height="254"
          rx="20"
          fill="var(--color-zinc-950)"
          stroke="var(--color-zinc-800)"
        />
        <rect x="59" y="17" width="48" height="12" rx="6" fill="var(--color-black)" />
        <MinesIcon x="23" y="43" width="20" height="20" color="var(--color-zinc-200)" />
        <text
          x="49"
          y="57"
          fill="var(--color-zinc-200)"
          fontSize="12"
          fontFamily="system-ui, sans-serif"
        >
          mines
        </text>
        <text
          x="24"
          y="88"
          fill="var(--color-zinc-100)"
          fontSize="11"
          fontFamily="system-ui, sans-serif"
        >
          Interface polish
        </text>
        <g transform="translate(24 105)">
          <ExampleActivity width={118} />
        </g>
        <rect
          x="24"
          y="211"
          width="118"
          height="27"
          rx="9"
          fill="var(--color-zinc-900)"
          stroke="var(--color-zinc-800)"
        />
        <text
          x="36"
          y="228"
          fill="var(--color-zinc-500)"
          fontSize="8.5"
          fontFamily="system-ui, sans-serif"
        >
          Send a prompt…
        </text>
        <path
          d="m128 229 0-8m-3 3 3-3 3 3"
          fill="none"
          stroke="var(--color-slate-400)"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect x="63" y="253" width="40" height="3" rx="1.5" fill="var(--color-zinc-600)" />
      </g>
    </svg>
  );
}

export function MinesPhoneSetupPanel({ onDone }: { readonly onDone: () => void }) {
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupStarted, setSetupStarted] = useState(false);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Your work, on your phone</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Follow what’s happening on your computer, remotely from your phone.
        </p>
      </div>
      <div className="rounded-xl border border-border bg-black px-3 pt-2 pb-3">
        <RemoteWorkIllustration />
        <p className="text-center text-xs text-muted-foreground">
          Example activity, wherever you are.
        </p>
      </div>
      <p className="text-xs text-muted-foreground">Available later in Settings → Connections.</p>
      <Collapsible
        open={setupOpen}
        onOpenChange={(open) => {
          setSetupOpen(open);
          if (open) setSetupStarted(true);
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CollapsibleTrigger render={<Button size="sm" variant="outline" />}>
            {setupOpen ? "Hide setup" : "Set up now"}
            <ChevronDownIcon
              aria-hidden
              className={setupOpen ? "size-3.5 rotate-180" : "size-3.5"}
            />
          </CollapsibleTrigger>
          <Button onClick={onDone}>Start using mines</Button>
        </div>
        <CollapsiblePanel keepMounted>
          <div className="pt-4">{setupStarted ? <MinesPeerSettings /> : null}</div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
