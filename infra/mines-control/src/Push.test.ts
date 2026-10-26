import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { createPeerIdentity } from "@t3tools/shared/minesPeerTrust";
import { signMinesPushRequest, type MinesPushPayload } from "@t3tools/shared/minesPush";
import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as Push from "./Push.ts";
import * as PushStore from "./PushStore.ts";

const host = createPeerIdentity(new Uint8Array(32).fill(1), "Host");
const phone = createPeerIdentity(new Uint8Array(32).fill(2), "Phone");
const stranger = createPeerIdentity(new Uint8Array(32).fill(3), "Other account");
const harness = Effect.gen(function* () {
  const devices = new Map([
    [host.device.deviceId, { accountId: "one", publicKey: host.device.publicKey }],
    [phone.device.deviceId, { accountId: "one", publicKey: phone.device.publicKey }],
    [stranger.device.deviceId, { accountId: "two", publicKey: stranger.device.publicKey }],
  ]);
  const registrations = new Map<string, { account: string; token: string }>();
  const events = new Set<string>();
  const sent: Array<string> = [];
  const directory = DeviceDirectory.DeviceDirectory.of({
    initialize: Effect.void,
    owner: (id) => Effect.succeed(Option.fromNullishOr(devices.get(id))),
    list: () => Effect.succeed([]),
    register: () => Effect.void,
    revoke: (_account, id) =>
      Effect.sync(() => {
        devices.delete(id);
      }),
  });
  const store = PushStore.PushStore.of({
    initialize: Effect.void,
    register: (account, id, token) =>
      Effect.sync(() => {
        registrations.set(id, { account, token });
      }),
    remove: (_account, id) =>
      Effect.sync(() => {
        registrations.delete(id);
      }),
    targets: (account, sender) =>
      Effect.succeed(
        [...registrations]
          .filter(([id, value]) => value.account === account && id !== sender && devices.has(id))
          .map(([deviceId, value]) => ({ deviceId, token: value.token })),
      ),
    claim: (account, id) =>
      Effect.sync(() => {
        const key = account + id;
        if (events.has(key)) return false;
        events.add(key);
        return true;
      }),
  });
  const service = yield* Push.Push.pipe(
    Effect.provide(
      Push.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(DeviceDirectory.DeviceDirectory, directory),
            Layer.succeed(PushStore.PushStore, store),
            Layer.succeed(Push.PushDelivery, {
              enabled: true,
              send: (targets) =>
                Effect.sync(() => {
                  sent.push(...targets.map((target) => target.deviceId));
                  return { accepted: targets.length, invalidDevices: [] };
                }),
            }),
          ),
        ),
      ),
    ),
  );
  let count = 0;
  const request = (identity: typeof host, payload: MinesPushPayload) =>
    signMinesPushRequest(identity, payload, `nonce_${String(++count).padStart(16, "0")}`, 0);
  return { service, request, registrations, devices, sent };
});

it.effect(
  "requires account and key registration, isolates recipients, deduplicates and honors revocation",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const token = { action: "register" as const, token: "ExpoPushToken[abcdefghijk]" };
      expect((yield* h.service.execute(h.request(phone, token)).pipe(Effect.flip)).code).toBe(
        "unauthorized",
      );
      expect(
        (yield* h.service.execute(h.request(phone, token), "two").pipe(Effect.flip)).code,
      ).toBe("unauthorized");
      yield* h.service.execute(h.request(phone, token), "one");
      yield* h.service.execute(h.request(stranger, token), "two");
      const payload = {
        action: "alert" as const,
        eventId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000001",
        kind: "run-completed" as const,
      };
      const signed = h.request(host, payload);
      expect(yield* h.service.execute(signed)).toEqual({ accepted: 1, delivered: false });
      expect((yield* h.service.execute(signed).pipe(Effect.flip)).code).toBe("replayed");
      expect(yield* h.service.execute(h.request(host, payload))).toEqual({
        accepted: 0,
        delivered: false,
      });
      expect(h.sent).toEqual([phone.device.deviceId]);
      h.devices.delete(phone.device.deviceId);
      expect(
        yield* h.service.execute(
          h.request(host, { ...payload, eventId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000002" }),
        ),
      ).toEqual({ accepted: 0, delivered: false });
      h.devices.delete(host.device.deviceId);
      expect(yield* h.service.execute(h.request(host, { action: "remove" }))).toEqual({
        accepted: 0,
        delivered: false,
      });
      expect(
        (yield* h.service
          .execute(h.request(host, { ...payload, eventId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000003" }))
          .pipe(Effect.flip)).code,
      ).toBe("unauthorized");
    }),
);

it.effect("bounds accepted alerts per host and rejects arbitrary text", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    for (let i = 0; i < 12; i++)
      yield* h.service.execute(
        h.request(host, {
          action: "alert",
          eventId: `aaaaaaaa-bbbb-4ccc-8ddd-${String(i).padStart(12, "0")}`,
          kind: "needs-attention",
        }),
      );
    expect(
      (yield* h.service
        .execute(
          h.request(host, {
            action: "alert",
            eventId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000099",
            kind: "needs-attention",
          }),
        )
        .pipe(Effect.flip)).code,
    ).toBe("rate-limited");
    const signed = h.request(host, {
      action: "alert",
      eventId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000100",
      kind: "needs-attention",
    });
    expect(
      (yield* h.service.execute({ ...signed, title: "Secret title" }).pipe(Effect.flip)).code,
    ).toBe("invalid-request");
  }),
);

it.effect("does not contact Expo without credentials and reports acceptance, never delivery", () =>
  Effect.gen(function* () {
    let called = false;
    const disabled = Push.expoDelivery(undefined, () => {
      called = true;
      return Promise.reject(new Error("unexpected"));
    });
    expect(disabled.enabled).toBe(false);
    expect(
      (yield* disabled
        .send([], { eventId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000001", kind: "run-completed" })
        .pipe(Effect.flip)).code,
    ).toBe("disabled");
    expect(called).toBe(false);
    const enabled = Push.expoDelivery("own-expo-token", async (_url, input) => {
      expect(input?.headers).toMatchObject({ authorization: "Bearer own-expo-token" });
      expect(JSON.parse(String(input?.body))[0].data).toEqual({
        minesEventId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000001",
        kind: "run-completed",
      });
      return Response.json({
        data: [{ status: "ok" }, { status: "error", details: { error: "DeviceNotRegistered" } }],
      });
    });
    expect(
      yield* enabled.send(
        [
          { deviceId: "one", token: "ExpoPushToken[abcdefghijk]" },
          { deviceId: "two", token: "ExpoPushToken[lmnopqrstuv]" },
        ],
        { eventId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000001", kind: "run-completed" },
      ),
    ).toEqual({ accepted: 1, invalidDevices: ["two"] });
  }),
);
