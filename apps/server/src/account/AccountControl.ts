import { PeerDeviceDirectory } from "@t3tools/contracts/minesPeer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

export const AccountUser = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  emailVerified: Schema.Boolean,
});
export type AccountUser = typeof AccountUser.Type;

const DeviceCodeResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optionalKey(Schema.String),
  expires_in: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 })),
  interval: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
});
export interface DeviceCode {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number;
  readonly interval: number;
}

type TokenPoll =
  | { readonly _tag: "Pending"; readonly slowDown: boolean }
  | {
      readonly _tag: "Granted";
      readonly token: Redacted.Redacted<string>;
      readonly expiresIn: number;
    };

export class AccountControlError extends Schema.TaggedError<AccountControlError>()(
  "AccountControlError",
  {
    code: Schema.Literals([
      "unavailable",
      "invalid-response",
      "denied",
      "expired",
      "unauthorized",
      "unverified",
    ]),
  },
) {
  override get message() {
    switch (this.code) {
      case "denied":
        return "CLI sign-in was denied. Run `mines account login` to try again.";
      case "expired":
        return "The CLI sign-in code expired. Run `mines account login` to try again.";
      case "unauthorized":
        return "Your Mines account session expired or was revoked. Run `mines account login`.";
      case "unverified":
        return "Verify your account email before signing in to the Mines CLI.";
      case "invalid-response":
        return "The Mines account service returned an invalid response. Update the CLI or try again.";
      case "unavailable":
        return "The Mines account service is unreachable. Your saved account has been kept; retry when connected.";
    }
  }
}

export class AccountControl extends Context.Service<
  AccountControl,
  {
    readonly origin: string;
    readonly begin: Effect.Effect<DeviceCode, AccountControlError>;
    readonly poll: (deviceCode: string) => Effect.Effect<TokenPoll, AccountControlError>;
    readonly identity: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<Option.Option<AccountUser>, AccountControlError>;
    readonly devices: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<PeerDeviceDirectory, AccountControlError>;
    readonly signOut: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<void, AccountControlError>;
  }
>()("mines/account/AccountControl") {}

const TokenResponse = Schema.Struct({
  expires_in: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31_536_000 })),
});
const Failure = Schema.Struct({ error: Schema.optionalKey(Schema.String) });
const SessionResponse = Schema.NullOr(Schema.Struct({ user: AccountUser }));

export const layer = (origin: string) =>
  Layer.effect(
    AccountControl,
    Effect.gen(function* () {
      const url = yield* Effect.try({
        try: () => new URL(origin),
        catch: () => new AccountControlError({ code: "invalid-response" }),
      });
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        return yield* new AccountControlError({ code: "invalid-response" });
      }
      const http = yield* HttpClient.HttpClient;
      const request = Effect.fn("AccountControl.request")(function* (
        path: string,
        body?: unknown,
        token?: Redacted.Redacted<string>,
      ) {
        let input = HttpClientRequest.make(body === undefined ? "GET" : "POST")(
          `${url.origin}${path}`,
        ).pipe(HttpClientRequest.setHeader("accept", "application/json"));
        if (token) input = input.pipe(HttpClientRequest.bearerToken(Redacted.value(token)));
        if (body !== undefined)
          input = yield* HttpClientRequest.bodyJson(input, body).pipe(
            Effect.mapError(() => new AccountControlError({ code: "invalid-response" })),
          );
        const response = yield* http.execute(input).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "error",
            credentials: "omit",
          }),
          Effect.timeout("15 seconds"),
          Effect.mapError(() => new AccountControlError({ code: "unavailable" })),
        );
        const value = yield* response.json.pipe(
          Effect.mapError(() => new AccountControlError({ code: "invalid-response" })),
        );
        return { response, value };
      });
      const decode = <S extends Schema.Decoder<unknown>>(schema: S, value: unknown) =>
        Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.mapError(() => new AccountControlError({ code: "invalid-response" })),
        );
      const requireSuccess = Effect.fn("AccountControl.requireSuccess")(function* (status: number) {
        if (status === 401) return yield* new AccountControlError({ code: "unauthorized" });
        if (status < 200 || status >= 300)
          return yield* new AccountControlError({ code: "unavailable" });
      });
      return AccountControl.of({
        origin: url.origin,
        begin: request("/api/auth/device/code", {
          client_id: "mines-cli",
          scope: "openid profile email",
        }).pipe(
          Effect.flatMap(({ response, value }) =>
            Effect.gen(function* () {
              yield* requireSuccess(response.status);
              const data = yield* decode(DeviceCodeResponse, value);
              const approval = yield* Effect.try({
                try: () => {
                  const verification = new URL(data.verification_uri);
                  const complete = new URL(data.verification_uri_complete ?? data.verification_uri);
                  if (
                    verification.origin !== url.origin ||
                    complete.origin !== url.origin ||
                    verification.pathname !== "/device" ||
                    complete.pathname !== "/device" ||
                    verification.username ||
                    complete.username ||
                    verification.hash ||
                    complete.hash
                  )
                    throw new Error("Invalid approval URL");
                  return { verification, complete };
                },
                catch: () => new AccountControlError({ code: "invalid-response" }),
              });
              return {
                deviceCode: data.device_code,
                userCode: data.user_code,
                verificationUri: approval.verification.href,
                verificationUriComplete: approval.complete.href,
                expiresIn: data.expires_in,
                interval: data.interval,
              };
            }),
          ),
        ),
        poll: Effect.fn("AccountControl.poll")(function* (deviceCode) {
          const { response, value } = yield* request("/api/auth/device/token", {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: deviceCode,
            client_id: "mines-cli",
          });
          if (response.status >= 400) {
            const failure = yield* decode(Failure, value);
            if (failure.error === "authorization_pending" || failure.error === "slow_down")
              return { _tag: "Pending", slowDown: failure.error === "slow_down" } as const;
            if (failure.error === "access_denied")
              return yield* new AccountControlError({ code: "denied" });
            if (failure.error === "expired_token" || failure.error === "invalid_grant")
              return yield* new AccountControlError({ code: "expired" });
            return yield* new AccountControlError({ code: "unavailable" });
          }
          const data = yield* decode(TokenResponse, value);
          const token = response.headers["set-auth-token"];
          if (!token || !token.includes(".") || token.length > 16_384)
            return yield* new AccountControlError({ code: "invalid-response" });
          return {
            _tag: "Granted",
            token: Redacted.make(token),
            expiresIn: data.expires_in,
          } as const;
        }),
        identity: Effect.fn("AccountControl.identity")(function* (token) {
          const { response, value } = yield* request("/api/auth/get-session", undefined, token);
          if (response.status === 401) return Option.none();
          yield* requireSuccess(response.status);
          const session = yield* decode(SessionResponse, value);
          if (!session) return Option.none();
          if (!session.user.emailVerified)
            return yield* new AccountControlError({ code: "unverified" });
          return Option.some(session.user);
        }),
        devices: Effect.fn("AccountControl.devices")(function* (token) {
          const { response, value } = yield* request("/v1/devices", undefined, token);
          yield* requireSuccess(response.status);
          return yield* decode(PeerDeviceDirectory, value);
        }),
        signOut: Effect.fn("AccountControl.signOut")(function* (token) {
          const { response } = yield* request("/api/auth/sign-out", {}, token);
          if (response.status !== 401) yield* requireSuccess(response.status);
        }),
      });
    }),
  );
