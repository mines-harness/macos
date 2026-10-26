import { expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { sharedChatMembers } from "./SharedGroupConversation.logic";
it("makes distinct safe aliases for selected chats without offering a chat twice", () => {
  const first = { id: ThreadId.make("one"), title: "Everyone" };
  expect(
    sharedChatMembers(
      [
        first,
        first,
        { id: ThreadId.make("two"), title: "Mine" },
        { id: ThreadId.make("three"), title: "你好" },
        { id: ThreadId.make("four"), title: " 12 Debug this! " },
      ],
      ["MINE"],
    ),
  ).toEqual([
    { threadId: first.id, alias: "everyone-2" },
    { threadId: "two", alias: "mine-2" },
    { threadId: "three", alias: "mine-3" },
    { threadId: "four", alias: "debug-this" },
  ]);
});
