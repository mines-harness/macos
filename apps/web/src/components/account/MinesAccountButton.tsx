import { UserRoundIcon } from "lucide-react";

import { useMinesAuth } from "../../cloud/MinesAuthProvider";
import { Button } from "../ui/button";

export function MinesAccountButton() {
  const { user, openAccount } = useMinesAuth();
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={`Mines account${user ? `: ${user.email}` : ""}`}
      onClick={openAccount}
    >
      <UserRoundIcon />
    </Button>
  );
}
