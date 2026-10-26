import { useMinesAuth } from "../../cloud/MinesAuthProvider";

export function useMinesAuthPrompt() {
  const { openAccount } = useMinesAuth();
  return { authPrompt: null, openAuthPrompt: openAccount };
}
