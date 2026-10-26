import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings as ServerSettingsConfig,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CloudTaskService from "./CloudTaskService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";

const output = (stdout = "", code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const codexId = ProviderInstanceId.make("cloudCodex");
const claudeId = ProviderInstanceId.make("cloudClaude");
const codexTarget = `cloud:${codexId}`;
const claudeTarget = `cloud:${claudeId}`;
const codexUrl = "https://chatgpt.com/codex/tasks/task_example";
const claudeUrl = "https://claude.ai/code/session_example";

const fixture = Effect.fn("test.cloudFixture")(function* (
  respond: (input: ProcessRunner.ProcessRunInput) => ProcessRunner.ProcessRunOutput = () =>
    output(),
  managed = false,
  settingsOverrides: Partial<ServerSettingsConfig> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "mines-cloud-test-" });
  const calls: ProcessRunner.ProcessRunInput[] = [];
  const providers = new Map<ProviderInstanceId, ServerProvider>();
  const setAuth = (instanceId: ProviderInstanceId, auth: ServerProvider["auth"]) => {
    const driver = ProviderDriverKind.make(instanceId === codexId ? "codex" : "claudeAgent");
    providers.set(instanceId, {
      ...buildServerProvider({
        presentation: { displayName: "Test" },
        enabled: true,
        checkedAt: "2026-10-25T00:00:00.000Z",
        models: [],
        probe: { installed: true, version: "1.0.0", status: "ready", auth },
      }),
      instanceId,
      driver,
    });
  };
  setAuth(codexId, { status: "authenticated", type: "chatgpt", email: "codex@example.test" });
  setAuth(claudeId, { status: "authenticated", type: "max", email: "claude@example.test" });
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        calls.push(input);
        if (
          input.args[0] === "--version" &&
          (input.command === "codex" || input.command === "claude")
        )
          return output(input.command === "claude" ? "2.1.300 (Claude Code)" : "codex-cli 0.163.0");
        if (input.args.join(" ") === "cloud --help")
          return output(
            "  exec Submit\n  list List\n  status Status\n  diff Diff\n  apply Apply\n",
          );
        return respond(input);
      }),
  });
  const dependencies = Layer.mergeAll(
    ServerConfig.layerTest(cwd, cwd),
    ServerSettings.ServerSettingsService.layerTest({
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Personal",
          config: {
            setupMode: managed ? "managed" : "existing",
            binaryPath: "codex",
            homePath: "/native/codex",
          },
        },
        [claudeId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          displayName: "Work",
          config: { binaryPath: "claude", homePath: "/native/claude" },
        },
      },
      ...settingsOverrides,
    }),
    Layer.succeed(ProcessRunner.ProcessRunner, runner),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.sync(() => [...providers.values()]),
    }),
    Layer.succeed(HostProcess.Environment, {
      OPENAI_API_KEY: "must-not-use",
      ANTHROPIC_API_KEY: "must-not-use",
    }),
  );
  const layer = CloudTaskService.layer.pipe(Layer.provideMerge(dependencies));
  return { fs, cwd, calls, layer, setAuth };
});

it.layer(NodeServices.layer)("CloudTaskService", (it) => {
  it.effect("does not invent cloud accounts from empty default profiles", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* fixture(undefined, false, { providerInstances: {} });
      yield* Effect.gen(function* () {
        const service = yield* CloudTaskService.CloudTaskService;
        expect((yield* service.snapshot).targets).toEqual([]);
        expect(
          (yield* service.refresh({ targetId: "cloud:claudeAgent" }).pipe(Effect.flip)).reason,
        ).toBe("target-unavailable");
        expect(calls).toEqual([]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "hides signed-out and API-only accounts without exposing executable cloud targets",
    () =>
      Effect.gen(function* () {
        const { layer, calls, cwd, setAuth } = yield* fixture();
        setAuth(codexId, { status: "unauthenticated" });
        setAuth(claudeId, { status: "authenticated", type: "apiKey" });
        yield* Effect.gen(function* () {
          const service = yield* CloudTaskService.CloudTaskService;
          expect((yield* service.snapshot).targets).toEqual([]);
          const result = yield* service
            .submit({
              requestId: "signed-out",
              targetId: codexTarget,
              cwd,
              environmentId: "env_test",
              prompt: "Do not send",
            })
            .pipe(Effect.flip);
          expect(result.reason).toBe("target-unavailable");
          expect(calls).toEqual([]);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect(
    "preserves account-owned tasks through sign-out and unknown auth without executing them",
    () =>
      Effect.gen(function* () {
        const { layer, calls, setAuth } = yield* fixture();
        yield* Effect.gen(function* () {
          const service = yield* CloudTaskService.CloudTaskService;
          const task = yield* service.link({ targetId: codexTarget, url: codexUrl });
          setAuth(codexId, { status: "unauthenticated" });
          const signedOut = yield* service.snapshot;
          expect(signedOut.targets.some((target) => target.id === codexTarget)).toBe(false);
          expect(signedOut.tasks).toContainEqual(task);
          setAuth(codexId, { status: "unknown" });
          const unknown = yield* service.snapshot;
          expect(unknown.targets.some((target) => target.id === codexTarget)).toBe(false);
          expect(unknown.tasks).toContainEqual(task);
          expect((yield* service.status({ taskId: task.id }).pipe(Effect.flip)).reason).toBe(
            "target-unavailable",
          );
          expect(calls.some((call) => call.args[1] === "status")).toBe(false);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("never executes a retained task with a different account in the same profile", () =>
    Effect.gen(function* () {
      const { layer, calls, setAuth } = yield* fixture();
      yield* Effect.gen(function* () {
        const service = yield* CloudTaskService.CloudTaskService;
        const task = yield* service.link({ targetId: codexTarget, url: codexUrl });
        setAuth(codexId, {
          status: "authenticated",
          type: "chatgpt",
          email: "another@example.test",
        });
        expect((yield* service.status({ taskId: task.id }).pipe(Effect.flip)).reason).toBe(
          "target-unavailable",
        );
        expect((yield* service.snapshot).tasks).toContainEqual(task);
        expect(calls.some((call) => call.args[1] === "status")).toBe(false);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("retains a previously bound cloud account across restarts with an unknown probe", () =>
    Effect.gen(function* () {
      const { layer, setAuth } = yield* fixture();
      yield* Effect.gen(function* () {
        expect((yield* (yield* CloudTaskService.CloudTaskService).snapshot).targets).toHaveLength(
          2,
        );
      }).pipe(Effect.provide(layer));
      setAuth(codexId, { status: "unknown" });
      setAuth(claudeId, { status: "unknown" });
      yield* Effect.gen(function* () {
        const snapshot = yield* (yield* CloudTaskService.CloudTaskService).snapshot;
        expect(snapshot.targets).toHaveLength(2);
        expect(snapshot.targets.every((target) => target.bridgeStatus === "unavailable")).toBe(
          true,
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps cloud execution distinct from an unavailable native CLI bridge", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* fixture(undefined, true);
      yield* Effect.gen(function* () {
        const service = yield* CloudTaskService.CloudTaskService;
        const snapshot = yield* service.snapshot;
        const target = snapshot.targets.find((item) => item.id === codexTarget);
        expect(target?.executionLocation).toBe("provider-cloud");
        expect(target?.bridgeStatus).toBe("unavailable");
        expect(target?.reason).toContain("token sharing");
        const linked = yield* service.link({ targetId: codexTarget, url: codexUrl });
        expect(linked.status).toBe("linked");
        expect(calls.some((call) => call.env?.CODEX_HOME === "/native/codex")).toBe(false);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("isolates account CLI homes and deduplicates a paid submission across reconnects", () =>
    Effect.gen(function* () {
      const { layer, calls, cwd } = yield* fixture(() => output(codexUrl));
      yield* Effect.gen(function* () {
        const service = yield* CloudTaskService.CloudTaskService;
        const input = {
          requestId: "request-one",
          targetId: codexTarget,
          cwd,
          environmentId: "env_test",
          prompt: "Review shell text: $(secret) `date`",
        };
        const [first, second] = yield* Effect.all([service.submit(input), service.submit(input)], {
          concurrency: "unbounded",
        });
        expect(first.id).toBe(second.id);
        expect(first.status).toBe("submitted");
        const commands = calls.filter((call) => call.args[1] === "exec");
        expect(commands).toHaveLength(1);
        expect(commands[0]?.env?.CODEX_HOME).toBe("/native/codex");
        expect(commands[0]?.env?.OPENAI_API_KEY).toBe("");
        expect(commands[0]?.args.at(-1)).toBe(input.prompt);
        expect(commands[0]?.args.at(-2)).toBe("--");
        const conflict = yield* service
          .submit({ ...input, prompt: "Different work" })
          .pipe(Effect.flip);
        expect(conflict.reason).toBe("request-conflict");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("retains unknown submission outcomes and never retries them automatically", () =>
    Effect.gen(function* () {
      const { layer, calls, cwd } = yield* fixture(() => output("Configuration not understood", 1));
      yield* Effect.gen(function* () {
        const service = yield* CloudTaskService.CloudTaskService;
        const input = {
          requestId: "unknown-one",
          targetId: claudeTarget,
          cwd,
          prompt: "Implement the task",
        };
        const first = yield* service.submit(input);
        expect(first.status).toBe("submission-unknown");
        expect((yield* service.submit(input)).id).toBe(first.id);
        expect(calls.filter((call) => call.args[0] === "--cloud")).toHaveLength(1);
        expect((yield* service.snapshot).tasks).toContainEqual(first);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("queues a Claude follow-up without claiming the cloud turn completed", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* fixture(() =>
        output(JSON.stringify({ ok: true, session_id: "session_example", url: claudeUrl })),
      );
      yield* Effect.gen(function* () {
        const service = yield* CloudTaskService.CloudTaskService;
        const task = yield* service.link({
          targetId: claudeTarget,
          url: `${claudeUrl}?from=cli&m=0`,
        });
        expect(task.url).toBe(claudeUrl);
        const result = yield* service.followUp({
          requestId: "followup-one",
          taskId: task.id,
          prompt: "Please continue",
        });
        expect(result.status).toBe("submitted");
        expect(result.summary).toContain("not completion");
        const command = calls.find((call) => call.args[0] === "-p");
        expect(command?.args).toEqual([
          "-p",
          "--cloud",
          "session_example",
          "--output-format",
          "json",
        ]);
        expect(command?.stdin).toBe("Please continue");
        expect(command?.env?.CLAUDE_CONFIG_DIR).toBe("/native/claude");
        expect(command?.env?.ANTHROPIC_API_KEY).toBe("");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "rejects provider-lookalike URLs and cannot run CLI operations on generic ChatGPT conversations",
    () =>
      Effect.gen(function* () {
        const { layer, calls } = yield* fixture();
        yield* Effect.gen(function* () {
          const service = yield* CloudTaskService.CloudTaskService;
          for (const url of [
            "https://claude.ai.attacker.test/code/session_bad",
            "https://user:secret@claude.ai/code/session_bad",
            "http://claude.ai/code/session_bad",
          ]) {
            expect(
              (yield* service.link({ targetId: claudeTarget, url }).pipe(Effect.flip)).reason,
            ).toBe("invalid-input");
          }
          const linked = yield* service.link({
            targetId: codexTarget,
            url: "https://chatgpt.com/c/conversation-test",
          });
          expect(linked.providerTaskId).toBeUndefined();
          expect((yield* service.status({ taskId: linked.id }).pipe(Effect.flip)).reason).toBe(
            "unsupported",
          );
          expect(calls.some((call) => call.args[1] === "status")).toBe(false);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("paginates real Codex task summaries without treating them as full transcripts", () =>
    Effect.gen(function* () {
      const { layer } = yield* fixture(() =>
        output(
          JSON.stringify({
            tasks: [
              {
                id: "task_example",
                url: codexUrl,
                title: "Cloud work",
                status: "running",
                summary: "Preparing repository",
              },
            ],
            cursor: "next-page",
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* CloudTaskService.CloudTaskService;
        const first = yield* service.refresh({ targetId: codexTarget });
        const second = yield* service.refresh({ targetId: codexTarget, cursor: first.cursor });
        expect(second.tasks[0]?.id).toBe(first.tasks[0]?.id);
        expect(first.cursor).toBe("next-page");
        expect(first.tasks[0]?.status).toBe("running");
        const snapshot = yield* service.snapshot;
        expect(snapshot.tasks).toHaveLength(1);
        expect(
          snapshot.targets.find((target) => target.id === codexTarget)?.capabilities.transcript,
        ).toBe(false);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "requires the reviewed diff and a clean workspace before applying an explicit attempt",
    () =>
      Effect.gen(function* () {
        const patch = "diff --git a/file.txt b/file.txt\n+hello\n";
        let dirty = true;
        const { layer, calls, cwd } = yield* fixture((input) =>
          input.command === "git" ? output(dirty ? " M file.txt\n" : "") : output(patch),
        );
        yield* Effect.gen(function* () {
          const service = yield* CloudTaskService.CloudTaskService;
          const task = yield* service.link({ targetId: codexTarget, url: codexUrl });
          const reviewed = yield* service.diff({ taskId: task.id, attempt: 2 });
          const input = { taskId: task.id, attempt: 2, cwd, reviewedDigest: reviewed.digest };
          expect(
            (yield* service.apply({ ...input, reviewedDigest: "wrong" }).pipe(Effect.flip)).reason,
          ).toBe("diff-changed");
          expect((yield* service.apply(input).pipe(Effect.flip)).reason).toBe("workspace-dirty");
          expect(calls.some((call) => call.args[1] === "apply")).toBe(false);
          dirty = false;
          expect(yield* service.apply(input)).toEqual({ applied: true });
          expect(calls.find((call) => call.args[1] === "apply")?.args).toEqual([
            "cloud",
            "apply",
            "task_example",
            "--attempt",
            "2",
          ]);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("persists links and request receipts across service restarts", () =>
    Effect.gen(function* () {
      const { layer, cwd, calls } = yield* fixture(() => output(codexUrl));
      const input = {
        requestId: "persistent-one",
        targetId: codexTarget,
        cwd,
        environmentId: "env_test",
        prompt: "Persist this task",
      };
      const first = yield* Effect.gen(function* () {
        return yield* (yield* CloudTaskService.CloudTaskService).submit(input);
      }).pipe(Effect.provide(layer));
      const second = yield* Effect.gen(function* () {
        const service = yield* CloudTaskService.CloudTaskService;
        expect((yield* service.snapshot).tasks[0]?.id).toBe(first.id);
        return yield* service.submit(input);
      }).pipe(Effect.provide(layer));
      expect(second.id).toBe(first.id);
      expect(calls.filter((call) => call.args[1] === "exec")).toHaveLength(1);
    }),
  );

  it.effect("does not prevent service startup or overwrite an invalid task registry", () =>
    Effect.gen(function* () {
      const { layer, fs, cwd, calls } = yield* fixture();
      yield* fs.makeDirectory(`${cwd}/userdata`, { recursive: true });
      yield* fs.writeFileString(`${cwd}/userdata/cloud-tasks.json`, "broken-json");
      yield* Effect.gen(function* () {
        const service = yield* CloudTaskService.CloudTaskService;
        const result = yield* service
          .submit({
            requestId: "never-submit",
            targetId: codexTarget,
            cwd,
            environmentId: "env_test",
            prompt: "Must not be launched",
          })
          .pipe(Effect.flip);
        expect(result.reason).toBe("persistence-failed");
        expect(calls.some((call) => call.args[1] === "exec")).toBe(false);
        expect(yield* fs.readFileString(`${cwd}/userdata/cloud-tasks.json`)).toBe("broken-json");
      }).pipe(Effect.provide(layer));
    }),
  );
});
