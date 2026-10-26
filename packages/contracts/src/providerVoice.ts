import * as Schema from "effect/Schema";
import { CommandId, MessageId, RunId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const ProviderVoiceSdp = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(131_072),
);
export const ProviderVoiceCapabilitiesInput = Schema.Struct({
  threadId: ThreadId,
  modelSelection: Schema.optional(ModelSelection),
});
export type ProviderVoiceCapabilitiesInput = typeof ProviderVoiceCapabilitiesInput.Type;
export const ProviderVoiceCapabilities = Schema.Struct({
  live: Schema.Struct({ supported: Schema.Boolean, reason: Schema.optional(Schema.String) }),
  dictation: Schema.Struct({ supported: Schema.Literal(false), reason: Schema.String }),
});
export type ProviderVoiceCapabilities = typeof ProviderVoiceCapabilities.Type;
export const ProviderVoiceStartInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  sdp: ProviderVoiceSdp,
});
export type ProviderVoiceStartInput = typeof ProviderVoiceStartInput.Type;
export const ProviderVoiceStartResult = Schema.Struct({ runId: RunId });
export type ProviderVoiceStartResult = typeof ProviderVoiceStartResult.Type;
export const ProviderVoiceSessionInput = Schema.Struct({ threadId: ThreadId, runId: RunId });
export type ProviderVoiceSessionInput = typeof ProviderVoiceSessionInput.Type;
export const ProviderVoiceEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("started") }),
  Schema.Struct({ type: Schema.Literal("sdp"), sdp: ProviderVoiceSdp }),
  Schema.Struct({
    type: Schema.Literal("transcript"),
    role: Schema.Literals(["user", "assistant"]),
    text: Schema.String.check(Schema.isMaxLength(131_072)),
    done: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    message: Schema.String.check(Schema.isMaxLength(4096)),
  }),
  Schema.Struct({
    type: Schema.Literal("closed"),
    reason: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  }),
]);
export type ProviderVoiceEvent = typeof ProviderVoiceEvent.Type;
export class ProviderVoiceError extends Schema.TaggedError<ProviderVoiceError>()(
  "ProviderVoiceError",
  {
    reason: Schema.Literals([
      "unavailable",
      "unsupported",
      "busy",
      "not-found",
      "invalid",
      "capacity",
      "dispatch",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "Live voice requires a connected Codex ChatGPT account.";
      case "busy":
        return "This mine already has work in progress.";
      case "not-found":
        return "This live voice session is no longer available.";
      case "invalid":
        return "The live voice request is invalid.";
      case "capacity":
        return "Too many live voice sessions are open.";
      case "dispatch":
        return "The live voice run could not be started.";
      case "unavailable":
        return "Live voice is unavailable on this computer.";
    }
  }
}
