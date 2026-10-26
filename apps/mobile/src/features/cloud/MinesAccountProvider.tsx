import * as SecureStore from "expo-secure-store";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";

import {
  createMinesAccountClient,
  defaultAccountConfiguration,
  type MinesAccountSession,
} from "./minesAccountClient";
import { resolveCloudPublicConfig } from "./publicConfig";

function useAccountState() {
  const controlUrl = resolveCloudPublicConfig().identity.controlUrl;
  const client = useMemo(
    () =>
      controlUrl
        ? createMinesAccountClient(controlUrl, {
            getItem: SecureStore.getItemAsync,
            setItem: (key, value) =>
              SecureStore.setItemAsync(key, value, {
                keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
              }),
            removeItem: SecureStore.deleteItemAsync,
          })
        : null,
    [controlUrl],
  );
  const [session, setSession] = useState<MinesAccountSession | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [configuration, setConfiguration] = useState(defaultAccountConfiguration);
  const sessionRef = useRef(session);
  const revision = useRef(0);
  const updateSession = useCallback((next: MinesAccountSession | null) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      const expected = revision.current;
      try {
        if (client) {
          try {
            const config = await client.getConfiguration();
            if (active) setConfiguration(config);
          } catch {
            // Unknown configuration keeps email verification required and mail actions hidden.
          }
        }
        const next = client ? await client.restore() : null;
        if (active && expected === revision.current) updateSession(next);
      } catch {
        // Keep credentials during network outages; the next foreground activation retries.
      } finally {
        if (active) setIsLoaded(true);
      }
    };
    void restore();
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") void restore();
    });
    return () => {
      active = false;
      foreground.remove();
    };
  }, [client, updateSession]);

  const token = session?.token ?? null;
  const getToken = useCallback(async () => token, [token]);
  const refreshSession = useCallback(async () => {
    const accountId = sessionRef.current?.user.id;
    if (!client || !accountId) return;
    const expected = revision.current;
    const next = await client.restore();
    if (expected !== revision.current || sessionRef.current?.user.id !== accountId) return;
    if (next !== null && next.user.id !== accountId) return;
    updateSession(next);
  }, [client, updateSession]);
  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!client) throw new Error("The mines account service is not configured.");
      const expected = ++revision.current;
      const next = await client.signIn(email, password);
      if (expected === revision.current) updateSession(next);
    },
    [client, updateSession],
  );
  const signOut = useCallback(async () => {
    revision.current += 1;
    const token = sessionRef.current?.token ?? null;
    updateSession(null);
    await client?.signOut(token);
  }, [client, updateSession]);
  const signUp = useCallback(
    async (name: string, email: string, password: string) => {
      if (!client) throw new Error("The mines account service is not configured.");
      await client.signUp(name, email, password);
    },
    [client],
  );
  const requestPasswordReset = useCallback(
    async (email: string) => {
      if (!client) throw new Error("The mines account service is not configured.");
      await client.requestPasswordReset(email);
    },
    [client],
  );
  const resendVerification = useCallback(
    async (email: string) => {
      if (!client) throw new Error("The mines account service is not configured.");
      await client.resendVerification(email);
    },
    [client],
  );
  return useMemo(
    () => ({
      isLoaded,
      isSignedIn: session !== null,
      userId: session?.user.id ?? null,
      user: session?.user ?? null,
      ...configuration,
      getToken,
      refreshSession,
      signIn,
      signOut,
      signUp,
      requestPasswordReset,
      resendVerification,
    }),
    [
      isLoaded,
      session,
      configuration,
      getToken,
      refreshSession,
      signIn,
      signOut,
      signUp,
      requestPasswordReset,
      resendVerification,
    ],
  );
}

const AccountContext = createContext<ReturnType<typeof useAccountState> | null>(null);

export function MinesAccountProvider({ children }: { readonly children: ReactNode }) {
  const account = useAccountState();
  return <AccountContext value={account}>{children}</AccountContext>;
}

export function useMinesAccount() {
  const account = use(AccountContext);
  if (!account) throw new Error("MinesAccountProvider is required.");
  return account;
}
