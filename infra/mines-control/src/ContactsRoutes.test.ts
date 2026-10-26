import { expect, it } from "@effect/vitest";
import { ContactsError, type ContactsSnapshot } from "@t3tools/contracts/contacts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AccountAuth from "./AccountAuth.ts";
import * as Contacts from "./Contacts.ts";
import { handleContactsRequest } from "./ContactsRoutes.ts";

const snapshot: ContactsSnapshot = {
  profile: { friendId: "mines-11111111111111111111", displayName: "A name", avatar: null },
  contacts: [],
  groups: [],
  invitations: [],
};
const auth = Layer.mock(AccountAuth.AccountAuth, {
  configuration: { emailVerificationRequired: false, passwordResetEnabled: false },
  accountId: (headers) =>
    headers.get("authorization") === "Bearer valid-session"
      ? Effect.succeed("authenticated-account")
      : Effect.fail(new AccountAuth.AccountAuthError({ code: "unauthorized" })),
});

it.effect("requires an account session for every contact and invitation mutation", () =>
  Effect.gen(function* () {
    const service = Layer.mock(Contacts.Contacts, {});
    for (const pathname of [
      "/v1/contacts/profile",
      "/v1/contacts/add",
      "/v1/contacts/remove",
      "/v1/contacts/groups",
      "/v1/group-invitations",
      "/v1/group-invitations/an-invite/accept",
      "/v1/group-invitations/an-invite/decline",
      "/v1/group-invitations/an-invite/revoke",
      "/v1/group-invitations/an-invite/leave",
    ]) {
      const result = yield* handleContactsRequest({
        pathname,
        method: "POST",
        headers: new Headers(),
        body: {},
      }).pipe(Effect.provide(Layer.merge(auth, service)));
      expect(result).toMatchObject({ status: 401, value: { error: "unauthorized" } });
    }
  }),
);

it.effect("takes the mutation account only from the verified session", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const service = Layer.mock(Contacts.Contacts, {
      addContact: (accountId) =>
        Effect.sync(() => {
          calls.push(accountId);
          return snapshot;
        }),
      transition: (accountId, id, action) =>
        Effect.sync(() => {
          calls.push(`${accountId}:${id}:${action}`);
          return snapshot;
        }),
    });
    const headers = new Headers({ authorization: "Bearer valid-session" });
    const add = yield* handleContactsRequest({
      pathname: "/v1/contacts/add",
      method: "POST",
      headers,
      body: { friendId: "mines-22222222222222222222", accountId: "victim" },
    }).pipe(Effect.provide(Layer.merge(auth, service)));
    expect(add).toEqual({ status: 200, value: snapshot });
    yield* handleContactsRequest({
      pathname: "/v1/group-invitations/invite-1/accept",
      method: "POST",
      headers,
      body: { accountId: "victim" },
    }).pipe(Effect.provide(Layer.merge(auth, service)));
    expect(calls).toEqual(["authenticated-account", "authenticated-account:invite-1:accept"]);
  }),
);

it.effect("returns bounded safe failures without reflecting internal exception data", () =>
  Effect.gen(function* () {
    const service = Layer.mock(Contacts.Contacts, {
      snapshot: () => Effect.fail(new ContactsError({ code: "storage" })),
    });
    const result = yield* handleContactsRequest({
      pathname: "/v1/contacts",
      method: "GET",
      headers: new Headers({ authorization: "Bearer valid-session" }),
    }).pipe(Effect.provide(Layer.merge(auth, service)));
    expect(result).toEqual({
      status: 503,
      value: {
        error: "storage",
        message: "Contacts are temporarily unavailable. Try again shortly.",
      },
    });
  }),
);
