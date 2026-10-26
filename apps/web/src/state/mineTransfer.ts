import type {
  MineTransferClient,
  MineTransferRequest,
} from "@t3tools/client-runtime/mine-transfer";
import { createMineTransferCommands } from "@t3tools/client-runtime/state/mine-transfer";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ModelSelection, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const mineTransferCommands = createMineTransferCommands(connectionAtomRuntime);

async function execute<W, A, E>(command: AtomCommand<W, A, E>, input: W): Promise<A> {
  const result = await runAtomCommand(appAtomRegistry, command, input, { reportFailure: false });
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  return result.value;
}

export function mineTransferClient(environmentId: EnvironmentId): MineTransferClient {
  return {
    preflight: (input) => execute(mineTransferCommands.preflight, { environmentId, input }),
    prepare: (input) => execute(mineTransferCommands.prepare, { environmentId, input }),
    readChunk: (input) => execute(mineTransferCommands.readChunk, { environmentId, input }),
    begin: (input) => execute(mineTransferCommands.begin, { environmentId, input }),
    writeChunk: (input) => execute(mineTransferCommands.writeChunk, { environmentId, input }),
    accept: (input) => execute(mineTransferCommands.accept, { environmentId, input }),
    finalize: (input) => execute(mineTransferCommands.finalize, { environmentId, input }),
    cancel: (input) => execute(mineTransferCommands.cancel, { environmentId, input }),
  };
}

const PendingTransfer = Schema.Struct({
  transferId: Schema.String,
  threadId: ThreadId,
  sourceEnvironmentId: EnvironmentId,
  destinationEnvironmentId: EnvironmentId,
  modelSelection: ModelSelection,
  continueActive: Schema.Boolean,
});
const decodePendingTransfer = Schema.decodeUnknownSync(Schema.fromJsonString(PendingTransfer));
const key = (source: { environmentId: EnvironmentId; threadId: ThreadId }) =>
  `mines:transfer:v1:${encodeURIComponent(source.environmentId)}:${encodeURIComponent(source.threadId)}`;

export function readPendingMineTransfer(source: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}): MineTransferRequest | null {
  try {
    const stored = globalThis.localStorage?.getItem(key(source));
    return stored ? decodePendingTransfer(stored) : null;
  } catch {
    return null;
  }
}

export function savePendingMineTransfer(input: MineTransferRequest): void {
  globalThis.localStorage.setItem(
    key({ environmentId: input.sourceEnvironmentId, threadId: input.threadId }),
    JSON.stringify(input),
  );
}

export function clearPendingMineTransfer(input: MineTransferRequest): void {
  globalThis.localStorage.removeItem(
    key({ environmentId: input.sourceEnvironmentId, threadId: input.threadId }),
  );
}
