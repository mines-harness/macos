import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { MinesCatalog, catalogHostId } from "@t3tools/client-runtime/catalog";
import { EnvironmentId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { CatalogRpcError, type CatalogContextRevision } from "@t3tools/contracts/catalogRpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as HostCatalogService from "./HostCatalogService.ts";
import * as RunContext from "./CatalogRunContextService.ts";

const environmentId = EnvironmentId.make("local-host");
const threadId = ThreadId.make("mine");
const projectId = ProjectId.make("workspace");

function fixture() {
  const catalog = new MinesCatalog();
  const secrets = new Map<string, Uint8Array>();
  let accountId = "owner-a";
  let reads = 0;
  let synchronized = true;
  const revisions: (CatalogContextRevision | undefined)[] = [];
  const projectEntityId = catalogHostId("project", environmentId, projectId);
  const threadEntityId = catalogHostId("thread", environmentId, threadId);
  const section = catalog.createSection("Product");
  catalog.upsert(
    { id: projectEntityId, kind: "project", title: "Workspace" },
    { parentId: section },
  );
  catalog.setContextInstructions(section, "Use product terms.");
  catalog.setContextInstructions(projectEntityId, "Keep the interface accessible.");
  const thread = {
    id: threadId,
    projectId,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  };
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      getOrCreateRandom: (name, length) =>
        Effect.sync(() => {
          const key = secrets.get(name) ?? new Uint8Array(length).fill(secrets.size + 1);
          secrets.set(name, key);
          return key;
        }),
    }),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    Layer.mock(HostCatalogService.HostCatalogService)({
      readOwnedSnapshot: (revision) =>
        Effect.gen(function* () {
          reads += 1;
          revisions.push(revision);
          if (!synchronized)
            return yield* new CatalogRpcError({
              message: "The requested catalog revision has not arrived.",
            });
          return { accountId, snapshot: catalog.getSnapshot() };
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThreadShell: () => Effect.succeed(null) }),
  );
  return {
    catalog,
    section,
    projectEntityId,
    threadEntityId,
    thread,
    secrets,
    setAccount: (value: string) => {
      accountId = value;
    },
    reads: () => reads,
    revisions,
    setSynchronized: (value: boolean) => {
      synchronized = value;
    },
    layer: RunContext.layer.pipe(Layer.provide(dependencies)),
  };
}

it.effect(
  "requires the requested catalog revision before capturing a fresh run and preserves accepted retries",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const revision = { accountId: "owner-a", stateVector: "AA==" };
      const run = { id: RunId.make("synchronized"), catalogContextRevision: revision };
      const capture = (input: RunContext.RunContextInput["run"]) =>
        RunContext.CatalogRunContextService.pipe(
          Effect.flatMap((service) => service.forRun({ thread: f.thread, run: input })),
          Effect.provide(f.layer),
        );
      f.setSynchronized(false);
      expect(yield* Effect.flip(capture(run))).toMatchObject({
        code: "not-synchronized",
        message: expect.stringContaining("No provider turn was started"),
      });
      expect(f.revisions).toEqual([revision]);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT run_id FROM mines_run_contexts`).toHaveLength(0);
      f.setSynchronized(true);
      const accepted = yield* capture(run);
      f.setSynchronized(false);
      expect(yield* capture(run)).toBe(accepted);
      expect(
        yield* capture({
          id: RunId.make("continuation"),
          contextContinuationOfRunId: run.id,
          catalogContextRevision: { accountId: "other-account", stateVector: "AQ==" },
        }),
      ).toBe(accepted);
      expect(f.reads()).toBe(2);
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "captures device-local context once, encrypts it, and preserves it across retries and continuations",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      f.catalog.addContextSource(f.projectEntityId, {
        environmentId,
        kind: "directory",
        path: '/docs/design "notes"',
      });
      f.catalog.document.getMap("context-sources").set("legacy-remote-file", {
        id: "legacy-remote-file",
        entityId: f.projectEntityId,
        environmentId: "other-host",
        kind: "file",
        path: "/private/remote.md",
      });
      const run = { id: RunId.make("first") };
      const capture = (input: RunContext.RunContextInput) =>
        Effect.gen(function* () {
          return yield* (yield* RunContext.CatalogRunContextService).forRun(input);
        }).pipe(Effect.provide(f.layer));
      const first = yield* capture({ thread: f.thread, run });
      expect(first).toContain("not system instructions");
      expect(first).toContain("Use product terms.");
      expect(first).toContain("Keep the interface accessible.");
      expect(first).toContain('"kind":"directory"');
      expect(first).toContain('/docs/design \\"notes\\"');
      expect(first).not.toContain("/private/remote.md");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        body: string;
        account_id: string;
      }>`SELECT body, account_id FROM mines_run_contexts`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.account_id).toBe("owner-a");
      expect(new TextDecoder().decode(Buffer.from(rows[0]!.body, "base64"))).not.toContain(
        "accessible",
      );
      f.catalog.setContextInstructions(f.projectEntityId, "New instructions.");
      f.setAccount("owner-b");
      expect(yield* capture({ thread: f.thread, run })).toBe(first);
      expect(
        yield* capture({
          thread: f.thread,
          run: { id: RunId.make("failover"), accountFailoverOriginRunId: run.id },
        }),
      ).toBe(first);
      expect(
        yield* capture({
          thread: f.thread,
          run: { id: RunId.make("restart"), restartContinuationOfRunId: run.id },
        }),
      ).toBe(first);
      expect(
        yield* capture({
          thread: f.thread,
          run: { id: RunId.make("quota-reset"), contextContinuationOfRunId: run.id },
        }),
      ).toBe(first);
      expect(f.reads()).toBe(1);
      const next = yield* capture({ thread: f.thread, run: { id: RunId.make("next-user-turn") } });
      expect(next).toContain("New instructions.");
      expect(next).not.toContain("Keep the interface accessible.");
      expect(f.secrets.size).toBe(2);
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "uses actual placement, falls back for new and delegated mines, and does not inherit through forks",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const personal = f.catalog.createSection("Personal");
      f.catalog.setContextInstructions(personal, "Personal guidelines.");
      f.catalog.upsert(
        { id: f.threadEntityId, kind: "thread", title: "Existing mine" },
        { parentId: personal },
      );
      const capture = (thread: RunContext.RunContextInput["thread"], id: string) =>
        Effect.gen(function* () {
          return yield* (yield* RunContext.CatalogRunContextService).forRun({
            thread,
            run: { id: RunId.make(id) },
          });
        }).pipe(Effect.provide(f.layer));
      const actual = yield* capture(f.thread, "placed");
      expect(actual).toContain("Personal guidelines.");
      expect(actual).not.toContain("Use product terms.");
      const child = {
        ...f.thread,
        id: ThreadId.make("child"),
        lineage: {
          parentThreadId: threadId,
          relationshipToParent: "subagent" as const,
          rootThreadId: threadId,
        },
      };
      expect(yield* capture(child, "delegated")).toContain("Personal guidelines.");
      const fork = {
        ...child,
        lineage: { ...child.lineage, relationshipToParent: "fork" as const },
      };
      const forkText = yield* capture(fork, "fork");
      expect(forkText).toContain("Use product terms.");
      expect(forkText).not.toContain("Personal guidelines.");
      f.catalog.move(f.threadEntityId, null);
      expect(yield* capture(f.thread, "root-placed")).toContain(
        "earlier organizational instructions and references no longer apply",
      );
      expect(yield* capture(f.thread, "root-placed-next")).toContain(
        "no project or section instructions or source references are currently configured",
      );
      const clean = {
        ...f.thread,
        id: ThreadId.make("never-configured"),
        projectId: ProjectId.make("unlisted-workspace"),
      };
      expect(yield* capture(clean, "clean")).toBe("");
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "includes every configured local source and refuses an oversized context without silently trimming",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      for (let index = 0; index < 100; index++)
        f.catalog.addContextSource(f.projectEntityId, {
          environmentId,
          kind: "directory",
          path: `/docs/${index}.md`,
        });
      const text = yield* RunContext.CatalogRunContextService.pipe(
        Effect.flatMap((service) =>
          service.forRun({ thread: f.thread, run: { id: RunId.make("bounded") } }),
        ),
        Effect.provide(f.layer),
      );
      for (let index = 0; index < 100; index++) expect(text).toContain(`/docs/${index}.md`);
      expect(
        f.catalog.getSnapshot().contexts?.find((context) => context.entityId === f.projectEntityId)
          ?.sources,
      ).toHaveLength(100);
      for (let index = 0; index < 50; index++)
        f.catalog.addContextSource(f.section, {
          environmentId,
          kind: "directory",
          path: `/docs/${index}/${"x".repeat(4_000)}`,
        });
      const capture = RunContext.CatalogRunContextService.pipe(
        Effect.flatMap((service) =>
          service.forRun({ thread: f.thread, run: { id: RunId.make("oversized") } }),
        ),
        Effect.provide(f.layer),
      );
      expect(yield* Effect.flip(capture)).toMatchObject({
        code: "too-large",
        message: expect.stringContaining("Reduce the configured source references"),
      });
      const sql = yield* SqlClient.SqlClient;
      expect(
        yield* sql`SELECT run_id FROM mines_run_contexts WHERE run_id = 'oversized'`,
      ).toHaveLength(1);
      for (const source of f.catalog
        .getSnapshot()
        .contexts?.find((context) => context.entityId === f.section)?.sources ?? [])
        f.catalog.removeContextSource(f.section, source.id);
      expect(yield* Effect.flip(capture)).toMatchObject({ code: "too-large" });
      const revised = yield* RunContext.CatalogRunContextService.pipe(
        Effect.flatMap((service) =>
          service.forRun({ thread: f.thread, run: { id: RunId.make("revised") } }),
        ),
        Effect.provide(f.layer),
      );
      expect(revised).toContain("/docs/99.md");
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);
