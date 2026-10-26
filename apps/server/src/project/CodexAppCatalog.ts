import type { AgentSessionSourceReport, AgentSessionSourceSection } from "@t3tools/contracts";
import { createDeterministicAttachmentId } from "../attachmentStore.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const NativeProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  rootPaths: Schema.Array(Schema.String),
});
const NativeSection = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  itemKeys: Schema.Array(Schema.String),
  hostSectionIds: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const CatalogState = Schema.Struct({
  "local-projects": Schema.optional(Schema.Record(Schema.String, NativeProject)),
  "remote-projects": Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
  "thread-project-assignments": Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        projectKind: Schema.String,
        projectId: Schema.String,
      }),
    ),
  ),
  "thread-titles": Schema.optional(
    Schema.Struct({ titles: Schema.Record(Schema.String, Schema.String) }),
  ),
  "app-server-project-id-by-legacy-project-id-by-host": Schema.optional(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
  ),
  "electron-persisted-atom-state": Schema.optional(
    Schema.Struct({
      "sidebar-custom-sections-v3": Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            sections: Schema.Array(NativeSection),
            sectionOrder: Schema.optional(Schema.Array(Schema.String)),
          }),
        ),
      ),
    }),
  ),
});
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(CatalogState));
const NativeSpawn = Schema.Struct({
  parent_thread_id: Schema.optional(Schema.String),
  agent_nickname: Schema.optional(Schema.NullOr(Schema.String)),
  agent_path: Schema.optional(Schema.NullOr(Schema.String)),
});
const NativeSource = Schema.Struct({
  subagent: Schema.optional(
    Schema.Union([Schema.String, Schema.Struct({ thread_spawn: Schema.optional(NativeSpawn) })]),
  ),
});
const decodeSource = Schema.decodeUnknownOption(Schema.fromJsonString(NativeSource));
const THREAD_COLUMNS = [
  "id",
  "title",
  "name",
  "rollout_path",
  "source",
  "thread_source",
  "project_id",
  "agent_nickname",
  "agent_path",
  "thread_section_id",
] as const;
type NativeThreadRow = { readonly [Key in (typeof THREAD_COLUMNS)[number]]: string | null } & {
  readonly id: string;
};
interface SourceProject {
  readonly id: string;
  readonly title: string;
}

const readNativeCatalog = Effect.fn("CodexAppCatalog.readNativeCatalog")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const columns = new Set(
        (yield* sql<{ name: string }>`PRAGMA table_info(threads)`).map((column) => column.name),
      );
      if (!columns.has("id")) return undefined;
      const rows = yield* sql.unsafe<NativeThreadRow>(
        `SELECT ${THREAD_COLUMNS.map((column) => (columns.has(column) ? column : `NULL AS ${column}`)).join(", ")} FROM threads`,
      );
      const projectColumns = new Set(
        (yield* sql<{ name: string }>`PRAGMA table_info(projects)`).map((column) => column.name),
      );
      const projectId = projectColumns.has("id")
        ? "id"
        : projectColumns.has("project_id")
          ? "project_id"
          : null;
      const projects =
        projectId === null
          ? []
          : yield* sql.unsafe<{ id: string; name: string | null; title: string | null }>(
              `SELECT ${projectId} AS id, ${projectColumns.has("name") ? "name" : "NULL AS name"}, ${projectColumns.has("title") ? "title" : "NULL AS title"} FROM projects`,
            );
      const edgeColumns = new Set(
        (yield* sql<{ name: string }>`PRAGMA table_info(thread_spawn_edges)`).map(
          (column) => column.name,
        ),
      );
      const edges =
        edgeColumns.has("parent_thread_id") && edgeColumns.has("child_thread_id")
          ? yield* sql<{
              parent_thread_id: string;
              child_thread_id: string;
            }>`SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges`
          : [];
      const sectionColumns = new Set(
        (yield* sql<{ name: string }>`PRAGMA table_info(thread_sections)`).map(
          (column) => column.name,
        ),
      );
      const sections =
        sectionColumns.has("id") && sectionColumns.has("name")
          ? yield* sql<{ id: string; name: string }>`SELECT id, name FROM thread_sections`
          : [];
      return { rows, projects, edges, sections };
    }),
  );
});

export const readCodexAppCatalog = Effect.fn("CodexAppCatalog.read")(function* (homePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(homePath, ".codex-global-state.json");
  const reports: AgentSessionSourceReport[] = [];
  const state = yield* Effect.gen(function* () {
    const info = yield* fs.stat(filePath);
    if (Number(info.size) > MAX_CATALOG_BYTES) return Option.none<typeof CatalogState.Type>();
    return decodeState(yield* fs.readFileString(filePath));
  }).pipe(Effect.orElseSucceed(() => Option.none<typeof CatalogState.Type>()));
  const data = Option.getOrUndefined(state);
  if (data === undefined && (yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false))))
    reports.push({
      source: "codex",
      status: "partial",
      message:
        "Codex desktop organization could not be read. History is listed by its original workspace.",
    });
  const projects = new Map(Object.entries(data?.["local-projects"] ?? {}));
  const projectSections = new Map<string, AgentSessionSourceSection>();
  const threadSections = new Map<string, AgentSessionSourceSection>();
  const nativeSections = new Map<string, AgentSessionSourceSection>();
  const accounts = Object.values(
    data?.["electron-persisted-atom-state"]?.["sidebar-custom-sections-v3"] ?? {},
  );
  const remoteIds = new Set(data?.["remote-projects"]?.map((project) => project.id));
  let remoteItems = false;
  if (accounts.length === 1) {
    const account = accounts[0]!;
    for (const native of account.sections) {
      if (!native.name.trim() || !native.id.trim()) continue;
      const order = account.sectionOrder?.indexOf(`custom:${native.id}`) ?? -1;
      const section = {
        id: createDeterministicAttachmentId("codex-section", `${homePath}\0${native.id}`)!,
        title: native.name.trim(),
        ...(order < 0 ? {} : { order }),
      };
      nativeSections.set(native.id, section);
      if (native.hostSectionIds?.local) nativeSections.set(native.hostSectionIds.local, section);
      for (const item of native.itemKeys) {
        if (item.startsWith("codex:project:")) {
          const id = item.slice("codex:project:".length);
          if (projects.has(id)) projectSections.set(id, section);
          else if (remoteIds.has(id)) remoteItems = true;
        } else if (item.startsWith("codex:thread:local:")) {
          threadSections.set(item.slice("codex:thread:local:".length), section);
        } else if (item.startsWith("codex:thread:")) remoteItems = true;
      }
    }
  } else if (accounts.length > 1)
    reports.push({
      source: "codex",
      status: "partial",
      message:
        "Multiple Codex desktop accounts retain sidebar organization. Sections could not be assigned to the active account safely.",
    });
  if (remoteItems)
    reports.push({
      source: "codex",
      status: "partial",
      message:
        "Some Codex sections contain projects or threads on another computer. Scan that computer to import its retained history.",
    });
  const titles = new Map(Object.entries(data?.["thread-titles"]?.titles ?? {}));
  const idsByFile = new Map<string, string>();
  const nativeThreads = new Map<string, NativeThreadRow>();
  const nativeProjects = new Map<string, SourceProject>();
  const parents = new Map<string, string>();
  const subagents = new Set<string>();
  const agentNames = new Map<string, string>();
  const databases = (yield* fs
    .readDirectory(homePath)
    .pipe(Effect.orElseSucceed(() => [] as string[])))
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((left, right) => Number(right.match(/\d+/)?.[0]) - Number(left.match(/\d+/)?.[0]));
  if (databases[0]) {
    const native = yield* readNativeCatalog().pipe(
      Effect.provide(
        NodeSqliteClient.layer({ filename: path.join(homePath, databases[0]), readonly: true }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    for (const project of native?.projects ?? []) {
      const title = project.name?.trim() || project.title?.trim();
      if (project.id?.trim() && title) nativeProjects.set(project.id, { id: project.id, title });
    }
    for (const section of native?.sections ?? []) {
      if (!section.id?.trim() || !section.name?.trim() || nativeSections.has(section.id)) continue;
      nativeSections.set(section.id, {
        id: createDeterministicAttachmentId("codex-section", `${homePath}\0native:${section.id}`)!,
        title: section.name.trim(),
      });
    }
    for (const edge of native?.edges ?? []) {
      if (edge.parent_thread_id?.trim() && edge.child_thread_id?.trim()) {
        parents.set(edge.child_thread_id, edge.parent_thread_id);
        subagents.add(edge.child_thread_id);
      }
    }
    for (const row of native?.rows ?? []) {
      nativeThreads.set(row.id, row);
      if (row.name?.trim()) titles.set(row.id, row.name.trim().slice(0, 240));
      else if (row.title?.trim() && !titles.has(row.id))
        titles.set(row.id, row.title.trim().slice(0, 240));
      if (row.rollout_path?.trim()) idsByFile.set(path.resolve(row.rollout_path), row.id);
      const decoded = decodeSource(row.source);
      const subagent = Option.isSome(decoded) ? decoded.value.subagent : undefined;
      const spawn = typeof subagent === "object" ? subagent.thread_spawn : undefined;
      if (spawn?.parent_thread_id?.trim()) parents.set(row.id, spawn.parent_thread_id.trim());
      if (subagent !== undefined || row.thread_source === "subagent" || parents.has(row.id))
        subagents.add(row.id);
      const agentPath = row.agent_path?.trim() || spawn?.agent_path?.trim();
      const name =
        row.agent_nickname?.trim() ||
        spawn?.agent_nickname?.trim() ||
        agentPath
          ?.replace(/\\/g, "/")
          .split("/")
          .findLast((segment) => segment.length > 0);
      if (name) agentNames.set(row.id, name.slice(0, 240));
      if (row.thread_section_id && !threadSections.has(row.id)) {
        const section = nativeSections.get(row.thread_section_id);
        if (section) threadSections.set(row.id, section);
      }
    }
  }
  const roots = new Map<string, { parent: string | undefined; root: string }>();
  let invalidLineage = false;
  for (const id of new Set([...nativeThreads.keys(), ...parents.keys()])) {
    const visited = new Set([id]);
    let root = id;
    let parent = parents.get(id);
    let ancestor = parent;
    while (ancestor !== undefined) {
      if (visited.has(ancestor)) {
        parent = undefined;
        root = id;
        invalidLineage = true;
        break;
      }
      visited.add(ancestor);
      root = ancestor;
      ancestor = parents.get(ancestor);
    }
    roots.set(id, { parent, root });
  }
  if (invalidLineage)
    reports.push({
      source: "codex",
      status: "partial",
      message: "Some native Codex parent links contain a cycle and could not be assigned safely.",
    });
  const nativeToLegacy = new Map(
    Object.entries(
      data?.["app-server-project-id-by-legacy-project-id-by-host"]?.[`local:${homePath}`] ?? {},
    ).map(([legacy, native]) => [native, legacy]),
  );
  const globalProject = (id: string | undefined): SourceProject | undefined => {
    const project = id === undefined ? undefined : projects.get(id);
    return project?.id.trim() && project.name.trim()
      ? { id: project.id, title: project.name.trim() }
      : undefined;
  };
  const sourceProjectFor = (id: string | undefined): SourceProject | null | undefined => {
    if (id === undefined) return undefined;
    const assignment = data?.["thread-project-assignments"]?.[id];
    if (assignment !== undefined && assignment.projectKind !== "local") return undefined;
    const assigned = globalProject(assignment?.projectId);
    if (assigned) return assigned;
    const nativeProjectId = nativeThreads.get(id)?.project_id?.trim();
    if (nativeProjectId) {
      const native =
        globalProject(nativeToLegacy.get(nativeProjectId) ?? nativeProjectId) ??
        nativeProjects.get(nativeProjectId);
      if (native) return native;
    }
    if (assignment !== undefined || nativeProjectId) return undefined;
    return data?.["thread-project-assignments"] === undefined ? undefined : null;
  };
  return {
    reports,
    resolve: (_cwd: string, transcriptPath: string, sessionId?: string) => {
      const id = sessionId?.trim() || idsByFile.get(path.resolve(transcriptPath));
      const project = sourceProjectFor(id);
      const projectSection = project == null ? undefined : projectSections.get(project.id);
      const lineage = id === undefined ? undefined : roots.get(id);
      return {
        projectId: project?.id,
        projectTitle: project?.title,
        projectSection,
        threadTitle:
          id === undefined ? undefined : titles.get(id)?.trim().slice(0, 240) || undefined,
        threadSection: (id === undefined ? undefined : threadSections.get(id)) ?? projectSection,
        sourceThreadId: id,
        sourceParentThreadId: lineage?.parent,
        sourceRootThreadId: lineage?.root,
        kind:
          id === undefined || !roots.has(id)
            ? undefined
            : subagents.has(id)
              ? ("subagent" as const)
              : ("thread" as const),
        agentName: id === undefined ? undefined : agentNames.get(id),
        sourceProject: project,
      };
    },
  };
});
