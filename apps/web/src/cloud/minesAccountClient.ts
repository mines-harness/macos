export interface MinesAccountUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly image?: string | null;
}

export class MinesAccountError extends Error {
  constructor(
    message: string,
    readonly code: string = "ACCOUNT_REQUEST_FAILED",
  ) {
    super(message);
    this.name = "MinesAccountError";
  }
}

const messages: Record<string, string> = {
  EMAIL_NOT_VERIFIED: "Verify your email before signing in. You can request a new email below.",
  INVALID_EMAIL_OR_PASSWORD: "The email or password is incorrect.",
  INVALID_PASSWORD: "The email or password is incorrect.",
  USER_NOT_FOUND: "The email or password is incorrect.",
  USER_ALREADY_EXISTS: "An account with this email already exists. Sign in or reset your password.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    "An account with this email already exists. Sign in or reset your password.",
  PASSWORD_TOO_SHORT: "Use a password with at least 12 characters.",
  PASSWORD_TOO_LONG: "Use a password with no more than 128 characters.",
  INVALID_EMAIL: "Enter a valid email address.",
  TOO_MANY_REQUESTS: "Too many attempts. Please wait a little before trying again.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readUser(value: unknown): MinesAccountUser | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.email !== "string" ||
    typeof value.emailVerified !== "boolean"
  )
    return null;
  return {
    id: value.id,
    name: value.name,
    email: value.email,
    emailVerified: value.emailVerified,
    ...(typeof value.image === "string" || value.image === null ? { image: value.image } : {}),
  };
}

export function createMinesAccountClient(baseUrl: string, fetchAccount: typeof fetch = fetch) {
  const origin = new URL(baseUrl).origin;
  const request = async (path: string, body?: unknown, token?: string, allowSignedOut = false) => {
    let response: Response;
    try {
      response = await fetchAccount(`${origin}/api/auth/${path}`, {
        method: body === undefined ? "GET" : "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new MinesAccountError(
        "Cannot reach the Mines account service. Check your connection and try again.",
        "CONNECTION_FAILED",
      );
    }
    const data: unknown = await response.json().catch(() => null);
    if (allowSignedOut && response.status === 401) return { data: null, token: null };
    if (!response.ok) {
      const code =
        isRecord(data) && typeof data.code === "string" ? data.code : "ACCOUNT_REQUEST_FAILED";
      throw new MinesAccountError(
        messages[code] ??
          (response.status === 429
            ? messages.TOO_MANY_REQUESTS!
            : "The account request could not be completed. Please try again."),
        code,
      );
    }
    return {
      data,
      token: response.headers.get("set-auth-token"),
    };
  };
  const readAccount = (data: unknown) => {
    const user = isRecord(data) ? readUser(data.user) : null;
    if (!user)
      throw new MinesAccountError(
        "The account service returned an incomplete session. Please try signing in again.",
      );
    return user;
  };
  return {
    async getSession(token: string) {
      const { data } = await request("get-session", undefined, token, true);
      return data === null ? null : readAccount(data);
    },
    async signIn(input: { readonly email: string; readonly password: string }) {
      const { data, token } = await request("sign-in/email", input);
      const user = readAccount(data);
      if (!token)
        throw new MinesAccountError(
          "The account service returned an incomplete session. Please try signing in again.",
        );
      return { user, token };
    },
    async signUp(input: {
      readonly name: string;
      readonly email: string;
      readonly password: string;
    }) {
      const { data, token } = await request("sign-up/email", {
        ...input,
        callbackURL: `${origin}/account-verified`,
      });
      return { user: readAccount(data), token };
    },
    async signOut(token: string) {
      await request("sign-out", {}, token, true);
    },
    async requestPasswordReset(email: string) {
      await request("request-password-reset", { email, redirectTo: `${origin}/reset-password` });
    },
    async sendVerificationEmail(email: string) {
      await request("send-verification-email", {
        email,
        callbackURL: `${origin}/account-verified`,
      });
    },
  };
}
