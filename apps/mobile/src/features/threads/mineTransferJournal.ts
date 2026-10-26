import { EnvironmentId, MineTransferId, ModelSelection, ThreadId } from "@t3tools/contracts";
import type { MineTransferRequest } from "@t3tools/client-runtime/mine-transfer";
import * as Schema from "effect/Schema";
import type { MobilePrivateStore } from "../../catalog/encryptedStorage";

const SavedTransfer = Schema.Struct({
  transferId: MineTransferId,
  threadId: ThreadId,
  sourceEnvironmentId: EnvironmentId,
  destinationEnvironmentId: EnvironmentId,
  modelSelection: ModelSelection,
  continueActive: Schema.Boolean,
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(SavedTransfer));

export function createMineTransferJournal(input: {
  readonly storage: Pick<MobilePrivateStore, "read" | "write" | "remove">;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const recordId = `mine-transfer:${JSON.stringify([input.environmentId, input.threadId])}`;
  const validate = (request: MineTransferRequest) => {
    if (
      request.sourceEnvironmentId !== input.environmentId ||
      request.threadId !== input.threadId ||
      request.destinationEnvironmentId === input.environmentId
    ) {
      throw new Error("This saved transfer belongs to a different mine or device.");
    }
    return request;
  };
  return {
    load: async (): Promise<MineTransferRequest | null> => {
      const bytes = await input.storage.read(recordId);
      return bytes === null ? null : validate(decode(new TextDecoder().decode(bytes)));
    },
    save: async (request: MineTransferRequest) => {
      validate(request);
      await input.storage.write(recordId, new TextEncoder().encode(JSON.stringify(request)));
    },
    clear: () => input.storage.remove(recordId),
  };
}
