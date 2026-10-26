import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as AccountControl from "./AccountControl.ts";

const origin = "https://mines.example.test";
const code = {
  deviceCode: "private-device-code",
  userCode: "ABCD-1234",
  verificationUri: `${origin}/device`,
  verificationUriComplete: `${origin}/device?user_code=ABCD-1234`,
  expiresIn: 300,
  interval: 5,
};
const signedToken = "signed-session.opaque-signature";

function setup(
  replies: ReadonlyArray<{ status: number; body: unknown; headers?: Record<string, string> }>,
) {
  const requests: Array<{ url: string; authorization: string | undefined; body: string }> = [];
  let index = 0;
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      });
      const reply = replies[index++];
      if (!reply) throw new Error("Unexpected request");
      return HttpClientResponse.fromWeb(
        request,
        Response.json(reply.body, {
          status: reply.status,
          ...(reply.headers ? { headers: reply.headers } : {}),
        }),
      );
    }),
  );
  return {
    requests,
    layer: AccountControl.layer(origin).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    ),
  };
}

it.effect(
  "requests only the first-party device grant and rejects a substituted approval origin",
  () =>
    Effect.gen(function* () {
      const fixture = setup([
        {
          status: 200,
          body: {
            device_code: code.deviceCode,
            user_code: code.userCode,
            verification_uri: code.verificationUri,
            verification_uri_complete: "https://lookalike.example/device",
            expires_in: 300,
            interval: 5,
          },
        },
      ]);
      const result = yield* AccountControl.AccountControl.pipe(
        Effect.flatMap((control) => control.begin),
        Effect.exit,
        Effect.provide(fixture.layer),
      );
      expect(result._tag).toBe("Failure");
      expect(fixture.requests[0]?.url).toBe(`${origin}/api/auth/device/code`);
      expect(JSON.parse(fixture.requests[0]!.body)).toEqual({
        client_id: "mines-cli",
        scope: "openid profile email",
      });
    }),
);

it.effect("never treats the unsigned JSON token as a usable account credential", () =>
  Effect.gen(function* () {
    const fixture = setup([
      {
        status: 200,
        body: { access_token: "unsigned-private-session", token_type: "Bearer", expires_in: 60 },
      },
    ]);
    const result = yield* AccountControl.AccountControl.pipe(
      Effect.flatMap((control) => control.poll(code.deviceCode)),
      Effect.exit,
      Effect.provide(fixture.layer),
    );
    expect(result._tag).toBe("Failure");
  }),
);

it.effect("accepts only the signed response header and validates a verified account session", () =>
  Effect.gen(function* () {
    const user = {
      id: "account-one",
      name: "Pilot",
      email: "pilot@example.test",
      emailVerified: true,
    };
    const fixture = setup([
      {
        status: 200,
        body: { access_token: "unsigned", token_type: "Bearer", expires_in: 60 },
        headers: { "set-auth-token": signedToken },
      },
      { status: 200, body: { session: {}, user } },
    ]);
    yield* Effect.gen(function* () {
      const control = yield* AccountControl.AccountControl;
      const result = yield* control.poll(code.deviceCode);
      expect(result._tag).toBe("Granted");
      if (result._tag !== "Granted") return;
      expect(Redacted.value(result.token)).toBe(signedToken);
      const account = yield* control.identity(result.token);
      expect(Option.getOrThrow(account)).toEqual(user);
    }).pipe(Effect.provide(fixture.layer));
    expect(fixture.requests[1]?.authorization).toBe(`Bearer ${signedToken}`);
  }),
);

it.effect("keeps pending and slow-down responses distinct and recognizes a revoked session", () =>
  Effect.gen(function* () {
    const fixture = setup([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { status: 200, body: null },
    ]);
    yield* Effect.gen(function* () {
      const control = yield* AccountControl.AccountControl;
      expect(yield* control.poll(code.deviceCode)).toEqual({ _tag: "Pending", slowDown: false });
      expect(yield* control.poll(code.deviceCode)).toEqual({ _tag: "Pending", slowDown: true });
      expect(Option.isNone(yield* control.identity(Redacted.make(signedToken)))).toBe(true);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("does not follow redirects or attach ambient cookies to account requests", () =>
  Effect.gen(function* () {
    const requests: Array<RequestInit | undefined> = [];
    const fetch: typeof globalThis.fetch = async (_url, options) => {
      requests.push(options);
      return Response.json({
        device_code: code.deviceCode,
        user_code: code.userCode,
        verification_uri: code.verificationUri,
        expires_in: 300,
        interval: 5,
      });
    };
    yield* AccountControl.AccountControl.pipe(
      Effect.flatMap((control) => control.begin),
      Effect.provide(AccountControl.layer(origin).pipe(Layer.provide(FetchHttpClient.layer))),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.redirect).toBe("error");
    expect(requests[0]?.credentials).toBe("omit");
  }),
);
