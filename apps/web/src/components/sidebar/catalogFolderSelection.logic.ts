import { desktopLocalBackendId } from "../../connection/desktopLocal";
import { normalizeCatalogSourcePath } from "@t3tools/client-runtime/catalog";
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopEnvironmentBootstrap,
  type EnvironmentId,
  type FilesystemEntryMetadata,
} from "@t3tools/contracts";

export async function createCatalogFolderSource(
  input: { readonly environmentId: EnvironmentId; readonly path: string },
  dependencies: {
    readonly isCurrent: () => boolean;
    readonly readMetadata: (
      environmentId: EnvironmentId,
      path: string,
    ) => Promise<FilesystemEntryMetadata | null>;
  },
) {
  const path = normalizeCatalogSourcePath(input.path);
  if (path.length > 512)
    throw new Error("This folder path is too long for this computer's picker.");
  if (!dependencies.isCurrent())
    throw new Error("Computer access changed. Choose the folder again.");
  const metadata = await dependencies.readMetadata(input.environmentId, path);
  if (!dependencies.isCurrent())
    throw new Error("Computer access changed. Choose the folder again.");
  if (!metadata || metadata.kind !== "directory")
    throw new Error("Choose an existing, readable folder.");
  return { environmentId: input.environmentId, path, kind: "directory" as const };
}

export function catalogNativeFolderPickerTarget(
  target: ConnectionTarget,
  bootstraps: readonly DesktopEnvironmentBootstrap[],
): string | null {
  const backendId = desktopLocalBackendId(target);
  if (backendId !== null) return backendId.startsWith("wsl:") ? null : backendId;
  if (target._tag !== "PrimaryConnectionTarget") return null;
  const primary = bootstraps.find((bootstrap) => bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
  if (!primary?.httpBaseUrl || !primary.wsBaseUrl || primary.runningDistro) return null;
  try {
    return new URL(primary.httpBaseUrl).href === new URL(target.httpBaseUrl).href &&
      new URL(primary.wsBaseUrl).href === new URL(target.wsBaseUrl).href
      ? primary.id
      : null;
  } catch {
    return null;
  }
}
