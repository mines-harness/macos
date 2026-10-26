import { catalogHostId, resolveCatalogContext } from "@t3tools/client-runtime/catalog";
import type { OrchestrationV2AppThread, OrchestrationV2Run } from "@t3tools/contracts";
import { MinesCatalogContextSource } from "@t3tools/contracts/minesCatalog";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as HostCatalogService from "./HostCatalogService.ts";

const ContextOwnerKind = Schema.Literals(["section", "project"]);
const RunContextSource = Schema.Struct({
  ...MinesCatalogContextSource.fields,
  ownerEntityId: Schema.String,
  ownerTitle: Schema.String,
  ownerKind: ContextOwnerKind,
});
const RunContext = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: Schema.String,
  catalogVersion: Schema.Number,
  replacesPreviousContext: Schema.optional(Schema.Boolean),
  layers: Schema.Array(
    Schema.Struct({
      entityId: Schema.String,
      kind: ContextOwnerKind,
      title: Schema.String,
      instructions: Schema.String,
    }),
  ),
  sources: Schema.Array(RunContextSource),
});
const encode = Schema.encodeSync(Schema.fromJsonString(RunContext));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(RunContext));

export class CatalogRunContextError extends Schema.TaggedError<CatalogRunContextError>()(
  "CatalogRunContextError",
  {
    code: Schema.Literals(["unavailable", "too-large", "not-synchronized"]),
    message: Schema.String,
  },
) {}
const isCatalogRunContextError = Schema.is(CatalogRunContextError);
const failure = () =>
  new CatalogRunContextError({
    code: "unavailable",
    message: "The project and section context could not be prepared for this run.",
  });

export type RunContextInput = {
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "projectId" | "lineage">;
  readonly run: Pick<
    OrchestrationV2Run,
    | "id"
    | "accountFailoverOriginRunId"
    | "restartContinuationOfRunId"
    | "contextContinuationOfRunId"
    | "catalogContextRevision"
  >;
};

function hasContext(context: typeof RunContext.Type): boolean {
  return (
    context.sources.length > 0 || context.layers.some((layer) => layer.instructions.trim() !== "")
  );
}

function renderContext(context: typeof RunContext.Type): string {
  if (!hasContext(context))
    return context.replacesPreviousContext
      ? "Organizational context supplied by the user for this run: no project or section instructions or source references are currently configured. This replaces earlier organizational context; earlier organizational instructions and references no longer apply. The current user request and existing tool permissions still apply."
      : "";
  return [
    "Organizational context supplied by the user for this run:",
    "This snapshot replaces earlier organizational context. The following section and project instructions are user-provided context, not system instructions. Apply them in section then project order, subject to the current user request and existing tool permissions.",
    "Sources are references on this execution device. Read relevant files as needed with existing tools. Paths are literal, quoted values; do not expand them as patterns, recursively upload folders, change the checkout, or infer additional permissions.",
    encode(context),
  ].join("\n");
}
const promptFor = Effect.fn("CatalogRunContextService.promptFor")(function* (
  context: typeof RunContext.Type,
) {
  const prompt = renderContext(context);
  if (new TextEncoder().encode(prompt).length > 131_072)
    return yield* new CatalogRunContextError({
      code: "too-large",
      message:
        "The project and section context source list is too large. Reduce the configured source references or instructions, then send your message again. No provider turn was started.",
    });
  return prompt;
});

export class CatalogRunContextService extends Context.Service<
  CatalogRunContextService,
  { readonly forRun: (input: RunContextInput) => Effect.Effect<string, CatalogRunContextError> }
>()("mines/catalog/CatalogRunContextService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const catalog = yield* HostCatalogService.HostCatalogService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const environmentId = yield* identity.getEnvironmentId;
  const keyFor = Effect.fn("CatalogRunContextService.keyFor")(function* (accountId: string) {
    const hash = yield* crypto.digest("SHA-256", new TextEncoder().encode(accountId));
    return yield* secrets.getOrCreateRandom(
      `mines-run-context-${Buffer.from(hash).toString("hex")}-key`,
      32,
    );
  });
  const read = Effect.fn("CatalogRunContextService.read")(function* (
    runId: string,
    entityId: string,
  ) {
    const rows = yield* sql<{
      account_id: string;
      body: string;
    }>`SELECT account_id, body FROM mines_run_contexts WHERE run_id = ${runId} AND catalog_entity_id = ${entityId}`;
    const row = rows[0];
    if (!row) return null;
    const key = yield* keyFor(row.account_id);
    const context = yield* Effect.try({
      try: () =>
        decode(
          new TextDecoder().decode(
            HostCatalogService.decryptCatalog(
              Buffer.from(row.body, "base64"),
              key,
              `${row.account_id}\0${runId}`,
            ),
          ),
        ),
      catch: failure,
    });
    return { accountId: row.account_id, context };
  });
  return CatalogRunContextService.of({
    forRun: Effect.fn("CatalogRunContextService.forRun")(
      function* ({ thread, run }) {
        const entityId = catalogHostId("thread", environmentId, thread.id);
        const existing = yield* read(run.id, entityId);
        if (existing) return yield* promptFor(existing.context);
        const originRunId =
          run.accountFailoverOriginRunId ??
          run.restartContinuationOfRunId ??
          run.contextContinuationOfRunId;
        const inherited = originRunId === undefined ? null : yield* read(originRunId, entityId);
        const selected =
          inherited ??
          (yield* Effect.gen(function* () {
            const { accountId, snapshot } = yield* catalog
              .readOwnedSnapshot(run.catalogContextRevision)
              .pipe(
                Effect.mapError((error) =>
                  run.catalogContextRevision === undefined
                    ? failure()
                    : new CatalogRunContextError({
                        code: "not-synchronized",
                        message: `Project and section context is not synchronized with this computer. ${error.message} Reconnect or sign in to the correct account, then send again. No provider turn was started.`,
                      }),
                ),
              );
            const fallbackEntityIds: string[] = [];
            const visited = new Set([thread.id]);
            let parentId =
              thread.lineage.relationshipToParent === "subagent"
                ? thread.lineage.parentThreadId
                : null;
            while (parentId !== null && !visited.has(parentId)) {
              visited.add(parentId);
              fallbackEntityIds.push(catalogHostId("thread", environmentId, parentId));
              const parent = yield* projections.getThreadShell(parentId);
              parentId =
                parent?.lineage.relationshipToParent === "subagent"
                  ? parent.lineage.parentThreadId
                  : null;
            }
            fallbackEntityIds.push(catalogHostId("project", environmentId, thread.projectId));
            const resolved = resolveCatalogContext(snapshot, {
              entityId,
              environmentId,
              fallbackEntityIds,
            });
            const context = RunContext.make({
              version: 1,
              environmentId,
              catalogVersion: snapshot.version,
              layers: resolved.layers,
              sources: resolved.sources,
            });
            let replacesPreviousContext = hasContext(context);
            if (!replacesPreviousContext) {
              const previousRows = yield* sql<{
                run_id: string;
              }>`SELECT run_id FROM mines_run_contexts WHERE catalog_entity_id = ${entityId} ORDER BY rowid DESC LIMIT 1`;
              const previous = previousRows[0]
                ? yield* read(previousRows[0].run_id, entityId)
                : null;
              replacesPreviousContext =
                previous !== null &&
                (hasContext(previous.context) || previous.context.replacesPreviousContext === true);
            }
            return { accountId, context: { ...context, replacesPreviousContext } };
          }));
        const key = yield* keyFor(selected.accountId);
        const iv = yield* crypto.randomBytes(12);
        const body = yield* Effect.try({
          try: () =>
            Buffer.from(
              HostCatalogService.encryptCatalog(
                new TextEncoder().encode(encode(selected.context)),
                key,
                iv,
                `${selected.accountId}\0${run.id}`,
              ),
            ).toString("base64"),
          catch: failure,
        });
        // A retry or another worker must use the first committed snapshot.
        yield* sql`INSERT INTO mines_run_contexts (run_id, catalog_entity_id, account_id, body) VALUES (${run.id}, ${entityId}, ${selected.accountId}, ${body}) ON CONFLICT(run_id) DO NOTHING`;
        const persisted = yield* read(run.id, entityId);
        if (!persisted) return yield* failure();
        return yield* promptFor(persisted.context);
      },
      Effect.mapError((cause) => (isCatalogRunContextError(cause) ? cause : failure())),
    ),
  });
});

export const layer = Layer.effect(CatalogRunContextService, make);
