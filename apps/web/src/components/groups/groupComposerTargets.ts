import { sha256 } from "@noble/hashes/sha2";
export { groupPlanModeBlockReason } from "@t3tools/client-runtime/group-chat";

export function groupComposerReceiptKey(
  content: string,
  submissionKey: string,
  alternate: boolean,
): string {
  return Array.from(
    sha256(new TextEncoder().encode(JSON.stringify([content, submissionKey, alternate]))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
