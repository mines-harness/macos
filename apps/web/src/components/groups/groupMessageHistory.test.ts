import * as NodeBuffer from "node:buffer";
import {
  ComposerContextId,
  GroupId,
  type GroupMessage,
  type GroupMessageChunk,
  type GroupSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  groupMessageSourceKey,
  mergeGroupHistory,
  readCompleteGroupMessage,
} from "./groupMessageHistory";

const groupId = GroupId.make("history-group");
const message = (id: string, text = id, createdAt = "2026-10-29T00:00:00.000Z"): GroupMessage => ({
  id,
  groupId,
  roundId: null,
  memberId: null,
  kind: "user",
  text,
  createdAt,
  truncated: false,
});
const snapshot = (messages: ReadonlyArray<GroupMessage>): GroupSnapshot => ({
  group: {
    id: groupId,
    name: "Current group",
    workflow: "team",
    leadMemberId: "lead",
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
    archivedAt: null,
  },
  members: [],
  messages,
  rounds: [],
  hasMoreMessages: true,
});
function chunks(full: GroupMessage) {
  const bytes = NodeBuffer.Buffer.from(JSON.stringify(full));
  return (offset: number): GroupMessageChunk => {
    const data = bytes.subarray(offset, offset + 192 * 1024);
    return {
      type: "message-chunk",
      offset,
      totalBytes: bytes.length,
      data: data.toString("base64"),
      complete: offset + data.length === bytes.length,
    };
  };
}

describe("group message history", () => {
  it("merges older pages without duplicating messages or replacing live updates and members", () => {
    const old = snapshot([
      message("old", "Earlier", "2026-10-28T00:00:00.000Z"),
      message("current", "Stale"),
    ]);
    const live = snapshot([
      message("current", "Live update"),
      message("new", "Newest", "2026-10-29T00:01:00.000Z"),
    ]);
    const merged = mergeGroupHistory(live, [old]);
    expect(merged.messages.map((entry) => entry.id)).toEqual(["old", "current", "new"]);
    expect(merged.messages[1]?.text).toBe("Live update");
    expect(merged.members).toBe(live.members);
    expect(merged.group).toBe(live.group);
  });

  it("reassembles UTF8 across bounded base64 ranges", async () => {
    const full = message("large", "é".repeat(120_000));
    const read = vi.fn(async (offset: number) => chunks(full)(offset));
    const loaded = await readCompleteGroupMessage(
      { ...full, text: "é", truncated: true, contextDeferred: true },
      read,
    );
    expect(loaded.text).toBe(full.text);
    expect(loaded.truncated).toBe(false);
    expect(read.mock.calls.map(([offset]) => offset)).toEqual([0, 192 * 1024]);
  });

  it("rebinds full shared context to the authorized local attachment IDs", async () => {
    const attachment = {
      type: "image" as const,
      id: "remote-image",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 10,
    };
    const full: GroupMessage = {
      ...message("shared"),
      attachments: [attachment],
      context: {
        version: 1,
        records: [
          {
            version: 1,
            kind: "image",
            contextId: ComposerContextId.make("image_context"),
            label: "Screenshot",
            attachmentId: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          },
        ],
      },
    };
    const { context: _context, ...base } = full;
    const visible = {
      ...base,
      contextDeferred: true,
      attachments: [{ ...attachment, id: "local-image" }],
    };
    const loaded = await readCompleteGroupMessage(
      visible,
      async (offset) => chunks(full)(offset),
      () => true,
      true,
    );
    expect(loaded.attachments?.[0]?.id).toBe("local-image");
    expect(loaded.context?.records[0]).toEqual(
      expect.objectContaining({ attachmentId: "local-image" }),
    );
  });

  it("rejects wrong ranges, oversized declarations and changed totals", async () => {
    const full = message("large", "a".repeat(210_000));
    const valid = chunks(full);
    await expect(
      readCompleteGroupMessage(full, async () => ({ ...valid(0), offset: 1 })),
    ).rejects.toThrow("invalid range");
    await expect(
      readCompleteGroupMessage(full, async () => ({ ...valid(0), totalBytes: 65 * 1024 * 1024 })),
    ).rejects.toThrow("invalid range");
    await expect(
      readCompleteGroupMessage(full, async (offset) => ({
        ...valid(offset),
        totalBytes: valid(offset).totalBytes + (offset ? 1 : 0),
      })),
    ).rejects.toThrow("invalid range");
  });

  it("rejects another group's message and stops reads after navigation", async () => {
    const full = message("one");
    await expect(
      readCompleteGroupMessage(full, async (offset) =>
        chunks({ ...full, groupId: GroupId.make("other") })(offset),
      ),
    ).rejects.toThrow("another conversation");
    let current = true;
    const read = vi.fn(async (offset: number) => {
      current = false;
      return chunks(full)(offset);
    });
    await expect(readCompleteGroupMessage(full, read, () => current)).rejects.toThrow(
      "conversation changed",
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("invalidates reconstruction when the live source changes", () => {
    const first = { ...message("same", "First prefix"), truncated: true };
    expect(groupMessageSourceKey(first)).not.toBe(
      groupMessageSourceKey({ ...first, text: "Updated prefix" }),
    );
  });
});
