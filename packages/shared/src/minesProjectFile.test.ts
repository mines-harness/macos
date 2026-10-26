import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { parseMinesProjectFile, MinesProjectFileFromJson } from "./minesProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(MinesProjectFileFromJson);

describe("MinesProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });
});

describe("parseMinesProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseMinesProjectFile(`{
        /* See urn:mines:project-file */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });
});
