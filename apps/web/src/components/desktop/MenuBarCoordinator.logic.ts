import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { DesktopMenuBarState, ServerProvider } from "@t3tools/contracts";

import { resolveSidebarThreadStatus } from "../Sidebar.logic";

export function buildMenuBarState(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly providers: readonly Pick<
    ServerProvider,
    "enabled" | "driver" | "displayName" | "usageLimits" | "auth"
  >[];
  readonly connectedDevices: number;
  readonly totalDevices: number;
  readonly devices?: DesktopMenuBarState["devices"];
}): DesktopMenuBarState {
  const active = input.threads
    .filter((thread) => thread.archivedAt === null)
    .flatMap((thread) => {
      const status = resolveSidebarThreadStatus(thread);
      if (status === "ready" || (status === "waiting" && thread.runtime?.status === "idle"))
        return [];
      return [
        {
          environmentId: thread.environmentId,
          threadId: thread.id,
          title: thread.title.slice(0, 160),
          status:
            status === "working" || status === "waiting"
              ? ("working" as const)
              : ("attention" as const),
        },
      ];
    });
  return {
    running: active.filter((thread) => thread.status === "working").length,
    attention: active.filter((thread) => thread.status === "attention").length,
    connectedDevices: input.connectedDevices,
    totalDevices: input.totalDevices,
    ...(input.devices
      ? {
          devices: input.devices.slice(0, 100).map((device) => ({
            ...device,
            id: device.id.slice(0, 256),
            name: device.name.slice(0, 100),
          })),
        }
      : {}),
    threads: [
      ...active.filter((thread) => thread.status === "attention"),
      ...active.filter((thread) => thread.status === "working"),
    ].slice(0, 12),
    limits: input.providers
      .filter((provider) => provider.enabled && provider.auth.status === "authenticated")
      .slice(0, 12)
      .map((provider) => ({
        label: (provider.displayName ?? provider.driver).slice(0, 100),
        driver: provider.driver.slice(0, 100),
        ...((provider.auth.email ?? provider.auth.label)
          ? { accountLabel: (provider.auth.email ?? provider.auth.label)!.slice(0, 256) }
          : {}),
        remainingPercent:
          provider.usageLimits?.unavailable || !provider.usageLimits?.windows.length
            ? null
            : Math.max(
                0,
                100 - Math.max(...provider.usageLimits.windows.map((window) => window.usedPercent)),
              ),
        checkedAt: provider.usageLimits?.checkedAt ?? "",
        windows: (provider.usageLimits?.windows ?? []).slice(0, 12).map((window) => ({
          id: window.id.slice(0, 100),
          label: window.label.slice(0, 100),
          remainingPercent: provider.usageLimits?.unavailable
            ? null
            : Math.max(0, 100 - window.usedPercent),
          ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
        })),
      })),
  };
}
