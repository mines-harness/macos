import { useAtomValue } from "@effect/atom-react";
import {
  CODEX_RESETS_URL,
  codexResetStatusAtom,
  describeCodexResetForecast,
} from "@t3tools/client-runtime/state/codex-resets";
import { formatDateTimeShort } from "@t3tools/shared/usageFormat";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { resolveHour12 } from "../../timestampFormat";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function CodexResetStatus() {
  const result = useAtomValue(codexResetStatusAtom);
  const status = AsyncResult.isSuccess(result) ? result.value : null;
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const [clock, setClock] = useState(() => Date.now());
  const now = Math.max(clock, AsyncResult.isSuccess(result) ? result.timestamp : 0);
  const watchExpiresAt = status?.data.active_watch?.expires_at;
  const scheduledFor = status?.data.scheduled_reset?.scheduled_for;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const updateTime = () => {
      const currentTime = Date.now();
      setClock(currentTime);
      const nextBoundary = [watchExpiresAt, scheduledFor]
        .flatMap((value) => (value ? [Date.parse(value)] : []))
        .filter((value) => value > currentTime)
        .sort((left, right) => left - right)[0];
      if (nextBoundary !== undefined) {
        timer = setTimeout(updateTime, Math.min(nextBoundary - currentTime, 2_147_483_647));
      }
    };
    updateTime();
    return () => clearTimeout(timer);
  }, [watchExpiresAt, scheduledFor]);

  const latestReset = status?.data.latest_reset;
  const hour12 = resolveHour12(timestampFormat);
  return (
    <div className="flex flex-col gap-0.5 text-2xs text-muted-foreground">
      <span>
        {status
          ? describeCodexResetForecast(status, now)
          : AsyncResult.isInitial(result)
            ? "Checking reset forecast…"
            : "Reset data unavailable"}
        {status?.data.scheduled_reset && scheduledFor && Date.parse(scheduledFor) > now
          ? ` · ${formatDateTimeShort(scheduledFor, undefined, hour12)}`
          : null}
      </span>
      {latestReset ? (
        <span>
          Last reset:{" "}
          <Tooltip>
            <TooltipTrigger render={<time dateTime={latestReset.announced_at} />}>
              {formatDateTimeShort(latestReset.announced_at, undefined, hour12)}
            </TooltipTrigger>
            <TooltipPopup>{new Date(latestReset.announced_at).toLocaleString()}</TooltipPopup>
          </Tooltip>{" "}
          ({latestReset.reset_type === "banked" ? "Banked" : "Manual"})
        </span>
      ) : status ? (
        <span>No resets recorded</span>
      ) : null}
      <span>
        Data from{" "}
        <InlineButton
          tone="muted"
          render={<a href={CODEX_RESETS_URL} target="_blank" rel="noopener noreferrer" />}
          aria-label="Codex Resets: community reset tracking and forecasts"
        >
          Codex Resets
        </InlineButton>
      </span>
    </div>
  );
}
