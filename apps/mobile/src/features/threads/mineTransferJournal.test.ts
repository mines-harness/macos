import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { MineTransferRequest } from "@t3tools/client-runtime/mine-transfer";
import { describe, expect, it } from "vite-plus/test";
import { createMineTransferJournal } from "./mineTransferJournal";

function fixture() {
  const records = new Map<string, Uint8Array>();
  const storage = {
    read: async (id: string) => records.get(id) ?? null,
    write: async (id: string, bytes: Uint8Array) => {
      records.set(id, bytes);
    },
    remove: async (id: string) => {
      records.delete(id);
    },
  };
  const request: MineTransferRequest = {
    transferId: "transfer-123",
    sourceEnvironmentId: EnvironmentId.make("mac"),
    destinationEnvironmentId: EnvironmentId.make("vps"),
    threadId: ThreadId.make("mine"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
    continueActive: true,
  };
  const input = { storage, environmentId: request.sourceEnvironmentId, threadId: request.threadId };
  return { input, request };
}

describe("mobile mine transfer recovery", () => {
  it("reopens an uncertain transfer with its original identity, destination and model", async () => {
    const { input, request } = fixture();
    await createMineTransferJournal(input).save(request);
    expect(await createMineTransferJournal(input).load()).toEqual(request);
    await createMineTransferJournal(input).clear();
    expect(await createMineTransferJournal(input).load()).toBeNull();
  });

  it("isolates mines and rejects a record for another source", async () => {
    const { input, request } = fixture();
    const journal = createMineTransferJournal(input);
    await journal.save(request);
    expect(
      await createMineTransferJournal({ ...input, threadId: ThreadId.make("other-mine") }).load(),
    ).toBeNull();
    await expect(
      journal.save({ ...request, sourceEnvironmentId: EnvironmentId.make("other-device") }),
    ).rejects.toThrow("different mine or device");
    expect(await journal.load()).toEqual(request);
  });

  it("surfaces a persistence failure before allowing a network transfer", async () => {
    const { input, request } = fixture();
    const journal = createMineTransferJournal({
      ...input,
      storage: {
        ...input.storage,
        write: async () => {
          throw new Error("Phone locked");
        },
      },
    });
    await expect(journal.save(request)).rejects.toThrow("Phone locked");
    expect(await journal.load()).toBeNull();
  });
});
