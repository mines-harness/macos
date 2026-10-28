// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer against a local GitHub fixture.
import * as HostProcess from "@t3tools/shared/HostProcess";
import { DEFAULT_MINES_RELEASE_REPOSITORY } from "@t3tools/shared/cliRelease";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const nightlies = Array.from({ length: 100 }, (_, index) => ({
  tag_name: `v1.2.4-nightly.20261020.${200 - index}`,
}));
const cases = [
  {
    name: "canonical stable",
    channel: "stable",
    version: "1.2.3",
    repository: "",
    cached: true,
    mirror: false,
  },
  {
    name: "canonical preview after a full page of nightlies",
    channel: "preview",
    version: "1.2.4-preview.20261019.50",
    repository: "",
    cached: true,
    mirror: false,
  },
  {
    name: "explicit legacy repository",
    channel: "stable",
    version: "1.2.3",
    repository: "mines-harness/cli",
    cached: true,
    mirror: false,
  },
  {
    name: "explicit private repository",
    channel: "preview",
    version: "1.2.4-preview.20261019.50",
    repository: "example/private-mines",
    cached: true,
    mirror: false,
  },
  {
    name: "fresh canonical archive",
    channel: "stable",
    version: "1.2.3",
    repository: "",
    cached: false,
    mirror: false,
  },
  {
    name: "pinned mirror archive",
    channel: "stable",
    version: "1.2.3",
    repository: "",
    cached: false,
    mirror: true,
  },
];

// regression: #22490 - The POSIX installer runs on Linux and macOS; Windows uses install.ps1.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("installer release lookup", () => {
  it.each(cases)(
    "installs from $name",
    async ({ channel, version, repository, cached, mirror }) => {
      await using root = await NodeFSP.mkdtempDisposable(
        NodePath.join(NodeOS.tmpdir(), "mines-install-"),
      );
      const target = NodePath.join(root.path, "home/runtime/versions", version);
      const stem = `mines-${version}-${HostProcess.Platform.defaultValue()}-${HostProcess.Architecture.defaultValue()}`;
      const archiveName = `${stem}.tar.gz`;
      const repositoryPath = repository || DEFAULT_MINES_RELEASE_REPOSITORY;
      const downloadPath = mirror ? "/mirror/download" : `/${repositoryPath}/releases/download`;
      const requests: string[] = [];
      let archive = Buffer.alloc(0);
      const executable = `#!/bin/sh\nprintf 'mines ${version}\\n'\n`;
      if (cached) {
        await NodeFSP.mkdir(target, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), `${version}\n`);
        await NodeFSP.writeFile(NodePath.join(target, "mines"), executable, { mode: 0o755 });
      } else {
        const packageDir = NodePath.join(root.path, "package", stem);
        await NodeFSP.mkdir(packageDir, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(packageDir, "mines"), executable, { mode: 0o755 });
        const archivePath = NodePath.join(root.path, archiveName);
        const tar = NodeChildProcess.spawnSync(
          "tar",
          ["-czf", archivePath, "-C", NodePath.dirname(packageDir), stem],
          { encoding: "utf8" },
        );
        expect(tar.status, tar.stderr).toBe(0);
        archive = await NodeFSP.readFile(archivePath);
      }
      const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      const server = NodeHttp.createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        requests.push(`${url.pathname}${url.search}`);
        if (url.pathname === `${downloadPath}/v${version}/${archiveName}`) {
          response.end(archive);
          return;
        }
        if (url.pathname === `${downloadPath}/v${version}/SHA256SUMS`) {
          response.end(`${digest}  ${archiveName}\n`);
          return;
        }
        const body =
          url.pathname === `/${repositoryPath}/releases/latest` &&
          request.headers.accept === "application/json"
            ? { tag_name: "v1.2.3" }
            : url.pathname === `/repos/${repositoryPath}/releases`
              ? { "1": nightlies, "2": [{ tag_name: `v${version}` }, { tag_name: "v1.2.3" }] }[
                  url.searchParams.get("page") ?? ""
                ]
              : undefined;
        if (body === undefined) response.statusCode = 404;
        response.end(JSON.stringify(body ?? [], null, 2));
      });
      try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
        const origin = `http://127.0.0.1:${address.port}`;
        const source = await NodeFSP.readFile(
          NodePath.resolve(import.meta.dirname, "install.sh"),
          "utf8",
        );
        const installer = NodePath.join(root.path, "install.sh");
        await NodeFSP.writeFile(
          installer,
          source.replace(/https:\/\/(api\.)?github\.com/g, origin),
        );
        const { code, output } = await new Promise<{ code: number | null; output: string }>(
          (resolve, reject) => {
            const child = NodeChildProcess.spawn("sh", [installer], {
              env: {
                ...process.env,
                MINES_VERSION: mirror ? version : "",
                MINES_CHANNEL: channel,
                MINES_HOME: NodePath.join(root.path, "home"),
                MINES_INSTALL_BIN_DIR: NodePath.join(root.path, "bin"),
                MINES_CLI_UPDATE_REPOSITORY: repository,
                MINES_CLI_RELEASE_BASE_URL: mirror ? `${origin}${downloadPath}` : "",
                T3CODE_RELEASE_BASE_URL: "https://old.example.test",
              },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let output = "";
            child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
            child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
            child.on("error", reject);
            child.on("close", (code) => resolve({ code, output }));
          },
        );
        expect(code, output).toBe(0);
        expect(output).toContain(`Installed mines ${version}`);
        expect(await NodeFSP.readlink(NodePath.join(root.path, "bin/mines"))).toBe(
          NodePath.join(target, "mines"),
        );
        expect(await NodeFSP.readFile(NodePath.join(target, ".install-complete"), "utf8")).toBe(
          `${version}\n`,
        );
        if (channel === "preview")
          expect(requests).toContain(`/repos/${repositoryPath}/releases?per_page=100&page=2`);
        if (!cached) expect(requests).toContain(`${downloadPath}/v${version}/${archiveName}`);
        if (mirror) expect(requests.every((url) => url.startsWith(downloadPath))).toBe(true);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
