import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  resolveProviderInstanceEnabled,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { toastManager } from "../ui/toast";
import { ProviderSetupSection, readAntigravityAuthMethod } from "./ProviderSetupSection";

import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { WizardFooter, WizardPanel } from "../ui/wizard";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";

export function ProviderWizardAuthenticationStep({
  environmentId,
  environmentLabel,
  instanceId,
  driverKind,
  onFinish,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly driverKind?: ProviderDriverKind;
  readonly onFinish: () => void;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  const settings = useEnvironmentSettings(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const instance = settings.providerInstances[instanceId];
  const config = instance?.config;
  const binaryPath =
    config !== null &&
    typeof config === "object" &&
    "binaryPath" in config &&
    typeof config.binaryPath === "string"
      ? config.binaryPath
      : "";
  const isAntigravity = (provider?.driver ?? instance?.driver ?? driverKind) === "antigravity";
  const query = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }),
  );
  const auth = query.data;
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const signedIn =
    provider?.auth.status === "authenticated" ||
    (provider?.auth.status === "unknown" && auth?.phase === "succeeded");
  const isDiscovering = !signedIn && !query.error && auth?.methods === undefined;
  const canAuthenticate = (auth?.methods?.length ?? 0) > 0;

  return (
    <>
      <WizardPanel className="min-h-72">
        <SettingsGroup variant="plain">
          {isAntigravity ? (
            <ProviderSetupSection
              environmentId={environmentId}
              environmentLabel={environmentLabel}
              instanceId={instanceId}
              provider={provider}
              binaryPath={binaryPath}
              authMethod={readAntigravityAuthMethod(config)}
              enabled={
                instance ? resolveProviderInstanceEnabled(instance) : (provider?.enabled ?? true)
              }
              readOnly={!canManageProviders}
              onEnable={() => {
                if (!instance || !readEnvironmentScope(environmentId, AuthProvidersManageScope))
                  return;
                void persistProviderInstance({
                  operation: "upsert",
                  instanceId,
                  instance: { ...instance, enabled: true },
                }).then((result) => {
                  if (result._tag !== "Failure") return;
                  const error = squashAtomCommandFailure(result);
                  toastManager.add({
                    type: "error",
                    title: "Could not enable provider",
                    description:
                      error instanceof Error
                        ? error.message
                        : "The provider settings could not be saved.",
                  });
                });
              }}
            />
          ) : provider && (canAuthenticate || signedIn) ? (
            <ProviderAuthenticationSection
              environmentId={environmentId}
              environmentLabel={environmentLabel}
              instanceId={instanceId}
              provider={{
                ...provider,
                setup: {
                  ...provider.setup,
                  canInstall: provider.setup?.canInstall ?? false,
                  canAuthenticate,
                },
              }}
              readOnly={!canManageProviders}
            />
          ) : (
            <SettingsRow
              title="Account"
              description={
                isDiscovering
                  ? "Discovering sign-in methods…"
                  : (query.error ??
                    auth?.message ??
                    "No in-app sign-in advertised. Follow the provider's docs to finish setup.")
              }
              control={
                isDiscovering ? (
                  <Button disabled size="sm" variant="outline">
                    Sign in
                  </Button>
                ) : provider?.setup?.documentationUrl ? (
                  <Button
                    size="sm"
                    variant="outline"
                    render={
                      <a href={provider.setup.documentationUrl} target="_blank" rel="noreferrer" />
                    }
                  >
                    Open docs
                  </Button>
                ) : undefined
              }
            />
          )}
        </SettingsGroup>
      </WizardPanel>
      <WizardFooter>
        <Button
          size="sm"
          variant={signedIn ? "default" : "outline"}
          disabled={active}
          onClick={onFinish}
        >
          {signedIn ? "Done" : "Skip for now"}
        </Button>
      </WizardFooter>
    </>
  );
}
