import { DesktopDictationCapability, DesktopDictationState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { createDictationDriver } from "../../dictation/DesktopDictation.ts";
import { DictationCapture } from "../../dictation/DictationCapture.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

const SessionId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Locale = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));
const encodeState = Schema.encodeSync(DesktopDictationState);
class DictationIpcUntrustedSender extends Schema.TaggedError<DictationIpcUntrustedSender>()(
  "DictationIpcUntrustedSender",
  {},
) {}

export const installDictationIpc = Effect.fn("desktop.ipc.installDictation")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const window = yield* ElectronWindow.ElectronWindow;
  let driver: ReturnType<typeof createDictationDriver> | undefined;
  const loadDriver = () =>
    (driver ??= createDictationDriver(
      environment.platform,
      environment.resolveResourcePathCandidates,
    ).catch(() => null));
  const capture = new DictationCapture(loadDriver);
  yield* Effect.addFinalizer(() => Effect.sync(() => capture.dispose()));
  const trusted = Effect.fn("desktop.ipc.dictation.trustedSender")(function* (
    event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
  ) {
    const main = yield* window.main;
    if (!event || Option.isNone(main) || main.value.webContents.id !== event.sender.id) {
      return yield* new DictationIpcUntrustedSender();
    }
    return main.value;
  });
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.GET_DICTATION_CAPABILITY_CHANNEL,
      payload: Locale,
      result: DesktopDictationCapability,
      handler: Effect.fn("desktop.ipc.dictation.capability")(function* (locale, event) {
        yield* trusted(event);
        const native = yield* Effect.tryPromise(loadDriver);
        if (!native)
          return {
            available: false,
            locale,
            reason: "Local dictation is unavailable on this computer.",
          };
        return yield* Effect.tryPromise(() => native.capability(locale));
      }),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.START_DICTATION_CHANNEL,
      payload: Schema.Struct({ sessionId: SessionId, locale: Locale }),
      result: Schema.Void,
      handler: Effect.fn("desktop.ipc.dictation.start")(function* ({ sessionId, locale }, event) {
        const main = yield* trusted(event);
        const contents = main.webContents;
        const cancel = () => capture.stop(sessionId, true);
        contents.once("destroyed", cancel);
        contents.once("render-process-gone", cancel);
        contents.once("did-start-navigation", cancel);
        const release = () => {
          contents.removeListener("destroyed", cancel);
          contents.removeListener("render-process-gone", cancel);
          contents.removeListener("did-start-navigation", cancel);
        };
        yield* Effect.tryPromise(() =>
          capture.start(
            sessionId,
            locale,
            (state) => {
              if (!contents.isDestroyed())
                contents.send(Channels.DICTATION_STATE_CHANNEL, encodeState(state));
            },
            release,
          ),
        ).pipe(Effect.tapError(() => Effect.sync(release)));
      }),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.STOP_DICTATION_CHANNEL,
      payload: Schema.Struct({ sessionId: SessionId, cancel: Schema.Boolean }),
      result: Schema.Void,
      handler: Effect.fn("desktop.ipc.dictation.stop")(function* ({ sessionId, cancel }, event) {
        yield* trusted(event);
        capture.stop(sessionId, cancel);
      }),
    }),
  );
});
