// @effect-diagnostics-next-line nodeBuiltinImport:off -- Wire projection requires a synchronous content revision before encoding.
import * as NodeCrypto from "node:crypto";
import type { OrchestrationV2BodyRange, OrchestrationV2BodyRangeResult } from "@t3tools/contracts";

export const BODY_WINDOW_BYTES = 32 * 1024;

export function bodyWindow(
  text: string,
  field: OrchestrationV2BodyRange["field"],
  before?: number,
): OrchestrationV2BodyRangeResult {
  const bytes = Buffer.from(text, "utf8");
  const endByte = Math.min(before ?? bytes.length, bytes.length);
  let startByte = Math.max(0, endByte - BODY_WINDOW_BYTES);
  while (startByte < endByte && (bytes[startByte]! & 0xc0) === 0x80) startByte += 1;
  return {
    text: bytes.subarray(startByte, endByte).toString("utf8"),
    range: {
      field,
      startByte,
      endByte,
      totalBytes: bytes.length,
      revision: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

export function boundMessageBody<
  T extends { readonly text: string; readonly bodyRange?: OrchestrationV2BodyRange | undefined },
>(message: T): T {
  if (
    message.bodyRange !== undefined ||
    Buffer.byteLength(message.text, "utf8") <= BODY_WINDOW_BYTES
  )
    return message;
  const window = bodyWindow(message.text, "text");
  return { ...message, text: window.text, bodyRange: window.range };
}

export function earlierBodyWindow(
  text: string,
  field: OrchestrationV2BodyRange["field"],
  before: number,
  revision: string,
): OrchestrationV2BodyRangeResult | null {
  const window = bodyWindow(text, field, before);
  if (window.range.revision !== revision || before > window.range.totalBytes || before < 0)
    return null;
  // A caller cannot choose an offset inside a UTF-8 character.
  if (Buffer.byteLength(window.text, "utf8") !== window.range.endByte - window.range.startByte)
    return null;
  return window;
}
