import { describe, expect, it } from "vite-plus/test";
import { groupRecipients } from "./groupChat.ts";

const members = [
  { id: "a", alias: "Alice" },
  { id: "b", alias: "builder_2" },
];

describe("group addressing", () => {
  it("addresses real prose mentions once and ignores email fragments and escaped mentions", () => {
    expect(
      groupRecipients(
        "Don't skip @ALICE, @alice. Review (@builder_2) email@everyone \\@everyone",
        members,
      ),
    ).toEqual({
      mentionEveryone: false,
      recipientMemberIds: ["a", "b"],
    });
  });
  it("ignores block quotes, quoted excerpts, inline code, and both fence styles", () => {
    const copied = [
      "> @everyone",
      '"@alice" and ‘@builder_2’',
      "`@everyone` and ``@alice``",
      "```js",
      "@everyone",
      "```",
      "~~~",
      "@alice",
      "~~~",
      "Ask @builder_2",
    ].join("\n");
    expect(groupRecipients(copied, members)).toEqual({
      mentionEveryone: false,
      recipientMemberIds: ["b"],
    });
  });
  it("does not route mentions in an unfinished code block", () => {
    expect(groupRecipients("@alice\n```\n@everyone", members)).toEqual({
      mentionEveryone: false,
      recipientMemberIds: ["a"],
    });
  });
  it("keeps multiline quoted excerpts out of addressing", () => {
    expect(
      groupRecipients('He wrote "first line\n@everyone\nlast line"\nAsk @alice', members),
    ).toEqual({
      mentionEveryone: false,
      recipientMemberIds: ["a"],
    });
  });
  it("recognizes everyone outside quoted content", () => {
    expect(groupRecipients('"@alice" @everyone', members)).toEqual({
      mentionEveryone: true,
      recipientMemberIds: [],
    });
  });
});
