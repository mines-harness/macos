import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliArchiveFileName,
  cliReleaseIndexPageUrl,
  cliReleaseDownloadBaseUrl,
  resolveCliReleaseBaseUrl,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("requires an explicit own release source and rejects upstream or insecure URLs", () => {
    expect(resolveCliReleaseBaseUrl(undefined)).toBeUndefined();
    expect(cliReleaseDownloadBaseUrl("1.2.3")).toBeUndefined();
    expect(cliReleaseIndexPageUrl(1)).toBeUndefined();
    expect(resolveCliReleaseBaseUrl(undefined, "pingdotgg/t3code")).toBeUndefined();
    expect(cliReleaseIndexPageUrl(1, "PingDotGG/T3Code")).toBeUndefined();
    for (const url of [
      "https://github.com/pingdotgg/t3code/releases/download",
      "http://releases.example/download",
      "https://user:password@releases.example/download",
      "https://releases.example/download?token=secret",
    ]) {
      expect(resolveCliReleaseBaseUrl(url)).toBeUndefined();
    }
    expect(resolveCliReleaseBaseUrl(undefined, "mines-test/mines")).toBe(
      "https://github.com/mines-test/mines/releases/download",
    );
    expect(cliReleaseDownloadBaseUrl("1.2.3", "https://releases.example/download/")).toBe(
      "https://releases.example/download/v1.2.3",
    );
    expect(cliArchiveFileName("1.2.3", "linux-x64")).toBe("mines-1.2.3-linux-x64.tar.gz");
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});
