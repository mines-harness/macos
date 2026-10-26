import type { ReactNode } from "react";

import { MinesAuthProvider } from "../../cloud/MinesAuthProvider";
import { MinesIdentityBridge } from "../../cloud/MinesIdentityBridge";
import { ContactsProvider } from "../contacts/ContactsProvider";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";

export default function MinesManagedAuthShell({ children }: { readonly children: ReactNode }) {
  return (
    <AppAtomRegistryProvider>
      <MinesAuthProvider>
        <ContactsProvider>
          <MinesIdentityBridge>{children}</MinesIdentityBridge>
        </ContactsProvider>
      </MinesAuthProvider>
    </AppAtomRegistryProvider>
  );
}
