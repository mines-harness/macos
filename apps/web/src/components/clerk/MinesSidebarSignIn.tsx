import { useMinesAuth } from "../../cloud/MinesAuthProvider";
import { LogInIcon } from "lucide-react";

import { hasMinesIdentityConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { MinesAccountButton } from "../account/MinesAccountButton";
import { useMinesAuthPrompt } from "./useMinesAuthPrompt";

export function MinesSidebarSignIn() {
  if (!hasMinesIdentityConfig()) return null;

  return <ConfiguredMinesSidebarSignIn />;
}

export function MinesSidebarAvatar() {
  if (!hasMinesIdentityConfig()) return null;

  return <ConfiguredMinesSidebarAvatar />;
}

function ConfiguredMinesSidebarAvatar() {
  const { isLoaded, isSignedIn } = useMinesAuth();

  if (!isLoaded || !isSignedIn) return null;

  return <MinesAccountButton />;
}

function ConfiguredMinesSidebarSignIn() {
  const { isLoaded, isSignedIn } = useMinesAuth();
  const { authPrompt, openAuthPrompt } = useMinesAuthPrompt();

  if (!isLoaded || isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt}>
            <LogInIcon />
            <span>Sign in to mines</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}
