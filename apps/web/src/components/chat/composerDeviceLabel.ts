import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import type { EnvironmentPresentation } from "../../state/environments";
import { isElectron } from "../../env";

export function composerDeviceLabel(
  device: Pick<EnvironmentPresentation, "label" | "entry"> | undefined,
): string {
  if (!device) return "This device";
  const target = device.entry.target;
  return target._tag === "PrimaryConnectionTarget" &&
    (isElectron || isLocalLoopbackHost(new URL(target.httpBaseUrl).hostname))
    ? "Local"
    : device.label;
}
