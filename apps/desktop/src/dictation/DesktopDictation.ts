// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Native speech owns child streams and callback timers outside Effect fibers.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import { DesktopDictationCapability, DesktopDictationState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface DictationDriver {
  capability(locale: string): Promise<DesktopDictationCapability>;
  start(sessionId: string, locale: string, publish: (state: DesktopDictationState) => void): void;
  stop(cancel: boolean): void;
  dispose(): void;
}

const decodeState = Schema.decodeUnknownSync(DesktopDictationState);
const decodeCapability = Schema.decodeUnknownSync(DesktopDictationCapability);

function createMacDictationDriver(libraryPath: string): Promise<DictationDriver> {
  return import("ffi-rs").then(({ open, load, DataType }) => {
    const library = "mines-dictation";
    open({ library, path: libraryPath });
    let timer: ReturnType<typeof setInterval> | undefined;
    let previous = "";
    const clear = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const stop = (cancel: boolean) => {
      load({
        library,
        funcName: "mines_dictation_stop",
        retType: DataType.Void,
        paramsType: [DataType.I32],
        paramsValue: [cancel ? 1 : 0],
      });
      if (cancel) clear();
    };
    return {
      capability: async (locale) =>
        decodeCapability(
          JSON.parse(
            load({
              library,
              funcName: "mines_dictation_capability",
              retType: DataType.String,
              paramsType: [DataType.String],
              paramsValue: [locale],
            }),
          ),
        ),
      start: (sessionId, locale, publish) => {
        clear();
        previous = "";
        load({
          library,
          funcName: "mines_dictation_start",
          retType: DataType.Void,
          paramsType: [DataType.String, DataType.String],
          paramsValue: [sessionId, locale],
        });
        const read = () => {
          try {
            const raw = load({
              library,
              funcName: "mines_dictation_snapshot",
              retType: DataType.String,
              paramsType: [],
              paramsValue: [],
            });
            if (raw === previous) return;
            previous = raw;
            const state = decodeState(JSON.parse(raw));
            publish(state);
            if (["finished", "cancelled", "error"].includes(state.phase)) clear();
          } catch {
            stop(true);
            publish({
              sessionId,
              phase: "error",
              transcript: "",
              error: "Could not read native dictation.",
            });
          }
        };
        timer = setInterval(read, 150);
        read();
      },
      stop,
      dispose: () => stop(true),
    };
  });
}

export function createWindowsDictationDriver(script: string): DictationDriver {
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  const run = (mode: string, locale: string, sessionId = "") =>
    NodeChildProcess.spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Mode",
        mode,
        "-Locale",
        locale,
        "-SessionId",
        sessionId,
      ],
      { windowsHide: true, stdio: "pipe" },
    );
  const stop = (cancel: boolean) => {
    if (!child) return;
    if (cancel) {
      child.kill();
      child = null;
    } else child.stdin.write(JSON.stringify({ cancel: false }) + "\n");
  };
  return {
    capability: (locale) =>
      new Promise((resolve) => {
        const probe = run("capability", locale);
        probe.stdout.setEncoding("utf8");
        let output = "";
        const unavailable = {
          available: false,
          locale,
          reason: "Windows speech recognition is unavailable.",
        };
        const timeout = setTimeout(() => {
          probe.kill();
          resolve(unavailable);
        }, 10_000);
        probe.stdout.on("data", (data: string) => {
          if (output.length < 64_000) output += data;
        });
        probe.on("error", () => {
          clearTimeout(timeout);
          resolve(unavailable);
        });
        probe.on("close", () => {
          clearTimeout(timeout);
          try {
            resolve(decodeCapability(JSON.parse(output.trim())));
          } catch {
            resolve(unavailable);
          }
        });
      }),
    start: (sessionId, locale, publish) => {
      stop(true);
      const active = run("capture", locale, sessionId);
      active.stdout.setEncoding("utf8");
      child = active;
      let pending = "";
      let terminal = false;
      const failed = () => {
        if (child !== active || terminal) return;
        terminal = true;
        publish({
          sessionId,
          phase: "error",
          transcript: "",
          error: "Windows dictation stopped unexpectedly.",
        });
      };
      active.stdout.on("data", (data: string) => {
        if (child !== active) return;
        pending += data;
        if (pending.length > 64_000) {
          failed();
          stop(true);
          return;
        }
        let boundary: number;
        while ((boundary = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, boundary).trim();
          pending = pending.slice(boundary + 1);
          if (!line) continue;
          try {
            const state = decodeState(JSON.parse(line));
            terminal = ["finished", "cancelled", "error"].includes(state.phase);
            publish(state);
            if (terminal || child !== active) return;
          } catch {
            failed();
            stop(true);
            return;
          }
        }
      });
      active.on("error", failed);
      active.on("close", () => {
        failed();
        if (child === active) child = null;
      });
    },
    stop,
    dispose: () => stop(true),
  };
}

export async function createDictationDriver(
  platform: string,
  resourceCandidates: (file: string) => readonly string[],
): Promise<DictationDriver | null> {
  const resource =
    platform === "darwin"
      ? "dictation/mines-dictation.dylib"
      : platform === "win32"
        ? "dictation/windows.ps1"
        : null;
  if (!resource) return null;
  const file = resourceCandidates(resource).find(NodeFS.existsSync);
  if (!file) return null;
  return platform === "darwin"
    ? createMacDictationDriver(file)
    : createWindowsDictationDriver(file);
}
