import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Features that are still settling in. Each is off until turned on here. */
export function BetaSettingsPanel() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title="Beta">
        <SettingsRow
          {...searchableSetting("working-shelf")}
          description="Fold working and monitoring mines into a Working section. They return to the top of the inbox when they need you."
          resetAction={
            settings.sidebarWorkingShelfEnabled !==
            DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled ? (
              <SettingResetButton
                label="working section"
                onClick={() =>
                  updateSettings({
                    sidebarWorkingShelfEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.sidebarWorkingShelfEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ sidebarWorkingShelfEnabled: Boolean(checked) })
              }
              aria-label="Working section"
            />
          }
        />
        <GuestLinksRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function GuestLinksRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("guest-links")}
      settingKeys={["guestSharingEnabled"]}
      description="Guests join by nickname. Each link has a people limit, expiry, and viewing, owner-approved writing, or direct sending permissions. Turning this off stops guest access."
      control={
        <ScopedSwitch
          settingKeys={["guestSharingEnabled"]}
          checked={settings.guestSharingEnabled}
          onCheckedChange={(checked) => updateSettings({ guestSharingEnabled: Boolean(checked) })}
          aria-label="Guest links"
        />
      }
    />
  );
}
