import {
  MINES_PROJECT_FILE_NAME,
  type EnvironmentId,
  type MinesProjectFile,
} from "@t3tools/contracts";
import { parseMinesProjectFile } from "@t3tools/shared/minesProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export async function readMinesProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<MinesProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, MINES_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    MINES_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.exists === false || data.truncated) return null;
  return parseMinesProjectFile(data.contents);
}
