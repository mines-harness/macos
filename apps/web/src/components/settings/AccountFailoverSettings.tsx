import type { ProviderInstanceConfig, ServerProvider } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function AccountFailoverSettings({
  instance,
  provider,
  readOnly,
  onUpdate,
}: {
  readonly instance: ProviderInstanceConfig;
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
  readonly onUpdate: (next: ProviderInstanceConfig) => void;
}) {
  const supported = provider?.accountFailover?.supported === true;
  const enabled = instance.quotaFailoverPriority !== undefined;
  const disable = () => {
    const { quotaFailoverPriority: _priority, ...next } = instance;
    onUpdate(next);
  };
  return (
    <SettingsSection title="Account switching">
      <SettingsRow
        title={supported ? "Continue with another account" : "Manual account switching"}
        description={
          supported
            ? "After a confirmed usage-limit stop, continue on an opted-in account with the same provider and model. Each account is tried once, with at most eight accounts per continuation."
            : (provider?.accountFailover?.reason ??
              "Automatic subscription switching is not confirmed as supported by this provider. Select another account in the model picker, or use Resume at reset on a stopped mine.")
        }
        control={
          supported ? (
            <Switch
              checked={enabled}
              disabled={readOnly}
              onCheckedChange={(checked) =>
                checked ? onUpdate({ ...instance, quotaFailoverPriority: 100 }) : disable()
              }
              aria-label="Continue with another account"
            />
          ) : enabled ? (
            <Button size="sm" variant="outline" disabled={readOnly} onClick={disable}>
              Use manual switching
            </Button>
          ) : undefined
        }
      />
      {supported && enabled ? (
        <SettingsRow
          title="Account priority"
          description="Lower numbers are tried first. Only separate, authenticated account homes with freshly confirmed remaining usage qualify."
          control={
            <div className="w-24">
              <DraftInput
                type="number"
                min={0}
                max={1000}
                size="sm"
                disabled={readOnly}
                value={String(instance.quotaFailoverPriority)}
                onCommit={(value) => {
                  const priority = Number(value);
                  if (Number.isInteger(priority) && priority >= 0 && priority <= 1000) {
                    onUpdate({ ...instance, quotaFailoverPriority: priority });
                  }
                }}
                aria-label="Account priority"
              />
            </div>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
