import type { PeerDeviceStatus } from "@t3tools/contracts";

import { Badge } from "../ui/badge";
import { describePeerDevice } from "./peerDeviceStatus.logic";

const checkedTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function PeerDeviceStatusText({
  status,
  online,
  checkedAt,
}: {
  readonly status?: PeerDeviceStatus["status"] | "unknown";
  readonly online?: boolean;
  readonly checkedAt?: string | null | undefined;
}) {
  const description = describePeerDevice({
    ...(status === undefined ? {} : { status }),
    ...(online === undefined ? {} : { online }),
  });
  const checked = checkedAt ? new Date(checkedAt) : null;
  return (
    <span className="block space-y-1.5">
      <span className="flex flex-wrap items-center gap-2">
        <Badge variant={description.tone}>{description.label}</Badge>
        <span className="text-xs text-muted-foreground">{description.presenceLabel}</span>
        {checked && Number.isFinite(checked.getTime()) ? (
          <time dateTime={checkedAt!} className="text-xs text-muted-foreground">
            Last checked {checkedTime.format(checked)}
          </time>
        ) : null}
      </span>
      <span className="block text-xs text-muted-foreground">{description.description}</span>
    </span>
  );
}
