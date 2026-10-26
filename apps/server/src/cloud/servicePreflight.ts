import packageJson from "../../package.json" with { type: "json" };
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      readonly launcherProtocol: typeof SERVICE_LAUNCHER_PROTOCOL;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

export function runServicePreflight(input: {
  readonly databasePath: string;
  readonly launcherProtocol: number;
  readonly version?: string;
}): ServicePreflightResult {
  const version = input.version ?? packageJson.version;
  if (input.launcherProtocol !== SERVICE_LAUNCHER_PROTOCOL) {
    return {
      status: "blocked",
      version,
      reason: [
        `The installed service launcher speaks protocol ${input.launcherProtocol}, but mines ${version} requires protocol ${SERVICE_LAUNCHER_PROTOCOL}.`,
        `Install the mines CLI matching version ${version} from the same trusted build or release as this app.`,
        `Check that \`mines --version\` prints ${version} and that \`which -a mines\` lists the intended install first, then run that install's \`mines service install\`.`,
        "Updating the desktop app does not update a separate CLI, and `mines service update` only repairs the service with whichever CLI runs it.",
      ].join(" "),
    };
  }

  return { status: "ready", version, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL };
}

export function decodeServicePreflightResult(value: unknown): ServicePreflightResult | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "ready" &&
    record.launcherProtocol === SERVICE_LAUNCHER_PROTOCOL &&
    typeof record.version === "string"
  ) {
    return {
      status: "ready",
      version: record.version,
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    };
  }
  if (
    record.status === "blocked" &&
    typeof record.version === "string" &&
    typeof record.reason === "string"
  ) {
    return { status: "blocked", version: record.version, reason: record.reason };
  }
  return undefined;
}
