import { useMinesAuth } from "../../cloud/MinesAuthProvider";
import { CheckIcon, UserRoundIcon } from "lucide-react";

import { hasMinesIdentityConfig } from "../../cloud/publicConfig";
import { useMinesAuthPrompt } from "../clerk/useMinesAuthPrompt";
import { Button } from "../ui/button";
import { MinesAccountButton } from "../account/MinesAccountButton";

export function MinesIdentityCard() {
  return hasMinesIdentityConfig() ? (
    <ConfiguredIdentityCard />
  ) : (
    <div className="rounded-lg border border-border bg-card p-4 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <UserRoundIcon className="size-4" /> Your mines account
      </div>
      <p className="mt-2 text-muted-foreground">
        Device sync is not configured for this build. You can start working on this computer and
        connect an account later.
      </p>
    </div>
  );
}

function ConfiguredIdentityCard() {
  const { isLoaded, isSignedIn } = useMinesAuth();
  const { openAuthPrompt } = useMinesAuthPrompt();
  return (
    <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          {isSignedIn ? <CheckIcon className="size-4" /> : <UserRoundIcon className="size-4" />}
          {isSignedIn ? "Your mines account is connected" : "One account for your devices"}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Your mines identity connects your devices. Agent subscriptions stay separate, on the
          computer that runs them.
        </p>
      </div>
      {isSignedIn ? (
        <MinesAccountButton />
      ) : (
        <Button size="sm" disabled={!isLoaded} onClick={openAuthPrompt}>
          Sign in
        </Button>
      )}
    </div>
  );
}
