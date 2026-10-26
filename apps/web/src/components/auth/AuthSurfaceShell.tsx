import type { ReactNode } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import { MinesWordmark } from "../MinesWordmark";
import { StandalonePage } from "../ui/standalone-page";

export function AuthSurfaceShell({ children }: { readonly children: ReactNode }) {
  return (
    <StandalonePage
      tone="brand"
      masthead={
        <header className="flex h-24 items-center border-b border-border bg-background p-5 text-foreground sm:p-6">
          <MinesWordmark className="h-8 w-auto" aria-label={APP_DISPLAY_NAME} />
        </header>
      }
    >
      {children}
    </StandalonePage>
  );
}
