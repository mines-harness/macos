import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MineTransferManifest,
  type MineTransferReceipt,
  type MineTransferStatus,
} from "@t3tools/contracts";
import {
  cancelMineTransfer,
  transferMine,
  type MineTransferClient,
  type MineTransferProgress,
  type MineTransferRequest,
} from "./mineTransfer.ts";

function setup() {
  const input: MineTransferRequest = {
    transferId: "transfer-12345678",
    threadId: ThreadId.make("source-mine"),
    sourceEnvironmentId: EnvironmentId.make("mac"),
    destinationEnvironmentId: EnvironmentId.make("ovh"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
    continueActive: true,
  };
  const manifest: MineTransferManifest = {
    version: 1,
    transferId: input.transferId,
    sourceEnvironmentId: input.sourceEnvironmentId,
    destinationEnvironmentId: input.destinationEnvironmentId,
    sourceThreadId: input.threadId,
    title: "Fix the widget",
    projectTitle: "Widget",
    modelSelection: input.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    history: [{ role: "user", text: "Continue the widget fix." }],
    wasActive: true,
    workspace: {
      version: 1,
      transferId: input.transferId,
      repositoryId: "root",
      sourceHead: "head",
      snapshotCommit: "snapshot",
      snapshotTree: "tree",
      snapshotRef: "refs/t3/handoffs/transfer-12345678",
      bundleSha256: "a".repeat(64),
      bundleBytes: 6,
    },
  };
  const receipt: MineTransferReceipt = {
    transferId: input.transferId,
    destinationEnvironmentId: input.destinationEnvironmentId,
    projectId: ProjectId.make("destination-project"),
    threadId: ThreadId.make("destination-mine"),
  };
  const status: MineTransferStatus = {
    transferId: input.transferId,
    role: "destination",
    status: "receiving",
    receivedBytes: 0,
    manifest,
  };
  const calls: string[] = [];
  const client: MineTransferClient = {
    preflight: vi.fn(async () => {
      calls.push("preflight");
      return { environmentId: input.destinationEnvironmentId, maxBundleBytes: 100, chunkBytes: 3 };
    }),
    prepare: vi.fn(async () => {
      calls.push("prepare");
      return { ...status, role: "source" as const, status: "prepared" as const };
    }),
    readChunk: vi.fn(async ({ offset }) => {
      calls.push(`read:${offset}`);
      return { offset, data: "YWJj", totalBytes: 6 };
    }),
    begin: vi.fn(async () => {
      calls.push("begin");
      return status;
    }),
    writeChunk: vi.fn(async ({ offset }) => {
      calls.push(`write:${offset}`);
      return { ...status, receivedBytes: offset + 3 };
    }),
    accept: vi.fn(async () => {
      calls.push("accept");
      return receipt;
    }),
    finalize: vi.fn(async () => {
      calls.push("finalize");
      return { ...status, role: "source" as const, status: "finalized" as const, receipt };
    }),
    cancel: vi.fn(async () => ({ ...status, status: "cancelled" as const })),
  };
  const progress: MineTransferProgress[] = [];
  const run = () => transferMine(client, client, input, (value) => progress.push(value));
  return { client, calls, input, manifest, receipt, status, progress, run };
}

describe("mine transfer coordination", () => {
  it("checks the destination before pausing and copies with bounded backpressure before starting", async () => {
    const fixture = setup();
    await expect(fixture.run()).resolves.toEqual(fixture.receipt);
    expect(fixture.calls).toEqual([
      "preflight",
      "prepare",
      "begin",
      "read:0",
      "write:0",
      "read:3",
      "write:3",
      "accept",
      "finalize",
    ]);
    expect(fixture.progress.at(-1)).toEqual({ stage: "complete", copiedBytes: 6, totalBytes: 6 });
    expect(fixture.client.accept).toHaveBeenCalledWith({
      transferId: fixture.input.transferId,
      resume: true,
    });
  });

  it("leaves the source untouched when destination checks fail", async () => {
    const fixture = setup();
    vi.mocked(fixture.client.preflight).mockRejectedValue(new Error("OVH is offline"));
    await expect(fixture.run()).rejects.toThrow("OVH is offline");
    expect(fixture.client.prepare).not.toHaveBeenCalled();
    expect(fixture.client.cancel).not.toHaveBeenCalled();
  });

  it("resumes from the last persisted destination chunk and keeps idle mines idle", async () => {
    const fixture = setup();
    vi.mocked(fixture.client.prepare).mockResolvedValue({
      ...fixture.status,
      role: "source",
      status: "prepared",
      manifest: { ...fixture.manifest, wasActive: false },
    });
    vi.mocked(fixture.client.begin).mockResolvedValue({ ...fixture.status, receivedBytes: 3 });
    await fixture.run();
    expect(fixture.client.readChunk).toHaveBeenCalledExactlyOnceWith({
      transferId: fixture.input.transferId,
      offset: 3,
    });
    expect(fixture.client.accept).toHaveBeenCalledWith({
      transferId: fixture.input.transferId,
      resume: false,
    });
  });

  it("replays acceptance to finish a saved receipt's continuation without copying again", async () => {
    const fixture = setup();
    vi.mocked(fixture.client.begin).mockResolvedValue({
      ...fixture.status,
      status: "accepted",
      receipt: fixture.receipt,
    });
    await fixture.run();
    expect(fixture.client.readChunk).not.toHaveBeenCalled();
    expect(fixture.client.accept).toHaveBeenCalledExactlyOnceWith({
      transferId: fixture.input.transferId,
      resume: true,
    });
    expect(fixture.client.finalize).toHaveBeenCalledExactlyOnceWith({
      transferId: fixture.input.transferId,
      receipt: fixture.receipt,
    });
  });

  it("recovers an uncertain acceptance through its idempotent endpoint without copying again", async () => {
    const fixture = setup();
    vi.mocked(fixture.client.begin).mockResolvedValue({
      ...fixture.status,
      status: "accepting",
      receivedBytes: 6,
    });
    await fixture.run();
    expect(fixture.client.readChunk).not.toHaveBeenCalled();
    expect(fixture.client.accept).toHaveBeenCalledOnce();
  });

  it("does not finalize or automatically unlock the source after a lost acceptance reply", async () => {
    const fixture = setup();
    vi.mocked(fixture.client.accept).mockRejectedValue(new Error("Disconnected"));
    await expect(fixture.run()).rejects.toThrow("Disconnected");
    expect(fixture.client.finalize).not.toHaveBeenCalled();
    expect(fixture.client.cancel).not.toHaveBeenCalled();
  });

  it("refuses a source snapshot or receipt bound to a different device", async () => {
    const fixture = setup();
    vi.mocked(fixture.client.prepare).mockResolvedValue({
      ...fixture.status,
      role: "source",
      status: "prepared",
      manifest: {
        ...fixture.manifest,
        destinationEnvironmentId: EnvironmentId.make("different-host"),
      },
    });
    await expect(fixture.run()).rejects.toThrow("does not match");
    expect(fixture.client.begin).not.toHaveBeenCalled();
  });

  it("rejects an invalid chunk instead of acknowledging incorrect progress", async () => {
    const fixture = setup();
    vi.mocked(fixture.client.readChunk).mockResolvedValue({ offset: 0, totalBytes: 6, data: "" });
    await expect(fixture.run()).rejects.toThrow("invalid file chunk");
    expect(fixture.client.writeChunk).not.toHaveBeenCalled();
    expect(fixture.client.accept).not.toHaveBeenCalled();
  });

  it("cancels the destination before unlocking the source", async () => {
    const fixture = setup();
    const calls: string[] = [];
    const source = {
      ...fixture.client,
      cancel: vi.fn(async () => {
        calls.push("source");
        return { ...fixture.status, status: "cancelled" as const };
      }),
    };
    const destination = {
      ...fixture.client,
      cancel: vi.fn(async () => {
        calls.push("destination");
        return { ...fixture.status, status: "cancelled" as const };
      }),
    };
    await cancelMineTransfer(source, destination, fixture.input.transferId);
    expect(calls).toEqual(["destination", "source"]);
  });

  it("keeps the source locked when destination cancellation is uncertain", async () => {
    const fixture = setup();
    const source = { ...fixture.client, cancel: vi.fn() };
    vi.mocked(fixture.client.cancel).mockResolvedValue({
      ...fixture.status,
      status: "accepted",
      receipt: fixture.receipt,
    });
    await expect(
      cancelMineTransfer(source, fixture.client, fixture.input.transferId),
    ).rejects.toThrow("may already be running");
    expect(source.cancel).not.toHaveBeenCalled();
  });
});
