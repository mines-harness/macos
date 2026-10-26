import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { MinesProjectFile, MINES_PROJECT_FILE_SCHEMA_URL } from "@t3tools/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const MinesProjectFileFromJson = fromLenientJson(MinesProjectFile);

const decodeMinesProjectFile = Schema.decodeExit(MinesProjectFileFromJson);

export function parseMinesProjectFile(contents: string): MinesProjectFile | null {
  const decoded = decodeMinesProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

export function buildMinesProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(MinesProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: MINES_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
