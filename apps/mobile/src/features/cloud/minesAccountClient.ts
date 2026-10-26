import * as Schema from "effect/Schema";

const AccountUser = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  emailVerified: Schema.Boolean,
});
const decodeUser = Schema.decodeUnknownOption(AccountUser);
const AccountConfiguration = Schema.Struct({
  emailVerificationRequired: Schema.Boolean,
  passwordResetEnabled: Schema.Boolean,
});
const decodeConfiguration = Schema.decodeUnknownSync(AccountConfiguration);
export const defaultAccountConfiguration = {
  emailVerificationRequired: true,
  passwordResetEnabled: false,
};

export type MinesAccountUser = typeof AccountUser.Type;
export interface MinesAccountSession {
  readonly token: string;
  readonly user: MinesAccountUser;
}

interface TokenStorage {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
  readonly removeItem: (key: string) => Promise<void>;
}

class AccountRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function createMinesAccountClient(
  controlUrl: string,
  storage: TokenStorage,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
) {
  const origin = new URL(controlUrl).origin;
  const baseUrl = `${origin}/api/auth`;
  const storageKey = `mines.account.v1.${encodeURIComponent(origin).replaceAll("%", "_")}`;
  let revision = 0;
  let configuration = defaultAccountConfiguration;
  const request = async (path: string, body?: Record<string, unknown>, token?: string) => {
    const response = await fetcher(`${baseUrl}/${path}`, {
      method: body ? "POST" : "GET",
      credentials: "omit",
      headers: {
        Accept: "application/json",
        Origin: origin,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const message = record(value)?.message;
      throw new AccountRequestError(
        typeof message === "string" ? message : "The account request failed.",
        response.status,
      );
    }
    return { value: record(value), token: response.headers.get("set-auth-token") };
  };

  return {
    async getConfiguration() {
      const response = await fetcher(`${origin}/v1/auth-config`, {
        credentials: "omit",
        headers: { Accept: "application/json" },
      });
      if (!response.ok)
        throw new AccountRequestError("Could not load account options.", response.status);
      configuration = decodeConfiguration(await response.json());
      return configuration;
    },
    async restore(): Promise<MinesAccountSession | null> {
      const expected = revision;
      const token = await storage.getItem(storageKey);
      if (!token) return null;
      const result = await request("get-session", undefined, token).catch(
        async (error: unknown) => {
          if (error instanceof AccountRequestError && error.status === 401) {
            if (expected === revision) await storage.removeItem(storageKey);
            return null;
          }
          throw error;
        },
      );
      if (!result || expected !== revision) return null;
      const user = decodeUser(result.value?.user);
      if (
        !result.value?.session ||
        user._tag === "None" ||
        (configuration.emailVerificationRequired && !user.value.emailVerified)
      ) {
        await storage.removeItem(storageKey);
        return null;
      }
      const nextToken = result.token ?? token;
      if (nextToken !== token) await storage.setItem(storageKey, nextToken);
      return { token: nextToken, user: user.value };
    },
    async signIn(email: string, password: string): Promise<MinesAccountSession> {
      const expected = ++revision;
      const result = await request("sign-in/email", { email: email.trim(), password });
      if (expected !== revision) throw new Error("This sign-in request was cancelled.");
      const user = decodeUser(result.value?.user);
      const token = result.token;
      if (
        user._tag === "None" ||
        (configuration.emailVerificationRequired && !user.value.emailVerified)
      ) {
        throw new Error("Verify your email address before signing in.");
      }
      if (typeof token !== "string" || !token) {
        throw new Error("The account service did not return a session. Please try again.");
      }
      await storage.setItem(storageKey, token);
      return { token, user: user.value };
    },
    async signUp(name: string, email: string, password: string): Promise<void> {
      await request("sign-up/email", {
        name: name.trim(),
        email: email.trim(),
        password,
        callbackURL: `${origin}/account-verified`,
      });
    },
    async signOut(token: string | null): Promise<void> {
      revision += 1;
      await storage.removeItem(storageKey);
      if (token) await request("sign-out", {}, token);
    },
    async requestPasswordReset(email: string): Promise<void> {
      await request("request-password-reset", {
        email: email.trim(),
        redirectTo: `${origin}/reset-password`,
      });
    },
    async resendVerification(email: string): Promise<void> {
      await request("send-verification-email", {
        email: email.trim(),
        callbackURL: `${origin}/account-verified`,
      });
    },
  };
}
