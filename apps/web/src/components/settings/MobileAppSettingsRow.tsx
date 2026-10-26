import { AndroidIcon, AppleIcon } from "../Icons";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function MobileAppSettingsRow() {
  return (
    <SettingsRow
      {...searchableSetting("mobile-app")}
      description="Store release not available yet."
      control={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled>
            <AppleIcon />
            iPhone and iPad
          </Button>
          <Button size="sm" variant="outline" disabled>
            <AndroidIcon />
            Android
          </Button>
        </div>
      }
    />
  );
}
