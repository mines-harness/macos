import {
  genericMinesPushMessage,
  MinesPushError,
  verifyMinesPushRequest,
  type MinesPushKind,
} from "@t3tools/shared/minesPush";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as PushStore from "./PushStore.ts";

export class PushDelivery extends Context.Service<
  PushDelivery,
  {
    readonly enabled: boolean;
    readonly send: (
      targets: ReadonlyArray<{ deviceId: string; token: string }>,
      event: { eventId: string; kind: MinesPushKind },
    ) => Effect.Effect<{ accepted: number; invalidDevices: ReadonlyArray<string> }, MinesPushError>;
  }
>()("@mines/control/Push/PushDelivery") {}
const Tickets = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      status: Schema.Literals(["ok", "error"]),
      details: Schema.optionalKey(Schema.Struct({ error: Schema.optionalKey(Schema.String) })),
    }),
  ).check(Schema.isMaxLength(20)),
});
const encodeMessages = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeTickets = Schema.decodeUnknownSync(Schema.fromJsonString(Tickets));

export function expoDelivery(
  accessToken: string | undefined,
  fetcher: typeof fetch = fetch,
): PushDelivery["Service"] {
  const token = accessToken?.trim();
  return PushDelivery.of({
    enabled: Boolean(token),
    send: (targets, event) =>
      !token
        ? Effect.fail(new MinesPushError({ code: "disabled" }))
        : Effect.tryPromise({
            try: async () => {
              if (targets.length === 0) return { accepted: 0, invalidDevices: [] };
              const response = await fetcher("https://exp.host/--/api/v2/push/send", {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
                body: encodeMessages(
                  targets.map((target) => genericMinesPushMessage(target.token, event)),
                ),
                signal: AbortSignal.timeout(10_000),
                redirect: "error",
              });
              if (!response.ok) throw new MinesPushError({ code: "unavailable" });
              const text = await response.text();
              if (text.length > 16384) throw new MinesPushError({ code: "unavailable" });
              const result = decodeTickets(text);
              if (result.data.length !== targets.length)
                throw new MinesPushError({ code: "unavailable" });
              return {
                accepted: result.data.filter((ticket) => ticket.status === "ok").length,
                invalidDevices: result.data.flatMap((ticket, index) =>
                  ticket.details?.error === "DeviceNotRegistered" ? [targets[index]!.deviceId] : [],
                ),
              };
            },
            catch: () => new MinesPushError({ code: "unavailable" }),
          }),
  });
}
export class Push extends Context.Service<
  Push,
  {
    readonly enabled: boolean;
    readonly execute: (
      value: unknown,
      account?: string,
    ) => Effect.Effect<{ accepted: number; delivered: false }, MinesPushError>;
  }
>()("@mines/control/Push") {}

export const layer = Layer.effect(
  Push,
  Effect.gen(function* () {
    const directory = yield* DeviceDirectory.DeviceDirectory;
    const store = yield* PushStore.PushStore;
    const delivery = yield* PushDelivery;
    let activeDeliveries = 0;
    const proofs = new Map<string, number>();
    const rates = new Map<string, { expires: number; count: number }>();
    return Push.of({
      enabled: delivery.enabled,
      execute: Effect.fn("Push.execute")(function* (value, account) {
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const request = yield* Effect.try({
          try: () => verifyMinesPushRequest(value, now),
          catch: () => new MinesPushError({ code: "invalid-request" }),
        });
        for (const [key, expiry] of proofs) if (expiry < now) proofs.delete(key);
        for (const [key, rate] of rates) if (rate.expires < now) rates.delete(key);
        const proofId = `${request.deviceId}:${request.nonce}`;
        if (proofs.has(proofId) || proofs.size >= 10_000)
          return yield* new MinesPushError({ code: "replayed" });
        proofs.set(proofId, now + 75);
        const owner = yield* directory
          .owner(request.deviceId)
          .pipe(Effect.mapError(() => new MinesPushError({ code: "unauthorized" })));
        // A revoked/missing membership cannot receive alerts. A valid device signature may
        // acknowledge an already completed removal so offline phone opt-out can finish.
        if (Option.isNone(owner) && request.payload.action === "remove")
          return { accepted: 0, delivered: false };
        if (
          Option.isNone(owner) ||
          owner.value.publicKey !== request.publicKey ||
          (account !== undefined && account !== owner.value.accountId)
        )
          return yield* new MinesPushError({ code: "unauthorized" });
        const accountId = owner.value.accountId;
        const payload = request.payload;
        if (payload.action === "remove") {
          yield* store.remove(accountId, request.deviceId);
          return { accepted: 0, delivered: false };
        }
        if (!delivery.enabled) return yield* new MinesPushError({ code: "disabled" });
        for (const [key, limit] of [
          [`account:${accountId}`, 60],
          [`device:${request.deviceId}`, 12],
        ] as const) {
          const bucket = rates.get(key) ?? { expires: now + 60, count: 0 };
          if (++bucket.count > limit || rates.size >= 10_000)
            return yield* new MinesPushError({ code: "rate-limited" });
          rates.set(key, bucket);
        }
        if (payload.action === "register") {
          if (!account) return yield* new MinesPushError({ code: "unauthorized" });
          yield* store.register(accountId, request.deviceId, payload.token);
          return { accepted: 0, delivered: false };
        }
        if (activeDeliveries >= 4) return yield* new MinesPushError({ code: "rate-limited" });
        activeDeliveries++;
        return yield* Effect.gen(function* () {
          if (!(yield* store.claim(accountId, payload.eventId)))
            return { accepted: 0, delivered: false as const };
          const targets = yield* store.targets(accountId, request.deviceId);
          const result = yield* delivery.send(targets, payload);
          for (const id of result.invalidDevices) yield* store.remove(accountId, id);
          return { accepted: result.accepted, delivered: false as const };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              activeDeliveries--;
            }),
          ),
        );
      }),
    });
  }),
);
