import * as Schema from "effect/Schema";
import { AgentSessionThreadProvenance } from "./agentSessions.ts";

export const MinesCatalogKind = Schema.Literals([
  "section",
  "project",
  "thread",
  "group",
  "device",
]);
export type MinesCatalogKind = typeof MinesCatalogKind.Type;

export const MinesCatalogHostRef = Schema.Struct({
  environmentId: Schema.String,
  entityId: Schema.String,
});

export const MinesCatalogEntity = Schema.Struct({
  id: Schema.String,
  kind: MinesCatalogKind,
  title: Schema.String,
  hostRef: Schema.optional(MinesCatalogHostRef),
  importSource: Schema.optional(
    Schema.Struct({
      ...AgentSessionThreadProvenance.fields,
      executionProjectId: Schema.String,
    }),
  ),
});
export type MinesCatalogEntity = typeof MinesCatalogEntity.Type;

export const MinesCatalogContextSource = Schema.Struct({
  id: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  environmentId: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  kind: Schema.Literals(["file", "directory"]),
  path: Schema.NonEmptyString.check(Schema.isMaxLength(4_096)),
});
export type MinesCatalogContextSource = typeof MinesCatalogContextSource.Type;

export const MinesCatalogContext = Schema.Struct({
  entityId: Schema.NonEmptyString,
  instructions: Schema.String.check(Schema.isMaxLength(32_768)),
  sources: Schema.Array(MinesCatalogContextSource),
});
export type MinesCatalogContext = typeof MinesCatalogContext.Type;

export interface MinesCatalogEntry {
  readonly entity: MinesCatalogEntity;
  readonly children: readonly MinesCatalogEntry[];
  readonly parentId: string | null;
  readonly orphaned: boolean;
}

export interface MinesCatalogSnapshot {
  readonly version: number;
  readonly roots: readonly MinesCatalogEntry[];
  readonly pins: readonly MinesCatalogEntry[];
  readonly entities: readonly MinesCatalogEntity[];
  readonly contexts?: readonly MinesCatalogContext[];
}
