import { describe, expect, it } from "vite-plus/test";

import { GuestMessageId } from "@t3tools/contracts";

import { redactDeletedGuestMessage, resolveUserMessagePresentation } from "./userMessage.ts";

describe("resolveUserMessagePresentation", () => {
  const legacyText = "[Triggered by schedule task: Daily audit]\n\nCheck for crashes.\n";

  it("preserves user-written and assistant-quoted schedule headers", () => {
    for (const message of [
      { role: "user", createdBy: "user" as const },
      { role: "user" },
      { role: "assistant", createdBy: "agent" as const },
    ]) {
      expect(resolveUserMessagePresentation({ ...message, text: legacyText })).toEqual({
        text: legacyText,
        attribution: null,
        scheduledTaskId: undefined,
      });
    }
  });

  it("shows a guest's own words and name, not the attributed text the agent reads", () => {
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "user",
        text: "Message from guest Sam, sent by the owner:\n\nWhy?",
        context: {
          guest: {
            guestMessageId: GuestMessageId.make("guest-message:one"),
            name: "Sam",
            text: "Why?",
          },
        },
      }),
    ).toEqual({ text: "Why?", attribution: "guest", scheduledTaskId: undefined, guestName: "Sam" });
  });

  it("hides a deleted guest's text while retaining attribution", () => {
    expect(
      resolveUserMessagePresentation({
        role: "user",
        text: "Message from guest Sam: private text",
        context: {
          guest: {
            guestMessageId: GuestMessageId.make("deleted"),
            name: "Sam",
            text: "private text",
            deletedAt: "2026-10-29T00:00:00.000Z",
          },
        },
      }),
    ).toEqual({ text: "", attribution: "guest", scheduledTaskId: undefined, guestName: "Sam" });
  });

  it("attributes older server-sent restart continuations to T3 Code, not another agent", () => {
    const text = "Note: the T3 server restarted.";
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        creationSource: "server",
        text,
      }),
    ).toMatchObject({ attribution: "mines" });
    for (const creationSource of ["mcp", "provider"] as const) {
      expect(
        resolveUserMessagePresentation({ role: "user", createdBy: "agent", creationSource, text }),
      ).toMatchObject({ attribution: "agent" });
    }
  });

  it("recovers the triggering automation from older scheduler message ids", () => {
    for (const trigger of ["scheduled", "manual"]) {
      expect(
        resolveUserMessagePresentation({
          id: `scheduled-task-message:task:daily-audit:1788661140000:${trigger}`,
          role: "user",
          createdBy: "user",
          text: legacyText,
        }),
      ).toEqual({
        text: "Check for crashes.\n",
        attribution: "automation",
        scheduledTaskId: "task:daily-audit",
      });
    }
  });
});

describe("redactDeletedGuestMessage", () => {
  it("removes deleted message content from display actions without mutating provider context", () => {
    const message = {
      text: "Attributed private text",
      attachments: [
        {
          id: "file",
          type: "file" as const,
          name: "private.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
        },
      ],
      context: {
        version: 1 as const,
        records: [],
        guest: {
          guestMessageId: GuestMessageId.make("removed"),
          name: "Sam",
          text: "private text",
          deletedAt: "2026-10-29T00:00:00.000Z",
        },
      },
    };
    const redacted = redactDeletedGuestMessage(message);
    expect(redacted).toMatchObject({
      text: "",
      attachments: [],
      context: {
        records: [],
        guest: { text: "", name: "Sam", deletedAt: message.context.guest.deletedAt },
      },
    });
    expect(message.text).toBe("Attributed private text");
    expect(message.context.guest.text).toBe("private text");
    expect(message.attachments).toHaveLength(1);
  });

  it("preserves identity and content for messages that are still visible", () => {
    const message = { text: "Visible", attachments: [] };
    expect(redactDeletedGuestMessage(message)).toBe(message);
  });
});
