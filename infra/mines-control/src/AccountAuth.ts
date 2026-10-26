import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { getMigrations } from "better-auth/db/migration";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import nodemailer from "nodemailer";
import { Pool } from "pg";

export class AccountAuthError extends Schema.TaggedError<AccountAuthError>()("AccountAuthError", {
  code: Schema.Literals(["unauthorized", "unavailable"]),
}) {}

export class AccountAuth extends Context.Service<
  AccountAuth,
  {
    readonly initialize: Effect.Effect<void, AccountAuthError>;
    readonly handle: (request: Request) => Effect.Effect<Response, AccountAuthError>;
    readonly accountId: (headers: Headers) => Effect.Effect<string, AccountAuthError>;
    readonly configuration: {
      readonly emailVerificationRequired: boolean;
      readonly passwordResetEnabled: boolean;
    };
  }
>()("@mines/control/AccountAuth") {}

export function createAccountAuth(config: {
  database: BetterAuthOptions["database"];
  baseURL: string;
  secret: string;
  origins: string[];
  sendEmail?:
    | ((message: { to: string; subject: string; text: string }) => Promise<void>)
    | undefined;
}) {
  if (config.secret.length < 32)
    throw new Error("MINES_AUTH_SECRET must contain at least 32 characters.");
  const publicURL = new URL(config.baseURL);
  if (publicURL.protocol !== "https:") throw new Error("MINES_AUTH_URL must use HTTPS.");
  const sendEmail = config.sendEmail;
  return betterAuth({
    appName: "Mines",
    database: config.database,
    secret: config.secret,
    baseURL: publicURL.origin,
    basePath: "/api/auth",
    trustedOrigins: config.origins,
    telemetry: { enabled: false },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/device/code") return;
        if (ctx.body.user_id !== undefined) {
          throw new APIError("BAD_REQUEST", {
            error: "invalid_request",
            error_description: "The approving account is selected in the verification page.",
          });
        }
        const scopes =
          typeof ctx.body.scope === "string" ? ctx.body.scope.trim().split(/\s+/).sort() : [];
        if (scopes.join(" ") !== "email openid profile") {
          throw new APIError("BAD_REQUEST", {
            error: "invalid_scope",
            error_description: "Mines CLI requires the openid, profile and email scopes.",
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/device/token" || !ctx.context.newSession) return;
        // Device grants omit the cookie that the signed-bearer hook reads.
        await setSessionCookie(ctx, ctx.context.newSession);
      }),
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: !!sendEmail,
      revokeSessionsOnPasswordReset: true,
      ...(sendEmail
        ? {
            sendResetPassword: async ({ user, url }) =>
              sendEmail({
                to: user.email,
                subject: "Reset your Mines password",
                text: `Reset your Mines password using this link:\n${url}\n\nIf you did not request this, ignore this email.`,
              }),
          }
        : {}),
    },
    ...(sendEmail
      ? {
          emailVerification: {
            sendOnSignUp: true,
            sendOnSignIn: true,
            autoSignInAfterVerification: false,
            sendVerificationEmail: async ({
              user,
              url,
            }: {
              user: { email: string };
              url: string;
            }) => {
              const link = new URL(url);
              link.searchParams.set(
                "callbackURL",
                `${publicURL.origin}/account-verified?verified=true`,
              );
              await sendEmail({
                to: user.email,
                subject: "Verify your Mines email",
                text: `Verify your email to sign in to Mines:\n${link.href}\n\nIf you did not create this account, ignore this email.`,
              });
            },
          },
        }
      : {}),
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 3 },
        "/send-verification-email": { window: 60, max: 3 },
        "/reset-password": { window: 60, max: 5 },
        "/device/code": { window: 60, max: 5 },
        "/device/approve": { window: 60, max: 5 },
        "/device/deny": { window: 60, max: 5 },
      },
    },
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: true,
      ipAddress: { ipAddressHeaders: ["x-real-ip"] },
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax" },
    },
    plugins: [
      deviceAuthorization({
        verificationUri: `${publicURL.origin}/device`,
        expiresIn: "5m",
        interval: "5s",
        validateClient: (clientId) => clientId === "mines-cli",
      }),
      bearer({ requireSignature: true }),
    ],
  });
}

export const layer = (config: {
  databaseURL: string;
  baseURL: string;
  secret: string;
  origins: string[];
  smtp?:
    | {
        host: string;
        port: number;
        from: string;
        user?: string | undefined;
        password?: string | undefined;
      }
    | undefined;
}) =>
  Layer.effect(
    AccountAuth,
    Effect.gen(function* () {
      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: config.databaseURL, max: 4 })),
        (value) => Effect.promise(() => value.end()),
      );
      const smtp = config.smtp;
      const mail = smtp
        ? nodemailer.createTransport({
            host: smtp.host,
            port: smtp.port,
            secure: smtp.port === 465,
            requireTLS: smtp.host !== "127.0.0.1" && smtp.host !== "localhost" && smtp.port !== 465,
            ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
            connectionTimeout: 10_000,
            socketTimeout: 10_000,
          })
        : undefined;
      const auth = createAccountAuth({
        ...config,
        database: pool,
        sendEmail:
          mail && smtp
            ? async (message) => {
                await mail.sendMail({ ...message, from: smtp.from });
              }
            : undefined,
      });
      return AccountAuth.of({
        configuration: { emailVerificationRequired: !!mail, passwordResetEnabled: !!mail },
        initialize: Effect.tryPromise({
          try: async () => {
            const migration = await getMigrations(auth.options);
            await migration.runMigrations();
          },
          catch: () => new AccountAuthError({ code: "unavailable" }),
        }),
        handle: Effect.fn("AccountAuth.handle")((request) =>
          Effect.tryPromise({
            try: () => auth.handler(request),
            catch: () => new AccountAuthError({ code: "unavailable" }),
          }),
        ),
        accountId: Effect.fn("AccountAuth.accountId")(function* (headers) {
          const authorization = headers.get("authorization");
          if (!authorization?.startsWith("Bearer ") || authorization.length > 16_384) {
            return yield* new AccountAuthError({ code: "unauthorized" });
          }
          const session = yield* Effect.tryPromise({
            try: () => auth.api.getSession({ headers: new Headers({ authorization }) }),
            catch: () => new AccountAuthError({ code: "unauthorized" }),
          });
          if (!session) return yield* new AccountAuthError({ code: "unauthorized" });
          return session.user.id;
        }),
      });
    }),
  );
