// @effect-diagnostics nodeBuiltinImport:off -- Typed subprocess fixtures replace the Windows speech helper without opening a microphone.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { describe, expect, it, vi } from "vite-plus/test";
import type { DesktopDictationState } from "@t3tools/contracts";
import { createWindowsDictationDriver } from "./DesktopDictation.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function setup() {
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    stdin: new NodeStream.PassThrough(),
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
    kill: vi.fn(() => true),
  });
  const spawn = vi.mocked(NodeChildProcess.spawn);
  spawn.mockReset();
  spawn.mockReturnValue(child as unknown as NodeChildProcess.ChildProcessWithoutNullStreams);
  return {
    child,
    spawn,
    driver: createWindowsDictationDriver("C:\\mines\\dictation\\windows.ps1"),
  };
}

describe("Windows OS dictation adapter", () => {
  it("probes installed Windows speech languages without starting capture", async () => {
    const test = setup();
    const capability = test.driver.capability("fr-FR");
    test.child.stdout.write('{"available":false,"locale":"fr-FR",');
    test.child.stdout.write('"reason":"Install this speech language"}\r\n');
    test.child.emit("close", 0, null);
    expect(await capability).toEqual({
      available: false,
      locale: "fr-FR",
      reason: "Install this speech language",
    });
    expect(test.spawn).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-Mode", "capability", "-Locale", "fr-FR"]),
      expect.objectContaining({ windowsHide: true }),
    );
    expect(test.child.kill).not.toHaveBeenCalled();
    test.driver.dispose();
  });

  it("decodes split capture messages and retains the final draft transcript", () => {
    const test = setup();
    const states: DesktopDictationState[] = [];
    test.driver.start("one", "en-US", (state) => states.push(state));
    test.child.stdout.write('{"sessionId":"one","phase":"record');
    expect(states).toEqual([]);
    test.child.stdout.write('ing","transcript":"","error":null}\r\n');
    test.driver.stop(false);
    expect(test.child.stdin.read()?.toString()).toBe('{"cancel":false}\n');
    const result = Buffer.from(
      '{"sessionId":"one","phase":"finished","transcript":"Écrire des mots","error":null}\n',
    );
    const split = result.indexOf(Buffer.from("É")) + 1;
    test.child.stdout.write(result.subarray(0, split));
    test.child.stdout.write(result.subarray(split));
    test.child.emit("close", 0, null);
    expect(states.map((state) => state.phase)).toEqual(["recording", "finished"]);
    expect(states.at(-1)?.transcript).toBe("Écrire des mots");
    test.driver.dispose();
  });

  it("kills only its owned capture on cancel and ignores late recording events", () => {
    const test = setup();
    const publish = vi.fn();
    test.driver.start("one", "en-US", publish);
    test.driver.stop(true);
    test.child.stdout.write(
      '{"sessionId":"one","phase":"recording","transcript":"","error":null}\n',
    );
    test.child.emit("close", null, "SIGTERM");
    expect(test.child.kill).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    test.driver.dispose();
  });

  it("rejects malformed helper output and releases the owned microphone process", () => {
    const test = setup();
    const states: DesktopDictationState[] = [];
    test.driver.start("one", "en-US", (state) => states.push(state));
    test.child.stdout.write("invalid json\n");
    expect(states.map((state) => state.phase)).toEqual(["error"]);
    expect(test.child.kill).toHaveBeenCalledOnce();
    test.driver.dispose();
  });
});
