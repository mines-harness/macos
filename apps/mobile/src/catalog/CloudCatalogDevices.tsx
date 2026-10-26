import { useEffect, useRef } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { MinesCatalog } from "@t3tools/client-runtime/catalog";
import type { EnvironmentId } from "@t3tools/contracts";
import { cloudSnapshot } from "../state/cloudTasks";
import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";

export function CloudCatalogDevices({
  environmentId,
  catalog,
}: {
  environmentId: EnvironmentId;
  catalog: MinesCatalog;
}) {
  const snapshot = useEnvironmentQuery(cloudSnapshot({ environmentId, input: {} }));
  const refresh = snapshot.refresh;
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const accountState = JSON.stringify(
    providers?.map(({ instanceId, driver, enabled, auth }) => ({
      instanceId,
      driver,
      enabled,
      auth,
    })),
  );
  const previousAccounts = useRef(accountState);
  useEffect(() => {
    if (previousAccounts.current === accountState) return;
    previousAccounts.current = accountState;
    refresh();
  }, [accountState, refresh]);
  useEffect(() => {
    const data = snapshot.data;
    if (!data?.checkedAt || snapshot.error) return;
    catalog.reconcileHostDevices({
      environmentId,
      entityPrefix: "cloud:",
      devices: data.targets.map((target) => ({ id: target.id, title: target.label })),
      sequence: Date.parse(data.checkedAt),
    });
  }, [catalog, snapshot.data, snapshot.error, environmentId]);
  return null;
}
