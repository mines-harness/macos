#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Source comparison uses GitHub's CLI without reading repository contents.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import config from "../.github/mines-release.json" with { type: "json" };

const TreeEntry = Schema.Struct({ path: Schema.String, sha: Schema.String, type: Schema.String });
type TreeEntry = typeof TreeEntry.Type;
const TreeResponse = Schema.Struct({
  sha: Schema.String,
  truncated: Schema.Boolean,
  tree: Schema.Array(TreeEntry),
});
const CommitResponse = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({ tree: Schema.Struct({ sha: Schema.String }) }),
});

const decodeCommitResponse = Schema.decodeUnknownSync(CommitResponse);
const decodeTreeResponse = Schema.decodeUnknownSync(TreeResponse);

export function compareSourceTrees(
  canonical: readonly TreeEntry[],
  repository: readonly TreeEntry[],
  paths: readonly string[],
) {
  const select = (tree: readonly TreeEntry[]) =>
    new Map(
      tree
        .filter(
          (entry) =>
            entry.type !== "tree" &&
            paths.some((path) => entry.path === path || entry.path.startsWith(`${path}/`)),
        )
        .map((entry) => [entry.path, entry.sha]),
    );
  const expected = select(canonical);
  const actual = select(repository);
  return [...new Set([...expected.keys(), ...actual.keys()])]
    .sort()
    .flatMap((path) =>
      expected.get(path) === actual.get(path)
        ? []
        : [{ path, canonical: expected.get(path) ?? null, repository: actual.get(path) ?? null }],
    );
}

const sharedPaths = [
  "apps",
  "packages",
  "assets",
  "native",
  "scripts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
];
const mobilePaths = [
  "apps/mobile",
  "packages/client-runtime",
  "packages/contracts",
  "packages/shared",
  "assets",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
];
const repositories = [
  { repository: "mines-harness/windows", role: "platform-source", paths: sharedPaths },
  { repository: "mines-harness/cli-source-private", role: "historical-source", paths: sharedPaths },
  { repository: "mines-harness/android", role: "platform-source", paths: mobilePaths },
  { repository: "mines-harness/ios", role: "platform-source", paths: mobilePaths },
] as const;

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
async function github(endpoint: string) {
  const result = await execFile("gh", ["api", endpoint], { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(result.stdout) as unknown;
}

async function snapshot(repository: string) {
  const commit = decodeCommitResponse(await github(`repos/${repository}/commits/main`));
  const tree = decodeTreeResponse(
    await github(`repos/${repository}/git/trees/${commit.commit.tree.sha}?recursive=1`),
  );
  if (tree.truncated)
    throw new Error(
      `GitHub truncated the source tree for ${repository}; parity cannot be established.`,
    );
  return { commit: commit.sha, tree: tree.sha, entries: tree.tree };
}

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      output: { type: "string" },
      summary: { type: "string" },
      strict: { type: "boolean", default: false },
    },
  });
  const canonical = await snapshot(config.sourceRepository);
  const results = await Promise.all(
    repositories.map(async (entry) => {
      try {
        const target = await snapshot(entry.repository);
        const differences = compareSourceTrees(canonical.entries, target.entries, entry.paths);
        return {
          repository: entry.repository,
          role: entry.role,
          commit: target.commit,
          tree: target.tree,
          status: differences.length === 0 ? "aligned" : "drift",
          differences,
        };
      } catch {
        return {
          repository: entry.repository,
          role: entry.role,
          status: "unavailable",
          error:
            "Cannot read this source repository. Private sibling repositories require an existing organization read credential; no parity is inferred.",
        };
      }
    }),
  );
  const status = results.every((result) => result.status === "aligned") ? "aligned" : "attention";
  const report = {
    schemaVersion: 1,
    canonicalRepository: config.sourceRepository,
    canonicalCommit: canonical.commit,
    canonicalTree: canonical.tree,
    distributionRepository: config.distributionRepository,
    legacyDistributionRepository: "mines-harness/cli",
    status,
    repositories: results,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (values.output) await NodeFSP.writeFile(values.output, json);
  else process.stdout.write(json);
  if (values.summary) {
    const rows = results.map(
      (result) =>
        `| ${result.repository} | ${result.status} | ${"differences" in result ? (result.differences?.length ?? 0) : "unknown"} |`,
    );
    await NodeFSP.appendFile(
      values.summary,
      `Canonical source: [${config.sourceRepository}@${canonical.commit.slice(0, 12)}](https://github.com/${config.sourceRepository}/commit/${canonical.commit})\n\n| Source repository | State | Different files |\n| --- | --- | --- |\n${rows.join("\n")}\n\nAll new desktop and CLI releases build the canonical source. The attached JSON identifies exact files in older platform snapshots; it does not overwrite them.\n`,
    );
  }
  if (values.strict && status !== "aligned") process.exitCode = 1;
}

if (import.meta.main) await main();
