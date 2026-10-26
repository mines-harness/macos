import { describe, expect, it } from "vite-plus/test";
import { openGroupDraft } from "./groupDraft";

function fixture() {
  let next = 0;
  const records = new Map<string, Uint8Array>();
  const storage = {
    read: async (id: string) => records.get(id) ?? null,
    write: async (id: string, bytes: Uint8Array) => {
      records.set(id, bytes);
    },
  };
  return {
    records,
    storage,
    createId: () => `request-${++next}`,
    environmentId: "mac",
    groupId: "group",
  };
}

describe("encrypted group draft state", () => {
  it("retains the request identity after an uncertain send and reopening", async () => {
    const input = fixture();
    const draft = await openGroupDraft(input);
    draft.setText("@everyone review this");
    const sent = draft.markAttempted();
    await draft.flush();
    const reopened = await openGroupDraft(input);
    expect(reopened.getSnapshot().draft).toEqual(sent);
    expect(reopened.markAttempted().requestId).toBe(sent.requestId);
    await reopened.flush();
  });
  it("preserves edits made while a previous message is in flight", async () => {
    const draft = await openGroupDraft(fixture());
    draft.setText("First message");
    const sent = draft.markAttempted();
    draft.setText("Next message");
    draft.acknowledge(sent.requestId);
    expect(draft.getSnapshot().draft.text).toBe("Next message");
    expect(draft.getSnapshot().draft.requestId).not.toBe(sent.requestId);
    draft.acknowledge(draft.getSnapshot().draft.requestId);
    await draft.flush();
    expect(draft.getSnapshot().draft.text).toBe("");
  });
  it("isolates the same group identifier on another coordinator and clears only the local draft", async () => {
    const input = fixture();
    const a = await openGroupDraft(input);
    a.setText("Private draft");
    await a.flush();
    const other = await openGroupDraft({ ...input, environmentId: "other-mac" });
    expect(other.getSnapshot().draft.text).toBe("");
    a.clear();
    await a.flush();
    expect((await openGroupDraft(input)).getSnapshot().draft.text).toBe("");
  });
  it("surfaces persistence failures before sending and retries the same request", async () => {
    const input = fixture();
    let fail = true;
    const draft = await openGroupDraft({
      ...input,
      storage: {
        ...input.storage,
        write: async (id, bytes) => {
          if (fail) throw new Error("Phone locked");
          await input.storage.write(id, bytes);
        },
      },
    });
    draft.setText("Keep this");
    const sent = draft.markAttempted();
    await expect(draft.flush()).rejects.toThrow("Phone locked");
    expect(draft.getSnapshot().error).toBe("Phone locked");
    fail = false;
    expect(draft.markAttempted().requestId).toBe(sent.requestId);
    await draft.flush();
    expect(draft.getSnapshot().error).toBeNull();
  });
});
