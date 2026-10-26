import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useThreadShells } from "../../state/entities";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { buildMenuBarState } from "./MenuBarCoordinator.logic";

export function MenuBarCoordinator() {
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const providers = useEnvironmentProviders();
  const navigate = useNavigate();
  const state = buildMenuBarState({
    threads,
    providers: [...providers.values()].flat(),
    connectedDevices: environments.filter(
      (environment) => environment.connection.phase === "connected",
    ).length,
    totalDevices: environments.length,
    devices: environments.map((environment) => ({
      id: environment.environmentId,
      name: environment.label,
      connected: environment.connection.phase === "connected",
      local: environment.entry.target._tag === "PrimaryConnectionTarget",
    })),
  });
  const serialized = JSON.stringify(state);

  useEffect(() => {
    void window.desktopBridge?.setMenuBarState?.(JSON.parse(serialized)).catch(() => undefined);
  }, [serialized]);

  useEffect(
    () =>
      window.desktopBridge?.onMenuAction((action) => {
        if (action === "mines:devices") {
          void navigate({ to: "/settings/connections" });
        } else if (action === "mines:accounts") {
          void navigate({ to: "/settings/providers" });
        } else if (action.startsWith("mines:thread:")) {
          const [environment, thread] = action.slice("mines:thread:".length).split("/");
          if (!environment || !thread) return;
          void navigate({
            to: "/$environmentId/$threadId",
            params: {
              environmentId: EnvironmentId.make(decodeURIComponent(environment)),
              threadId: ThreadId.make(decodeURIComponent(thread)),
            },
          });
        }
      }),
    [navigate],
  );

  return null;
}
