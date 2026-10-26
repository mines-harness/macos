import { memoryAdapter } from "better-auth/adapters/memory";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { createAccountAuth } from "./AccountAuth.ts";

const baseURL = "https://mines.gemstud.io";
const password = "correct horse battery staple 123";

function setup(verify = false) {
  const records: Record<string, Array<Record<string, unknown>>> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    rateLimit: [],
    deviceCode: [],
  };
  const messages: Array<{ to: string; subject: string; text: string }> = [];
  const auth = createAccountAuth({
    database: memoryAdapter(records),
    baseURL,
    secret: "isolated-test-secret-of-at-least-32-characters",
    origins: [baseURL, "mines://app", "mines-dev://app"],
    sendEmail: verify
      ? async (message) => {
          messages.push(message);
        }
      : undefined,
  });
  const call = (path: string, body?: unknown, token?: string, origin = "mines://app") =>
    auth.handler(
      new Request(`${baseURL}/api/auth/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(origin ? { origin } : {}),
          "x-real-ip": "192.0.2.1",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { auth, call, records, messages };
}

it("creates an account, stores a password hash, accepts bearer sessions and revokes sign-out", async () => {
  const { auth, call, records } = setup();
  const signup = await call("sign-up/email", {
    name: "Pilot",
    email: "pilot@example.com",
    password,
  });
  expect(signup.status).toBe(200);
  const token = signup.headers.get("set-auth-token");
  const signupData = await signup.json();
  expect(token).toBeTruthy();
  expect(records.account?.[0]?.password).toBeTypeOf("string");
  expect(records.account?.[0]?.password).not.toBe(password);
  expect(
    await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${signupData.token}` }),
    }),
  ).toBeNull();
  expect(
    (await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) }))
      ?.user.id,
  ).toBe(signupData.user.id);
  const session = await call("get-session", undefined, token!);
  expect((await session.json()).user.email).toBe("pilot@example.com");
  const wrong = await call("sign-in/email", {
    email: "pilot@example.com",
    password: "wrong password",
  });
  expect(wrong.status).toBe(401);
  const signin = await call("sign-in/email", { email: "pilot@example.com", password });
  expect(signin.status).toBe(200);
  const signedInToken = signin.headers.get("set-auth-token")!;
  expect((await call("sign-out", {}, signedInToken)).status).toBe(200);
  expect(await (await call("get-session", undefined, signedInToken)).json()).toBeNull();
  expect(
    await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${signedInToken}` }),
    }),
  ).toBeNull();
});

const cliRequest = { client_id: "mines-cli", scope: "openid profile email" };
const grantType = "urn:ietf:params:oauth:grant-type:device_code";

async function signedInAccount(
  call: ReturnType<typeof setup>["call"],
  email = "pilot@example.com",
) {
  const response = await call("sign-up/email", { name: "Pilot", email, password });
  expect(response.status).toBe(200);
  return response.headers.get("set-auth-token")!;
}

it("requires explicit device approval and issues only a signed CLI bearer session once", async () => {
  const { auth, call } = setup();
  const account = await signedInAccount(call);
  const requested = await call("device/code", cliRequest, undefined, "");
  expect(requested.status).toBe(200);
  const code = await requested.json();
  expect(code.expires_in).toBe(300);
  expect(code.interval).toBe(5);
  expect(new URL(code.verification_uri_complete).pathname).toBe("/device");
  expect((await call("device/approve", { userCode: code.user_code })).status).toBe(401);
  expect((await call("device/approve", { userCode: code.user_code }, account)).status).toBe(400);
  const reviewed = await call(`device?user_code=${code.user_code}`, undefined, account);
  expect(reviewed.status).toBe(200);
  expect(await reviewed.json()).toMatchObject({
    client_id: "mines-cli",
    status: "pending",
    scope: cliRequest.scope,
  });
  expect((await call("device/approve", { userCode: code.user_code }, account)).status).toBe(200);
  const tokenRequest = {
    grant_type: grantType,
    device_code: code.device_code,
    client_id: cliRequest.client_id,
  };
  const issued = await call("device/token", tokenRequest, undefined, "");
  expect(issued.status).toBe(200);
  const issuedData = await issued.json();
  const signedToken = issued.headers.get("set-auth-token");
  expect(signedToken).toBeTruthy();
  expect(
    await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${issuedData.access_token}` }),
    }),
  ).toBeNull();
  const session = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${signedToken}` }),
  });
  expect(session?.user.email).toBe("pilot@example.com");
  expect((await call("device/token", tokenRequest)).status).toBe(400);
  expect((await call("sign-out", {}, signedToken!)).status).toBe(200);
  expect(
    await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${signedToken}` }) }),
  ).toBeNull();
});

it("rejects unknown CLI clients, unsupported scopes and client-supplied account bindings", async () => {
  const { call, records } = setup();
  for (const request of [
    { ...cliRequest, client_id: "other-client" },
    { ...cliRequest, scope: "openid admin" },
    { ...cliRequest, user_id: "somebody-else" },
  ]) {
    expect((await call("device/code", request)).status).toBe(400);
  }
  expect(records.deviceCode).toEqual([]);
});

it("only lets the account that reviewed a device code approve or deny it", async () => {
  const { call } = setup();
  const owner = await signedInAccount(call);
  const other = await signedInAccount(call, "other@example.com");
  const code = await (await call("device/code", cliRequest)).json();
  expect((await call(`device?user_code=${code.user_code}`, undefined, owner)).status).toBe(200);
  expect((await call("device/approve", { userCode: code.user_code }, other)).status).toBe(403);
  expect((await call("device/deny", { userCode: code.user_code }, other)).status).toBe(403);
  expect((await call("device/deny", { userCode: code.user_code }, owner)).status).toBe(200);
  const denied = await call("device/token", {
    grant_type: grantType,
    device_code: code.device_code,
    client_id: cliRequest.client_id,
  });
  expect(denied.status).toBe(400);
  expect(await denied.json()).toMatchObject({ error: "access_denied" });
});

it("keeps pending device codes private, enforces polling intervals and expires them", async () => {
  const { call, records } = setup();
  const requested = await call("device/code", cliRequest);
  expect(requested.status).toBe(200);
  const code = await requested.json();
  const publicReview = await call(`device?user_code=${code.user_code}`);
  expect(publicReview.status).toBe(200);
  const publicDetails = await publicReview.json();
  expect(publicDetails).not.toHaveProperty("client_id");
  expect(publicDetails).not.toHaveProperty("scope");
  expect(publicDetails).not.toHaveProperty("device_code");
  expect(records.deviceCode?.[0]?.userId).toBeNull();
  const poll = {
    grant_type: grantType,
    device_code: code.device_code,
    client_id: cliRequest.client_id,
  };
  const pending = await call("device/token", poll);
  expect(await pending.json()).toMatchObject({ error: "authorization_pending" });
  const tooSoon = await call("device/token", poll);
  expect(await tooSoon.json()).toMatchObject({ error: "slow_down" });
  expect(tooSoon.headers.get("set-auth-token")).toBeNull();
  const expiredCode = await (await call("device/code", cliRequest)).json();
  records.deviceCode!.find((row) => row.deviceCode === expiredCode.device_code)!.expiresAt =
    DateTime.toDateUtc(DateTime.makeUnsafe(0));
  const expired = await call("device/token", { ...poll, device_code: expiredCode.device_code });
  expect(await expired.json()).toMatchObject({ error: "expired_token" });
  expect(expired.headers.get("set-auth-token")).toBeNull();
});

it("limits device-code issuance independently from account sign-in", async () => {
  const { call } = setup();
  for (let attempt = 0; attempt < 5; attempt++)
    expect((await call("device/code", cliRequest)).status).toBe(200);
  expect((await call("device/code", cliRequest)).status).toBe(429);
});

it("rejects signup from an untrusted origin", async () => {
  const { call, records } = setup();
  const response = await call(
    "sign-up/email",
    { name: "Pilot", email: "pilot@example.com", password },
    undefined,
    "https://untrusted.example",
  );
  expect(response.status).toBe(403);
  expect(records.user ?? []).toEqual([]);
});

it("limits repeated signup requests before creating accounts", async () => {
  const { call, records } = setup();
  for (let attempt = 0; attempt < 5; attempt++) {
    expect(
      (await call("sign-up/email", { name: "Pilot", email: "invalid", password })).status,
    ).toBe(400);
  }
  expect((await call("sign-up/email", { name: "Pilot", email: "invalid", password })).status).toBe(
    429,
  );
  expect(records.user).toEqual([]);
});

it("requires email verification when mail is configured and revokes sessions on password reset", async () => {
  const { auth, call, messages } = setup(true);
  const signup = await call("sign-up/email", {
    name: "Pilot",
    email: "pilot@example.com",
    password,
  });
  expect(signup.status).toBe(200);
  expect(signup.headers.get("set-auth-token")).toBeNull();
  expect((await call("sign-in/email", { email: "pilot@example.com", password })).status).toBe(403);
  expect(messages[0]?.to).toBe("pilot@example.com");
  const verificationURL = messages[0]!.text.match(/https:\/\/\S+/)![0];
  expect(new URL(verificationURL).origin).toBe(baseURL);
  const verified = await auth.handler(new Request(verificationURL));
  expect([200, 302]).toContain(verified.status);
  const signin = await call("sign-in/email", { email: "pilot@example.com", password });
  const token = signin.headers.get("set-auth-token")!;
  expect(token).toBeTruthy();
  expect(
    (
      await call("request-password-reset", {
        email: "pilot@example.com",
        redirectTo: `${baseURL}/account?mode=reset`,
      })
    ).status,
  ).toBe(200);
  const resetURL = messages.at(-1)!.text.match(/https:\/\/\S+/)![0];
  const follow = await auth.handler(new Request(resetURL));
  const resetToken = new URL(follow.headers.get("location")!).searchParams.get("token");
  expect(resetToken).toBeTruthy();
  expect(
    (await call("reset-password", { token: resetToken, newPassword: `${password} changed` }))
      .status,
  ).toBe(200);
  expect(await (await call("get-session", undefined, token)).json()).toBeNull();
  expect((await call("sign-in/email", { email: "pilot@example.com", password })).status).toBe(401);
  expect(
    (await call("sign-in/email", { email: "pilot@example.com", password: `${password} changed` }))
      .status,
  ).toBe(200);
});
