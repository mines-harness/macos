import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(minesHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(minesHome)) {
    return Option.none();
  }
  const trimmed = minesHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly minesHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.minesHome), () =>
    input.joinPath(input.homeDirectory, ".mines"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly minesHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.minesHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
