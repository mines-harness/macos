import type { ProviderAuthState, ServerProvider } from "@t3tools/contracts";

export function providerAccountMessage(
  provider: Pick<ServerProvider, "message">,
  state: Pick<ProviderAuthState, "phase" | "message"> | null | undefined,
  signedIn: boolean,
) {
  if (
    state?.phase === "starting" ||
    state?.phase === "waiting" ||
    state?.phase === "verifying" ||
    state?.phase === "failed" ||
    state?.phase === "cancelled"
  )
    return state.message;
  return provider.message ?? (signedIn ? "Signed in." : null);
}
