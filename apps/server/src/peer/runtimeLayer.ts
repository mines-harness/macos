import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PeerTrustStore from "./PeerTrustStore.ts";
import * as PeerHost from "./PeerHost.ts";
import * as PeerManagement from "./PeerManagement.ts";
import * as HostSignalingService from "./HostSignalingService.ts";

export const layerTrust = PeerTrustStore.layer;
const layerHost = PeerHost.layer.pipe(Layer.provide(layerTrust));
export const layerSignaling = HostSignalingService.layer.pipe(
  Layer.provide(Layer.merge(layerHost, layerTrust)),
);
export const layer = Layer.mergeAll(
  layerTrust,
  layerHost,
  layerSignaling,
  PeerManagement.layer.pipe(Layer.provide(Layer.mergeAll(layerHost, layerTrust, layerSignaling))),
  Layer.effectDiscard(
    Effect.flatMap(HostSignalingService.HostSignalingService, (service) => service.start).pipe(
      Effect.catch((error) => Effect.logWarning(error.message)),
    ),
  ).pipe(Layer.provide(layerSignaling)),
);
