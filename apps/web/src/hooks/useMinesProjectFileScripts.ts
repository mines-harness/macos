import {
  MINES_PROJECT_FILE_NAME,
  type EnvironmentId,
  type MinesProjectFile,
  type MinesProjectFileScript,
} from "@t3tools/contracts";
import { parseMinesProjectFile } from "@t3tools/shared/minesProjectFile";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<MinesProjectFileScript> = [];

export interface MinesProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  file: MinesProjectFile | null;
  scripts: ReadonlyArray<MinesProjectFileScript>;
}

export function useMinesProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): MinesProjectFileState {
  const query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    MINES_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  if (contents === null) {
    return {
      status: isPending ? "loading" : "missing",
      file: null,
      scripts: NO_SCRIPTS,
    } as const;
  }
  const file = parseMinesProjectFile(contents);
  if (file === null) {
    return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
  }
  return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
}

export function useMinesProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<MinesProjectFileScript> {
  return useMinesProjectFileState(environmentId, cwd).scripts;
}
