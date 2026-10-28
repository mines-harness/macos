export function selectLocalMacSigningIdentity(
  identities: string,
  configuredFingerprint?: string,
): string {
  const candidates = new Set(
    [
      ...identities.matchAll(
        /^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"Apple Development:[^"\r\n]+"\s*$/gmu,
      ),
    ].map((match) => match[1]!.toUpperCase()),
  );
  const fingerprint = configuredFingerprint?.trim().toUpperCase();
  if (fingerprint) {
    if (!/^[A-F0-9]{40}$/u.test(fingerprint) || !candidates.has(fingerprint)) {
      throw new Error(
        "MINES_DESKTOP_LOCAL_SIGN_IDENTITY must identify a valid Apple Development signing identity in this keychain.",
      );
    }
    return fingerprint;
  }
  if (candidates.size !== 1) {
    throw new Error(
      `Found ${candidates.size} eligible local signing identities. Pin a certificate SHA-1 with MINES_DESKTOP_LOCAL_SIGN_IDENTITY; automatic selection requires exactly one.`,
    );
  }
  return [...candidates][0]!;
}
