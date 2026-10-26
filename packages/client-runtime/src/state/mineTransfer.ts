import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createMineTransferCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    preflight: createEnvironmentRpcCommand(runtime, {
      label: "mine-transfer:preflight",
      tag: WS_METHODS.mineTransferPreflight,
    }),
    prepare: createEnvironmentRpcCommand(runtime, {
      label: "mine-transfer:prepare",
      tag: WS_METHODS.mineTransferPrepare,
    }),
    readChunk: createEnvironmentRpcCommand(runtime, {
      label: "mine-transfer:read-chunk",
      tag: WS_METHODS.mineTransferReadChunk,
    }),
    begin: createEnvironmentRpcCommand(runtime, {
      label: "mine-transfer:begin",
      tag: WS_METHODS.mineTransferBegin,
    }),
    writeChunk: createEnvironmentRpcCommand(runtime, {
      label: "mine-transfer:write-chunk",
      tag: WS_METHODS.mineTransferWriteChunk,
    }),
    accept: createEnvironmentRpcCommand(runtime, {
      label: "mine-transfer:accept",
      tag: WS_METHODS.mineTransferAccept,
    }),
    finalize: createEnvironmentRpcCommand(runtime, {
      label: "mine-transfer:finalize",
      tag: WS_METHODS.mineTransferFinalize,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "mine-transfer:cancel",
      tag: WS_METHODS.mineTransferCancel,
    }),
  };
}
