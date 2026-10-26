import { createContext, use, useEffect, useRef, useState, type ReactNode } from "react";

import { MinesAccountDialog } from "../components/account/MinesAccountDialog";
import { createMinesAccountClient, type MinesAccountUser } from "./minesAccountClient";
import { minesControlUrl } from "./publicConfig";
import { useStableCallback } from "../hooks/useStableCallback";

type Credentials = { readonly email: string; readonly password: string };
interface MinesAuthContextValue {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly user: MinesAccountUser | null;
  readonly error: string | null;
  readonly getToken: () => Promise<string | null>;
  readonly signIn: (credentials: Credentials) => Promise<void>;
  readonly signUp: (credentials: Credentials & { readonly name: string }) => Promise<boolean>;
  readonly signOut: () => Promise<void>;
  readonly requestPasswordReset: (email: string) => Promise<void>;
  readonly sendVerificationEmail: (email: string) => Promise<void>;
  readonly refreshSession: () => Promise<void>;
  readonly openAccount: () => void;
}

const MinesAuthContext = createContext<MinesAuthContextValue | null>(null);

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Your account could not be opened. Please try again.";
}

function accountStorage(origin: string) {
  const key = `mines.account.session:${origin}`;
  let writeQueue = Promise.resolve();
  return {
    key,
    async read() {
      await writeQueue.catch(() => {});
      if (!window.desktopBridge) return window.localStorage.getItem(key);
      if (!window.desktopBridge.getMinesAccountToken)
        throw new Error("Update the Mines app to use your account on this computer.");
      const stored = await window.desktopBridge.getMinesAccountToken();
      if (!stored) return null;
      try {
        const value: unknown = JSON.parse(stored);
        if (
          typeof value !== "object" ||
          value === null ||
          !("origin" in value) ||
          !("token" in value)
        )
          return null;
        return value.origin === origin && typeof value.token === "string" ? value.token : null;
      } catch {
        return null;
      }
    },
    write(token: string | null) {
      writeQueue = writeQueue
        .catch(() => {})
        .then(async () => {
          if (window.desktopBridge) {
            if (!window.desktopBridge.setMinesAccountToken)
              throw new Error("Update the Mines app to use your account on this computer.");
            await window.desktopBridge.setMinesAccountToken(
              token ? JSON.stringify({ origin, token }) : null,
            );
          } else if (token) window.localStorage.setItem(key, token);
          else window.localStorage.removeItem(key);
        });
      return writeQueue;
    },
  };
}

export function MinesAuthProvider({ children }: { readonly children: ReactNode }) {
  const [origin] = useState(() => {
    const configured = minesControlUrl();
    if (!configured) throw new Error("Mines account service is not configured.");
    return new URL(configured).origin;
  });
  const [client] = useState(() => createMinesAccountClient(origin));
  const [storage] = useState(() => accountStorage(origin));
  const [user, setUser] = useState<MinesAccountUser | null>(null);
  const [isLoaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const tokenRef = useRef<string | null>(null);
  const revisionRef = useRef(0);
  const setSession = async (
    nextUser: MinesAccountUser | null,
    token: string | null,
    revision: number,
  ) => {
    if (revision !== revisionRef.current)
      throw new Error("Your account changed. Please try again.");
    await storage.write(token);
    if (revision !== revisionRef.current)
      throw new Error("Your account changed. Please try again.");
    tokenRef.current = token;
    setUser(nextUser);
    setError(null);
    setLoaded(true);
  };

  const refreshSession = useStableCallback(async () => {
    const revision = revisionRef.current;
    const token = await storage.read();
    const nextUser = token ? await client.getSession(token) : null;
    if (revision !== revisionRef.current) return;
    if (!nextUser && token) await storage.write(null);
    if (revision !== revisionRef.current) return;
    tokenRef.current = nextUser ? token : null;
    setUser(nextUser);
    setError(null);
    setLoaded(true);
  });

  useEffect(() => {
    let active = true;
    const restore = async () => {
      try {
        await refreshSession();
      } catch (cause) {
        if (active) {
          setError(errorMessage(cause));
          setLoaded(true);
        }
      }
    };
    void restore();
    const focus = () => void restore();
    const changed = (event: StorageEvent) => {
      if (event.key === storage.key) {
        revisionRef.current += 1;
        tokenRef.current = null;
        setUser(null);
        setLoaded(false);
        void restore();
      }
    };
    window.addEventListener("focus", focus);
    window.addEventListener("storage", changed);
    return () => {
      active = false;
      revisionRef.current += 1;
      window.removeEventListener("focus", focus);
      window.removeEventListener("storage", changed);
    };
  }, [refreshSession, storage]);

  const getToken = useStableCallback(async () => tokenRef.current);
  const signIn = async (credentials: Credentials) => {
    const revision = ++revisionRef.current;
    const result = await client.signIn(credentials);
    await setSession(result.user, result.token, revision);
  };
  const signUp = async (credentials: Credentials & { readonly name: string }) => {
    const revision = ++revisionRef.current;
    const result = await client.signUp(credentials);
    if (revision !== revisionRef.current)
      throw new Error("Your account changed. Please try again.");
    if (result.token) await setSession(result.user, result.token, revision);
    return result.token !== null;
  };
  const signOut = async () => {
    const token = tokenRef.current;
    const revision = ++revisionRef.current;
    tokenRef.current = null;
    setUser(null);
    await setSession(null, null, revision);
    if (token) {
      try {
        await client.signOut(token);
      } catch {
        throw new Error(
          "You are signed out on this device. The account service could not revoke the remote session. Reconnect and sign in again to manage access.",
        );
      }
    }
  };
  const openAccount = () => setAccountOpen(true);
  const value = {
    isLoaded,
    isSignedIn: user !== null,
    userId: user?.id ?? null,
    user,
    error,
    getToken,
    signIn,
    signUp,
    signOut,
    requestPasswordReset: client.requestPasswordReset,
    sendVerificationEmail: client.sendVerificationEmail,
    refreshSession,
    openAccount,
  };

  return (
    <MinesAuthContext value={value}>
      {children}
      <MinesAccountDialog open={accountOpen} onOpenChange={setAccountOpen} />
    </MinesAuthContext>
  );
}

export function useMinesAuth() {
  const context = use(MinesAuthContext);
  if (!context) throw new Error("Mines account controls require MinesAuthProvider.");
  return context;
}

export function useMinesUser() {
  const { user, isLoaded, isSignedIn } = useMinesAuth();
  return { user, isLoaded, isSignedIn };
}
