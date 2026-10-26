import {
  ContactFriendInput,
  ContactGroupAccessInput,
  ContactGroupCreateInput,
  ContactGroupInviteInput,
  ContactProfileUpdate,
  ContactsError,
  GroupInvitationAction,
} from "@t3tools/contracts/contacts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as AccountAuth from "./AccountAuth.ts";
import * as Contacts from "./Contacts.ts";

const decodeProfile = Schema.decodeUnknownEffect(ContactProfileUpdate);
const decodeFriend = Schema.decodeUnknownEffect(ContactFriendInput);
const decodeGroup = Schema.decodeUnknownEffect(ContactGroupCreateInput);
const decodeAccess = Schema.decodeUnknownEffect(ContactGroupAccessInput);
const decodeInvite = Schema.decodeUnknownEffect(ContactGroupInviteInput);
const decodeAction = Schema.decodeUnknownEffect(GroupInvitationAction);
const isContactsError = Schema.is(ContactsError);

export interface ContactsRequest {
  readonly pathname: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body?: unknown;
}
export const isContactsPath = (pathname: string) =>
  pathname === "/v1/contacts" ||
  pathname.startsWith("/v1/contacts/") ||
  pathname === "/v1/group-invitations" ||
  pathname.startsWith("/v1/group-invitations/");
export const handleContactsRequest = Effect.fn("ContactsRoutes.handle")(
  function* (request: ContactsRequest) {
    const service = yield* Contacts.Contacts;
    if (request.pathname === "/v1/contacts/device-group-access" && request.method === "POST")
      return { status: 200, value: yield* service.deviceGroupAccess(request.body) };
    const auth = yield* AccountAuth.AccountAuth;
    const accountId = yield* auth.accountId(request.headers);
    const invalid = () => new ContactsError({ code: "invalid-input" });
    if (request.pathname === "/v1/contacts" && request.method === "GET")
      return { status: 200, value: yield* service.snapshot(accountId) };
    if (request.method !== "POST") return { status: 404, value: { error: "not-found" } };
    if (request.pathname === "/v1/contacts/profile") {
      const input = yield* decodeProfile(request.body).pipe(Effect.mapError(invalid));
      return { status: 200, value: yield* service.updateProfile(accountId, input) };
    }
    if (request.pathname === "/v1/contacts/add" || request.pathname === "/v1/contacts/remove") {
      const input = yield* decodeFriend(request.body).pipe(Effect.mapError(invalid));
      return {
        status: 200,
        value: yield* request.pathname.endsWith("/add")
          ? service.addContact(accountId, input)
          : service.removeContact(accountId, input),
      };
    }
    if (request.pathname === "/v1/contacts/groups") {
      const input = yield* decodeGroup(request.body).pipe(Effect.mapError(invalid));
      return { status: 200, value: yield* service.registerGroup(accountId, input) };
    }
    if (request.pathname === "/v1/contacts/group-access") {
      const input = yield* decodeAccess(request.body).pipe(Effect.mapError(invalid));
      return { status: 200, value: yield* service.groupAccess(accountId, input) };
    }
    if (request.pathname === "/v1/group-invitations") {
      const input = yield* decodeInvite(request.body).pipe(Effect.mapError(invalid));
      return { status: 200, value: yield* service.invite(accountId, input) };
    }
    const action = request.pathname.match(
      /^\/v1\/group-invitations\/([^/]+)\/(accept|decline|revoke|leave)$/,
    );
    if (action) {
      const id = yield* Effect.try({ try: () => decodeURIComponent(action[1]!), catch: invalid });
      const decision = yield* decodeAction(action[2]).pipe(Effect.mapError(invalid));
      return { status: 200, value: yield* service.transition(accountId, id, decision) };
    }
    return { status: 404, value: { error: "not-found" } };
  },
  Effect.catch((error) =>
    Effect.succeed(
      isContactsError(error)
        ? {
            status: {
              "invalid-input": 400,
              "not-found": 404,
              forbidden: 403,
              conflict: 409,
              storage: 503,
              limit: 409,
            }[error.code],
            value: { error: error.code, message: error.message },
          }
        : { status: error.code === "unauthorized" ? 401 : 503, value: { error: error.code } },
    ),
  ),
);
