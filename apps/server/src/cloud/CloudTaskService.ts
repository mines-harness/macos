import {
  ClaudeSettings,
  CloudOperationError,
  CloudTask,
  CodexSettings,
  ProviderInstanceId,
  type CloudApplyInput,
  type CloudApplyResult,
  type CloudCapabilities,
  type CloudDiffInput,
  type CloudDiffResult,
  CloudFollowUpInput,
  type CloudLinkInput,
  type CloudProvider,
  type CloudRefreshInput,
  type CloudRefreshResult,
  type CloudSnapshot,
  CloudSubmitInput,
  type CloudTarget,
  type CloudTaskInput,
  type CloudTaskStatus,
  type ProviderInstanceConfig,
  type ServerProviderAuth,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

const RequestReceipt = Schema.Struct({
  id: Schema.String,
  fingerprint: Schema.String,
  taskId: Schema.String,
});
const Registry = Schema.Struct({
  version: Schema.Literal(1),
  tasks: Schema.Array(CloudTask),
  requests: Schema.Array(RequestReceipt),
  accounts: Schema.optional(Schema.Array(ProviderInstanceId)),
});
type Registry = typeof Registry.Type;

const CodexList = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      url: Schema.String,
      title: Schema.String,
      status: Schema.String,
      updated_at: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
      summary: Schema.optional(Schema.Unknown),
    }),
  ),
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
});
const ClaudeReceipt = Schema.Struct({
  ok: Schema.Boolean,
  session_id: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
});

const decodeRegistry = Schema.decodeUnknownEffect(Schema.fromJsonString(Registry));
const encodeRegistry = Schema.encodeEffect(Schema.fromJsonString(Registry));
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexList = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexList));
const encodeSubmit = Schema.encodeEffect(Schema.fromJsonString(CloudSubmitInput));
const encodeFollowUp = Schema.encodeEffect(Schema.fromJsonString(CloudFollowUpInput));
const decodeClaudeReceipt = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeReceipt));

const noCapabilities: CloudCapabilities = {
  submit: false,
  list: false,
  followUp: false,
  status: false,
  diff: false,
  apply: false,
  transcript: false,
  cancel: false,
};
const capabilitiesFor = (provider: CloudProvider): CloudCapabilities => ({
  ...noCapabilities,
  submit: true,
  list: provider === "codex",
  followUp: provider === "claude",
  status: provider === "codex",
  diff: provider === "codex",
  apply: provider === "codex",
});

interface TargetRuntime {
  readonly target: CloudTarget;
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
  readonly visible: boolean;
  readonly accountKey?: string;
}

export class CloudTaskService extends Context.Service<
  CloudTaskService,
  {
    readonly snapshot: Effect.Effect<CloudSnapshot, CloudOperationError>;
    readonly refresh: (
      input: CloudRefreshInput,
    ) => Effect.Effect<CloudRefreshResult, CloudOperationError>;
    readonly submit: (input: CloudSubmitInput) => Effect.Effect<CloudTask, CloudOperationError>;
    readonly link: (input: CloudLinkInput) => Effect.Effect<CloudTask, CloudOperationError>;
    readonly followUp: (input: CloudFollowUpInput) => Effect.Effect<CloudTask, CloudOperationError>;
    readonly status: (input: CloudTaskInput) => Effect.Effect<CloudTask, CloudOperationError>;
    readonly diff: (input: CloudDiffInput) => Effect.Effect<CloudDiffResult, CloudOperationError>;
    readonly apply: (
      input: CloudApplyInput,
    ) => Effect.Effect<CloudApplyResult, CloudOperationError>;
    readonly unlink: (input: CloudTaskInput) => Effect.Effect<void, CloudOperationError>;
  }
>()("mines/cloud/CloudTaskService") {}

function providerFor(entry: ProviderInstanceConfig): CloudProvider | undefined {
  return entry.driver === "codex" ? "codex" : entry.driver === "claudeAgent" ? "claude" : undefined;
}

function parseProviderLink(provider: CloudProvider, value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    if (provider === "claude" && url.hostname === "claude.ai") {
      const id = /^\/code\/((?:session_|cse_)[A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1];
      return id ? { url: `https://claude.ai/code/${id}`, providerTaskId: id } : undefined;
    }
    if (provider === "codex" && url.hostname === "chatgpt.com") {
      const taskId = /^\/codex\/tasks\/(task_[A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1];
      if (taskId)
        return { url: `https://chatgpt.com/codex/tasks/${taskId}`, providerTaskId: taskId };
      // Current ChatGPT cloud conversations can be linked without pretending their IDs are CLI task IDs.
      const conversationId = /^\/c\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1];
      if (conversationId) return { url: `https://chatgpt.com/c/${conversationId}` };
    }
  } catch {
    /* Invalid provider URLs do not become executable task identifiers. */
  }
  return undefined;
}

function linkFromOutput(provider: CloudProvider, output: string) {
  // ANSI escapes delimit terminal links and must never become part of a provider URL.
  // eslint-disable-next-line no-control-regex
  for (const match of output.matchAll(/https:\/\/(?:chatgpt\.com|claude\.ai)\/[^\s<>"'\u001b]+/g)) {
    const link = parseProviderLink(provider, match[0].replace(/[).,;]+$/, ""));
    if (link) return link;
  }
  return undefined;
}

function statusFromProvider(status: string): CloudTaskStatus {
  switch (status.toLowerCase()) {
    case "ready":
    case "completed":
    case "complete":
    case "succeeded":
      return "completed";
    case "running":
    case "in_progress":
    case "inprogress":
      return "running";
    case "queued":
    case "pending":
    case "submitted":
      return "submitted";
    case "failed":
    case "error":
    case "cancelled":
    case "canceled":
      return "failed";
    default:
      return "unknown";
  }
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const crypto = yield* Crypto.Crypto;
  const home = yield* HostProcess.HomeDirectory;
  const ambient = yield* HostProcess.Environment;
  const mutation = yield* Semaphore.make(1);
  const registryPath = path.join(server.stateDir, "cloud-tasks.json");
  const state = yield* Effect.cached(
    fs.readFileString(registryPath).pipe(
      Effect.flatMap(decodeRegistry),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed({ version: 1 as const, tasks: [], requests: [] })
            : Effect.fail(new CloudOperationError({ reason: "persistence-failed" })),
        SchemaError: () => Effect.fail(new CloudOperationError({ reason: "persistence-failed" })),
      }),
      Effect.flatMap((registry) => Ref.make<Registry>(registry)),
    ),
  );
  const newId = crypto
    .randomUUIDv4()
    .pipe(Effect.mapError(() => new CloudOperationError({ reason: "persistence-failed" })));
  const digest = Effect.fn("CloudTaskService.digest")((value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
      Effect.mapError(() => new CloudOperationError({ reason: "command-failed" })),
    ),
  );

  const save = Effect.fn("CloudTaskService.save")(function* (next: Registry) {
    const contents = yield* encodeRegistry(next).pipe(
      Effect.mapError(() => new CloudOperationError({ reason: "persistence-failed" })),
    );
    yield* writeFileStringAtomically({ filePath: registryPath, contents: `${contents}\n` }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => new CloudOperationError({ reason: "persistence-failed" })),
    );
    yield* Ref.set(yield* state, next);
  });

  const putTask = Effect.fn("CloudTaskService.putTask")(function* (task: CloudTask) {
    const current = yield* Ref.get(yield* state);
    yield* save({
      ...current,
      tasks: [...current.tasks.filter((item) => item.id !== task.id), task],
    });
    return task;
  });

  const readEntries = Effect.fn("CloudTaskService.readEntries")(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => new CloudOperationError({ reason: "target-unavailable" })),
    );
    // Cloud devices are account-wide; project overrides must not enable a disabled account here.
    const instances = deriveProviderInstanceConfigMap({
      ...current,
      projectSettingsOverrides: {},
    });
    const snapshots = yield* providers.getProviders;
    return Object.entries(instances).flatMap(([id, entry]) => {
      const provider = providerFor(entry);
      return provider
        ? [
            {
              instanceId: ProviderInstanceId.make(id),
              entry,
              provider,
              auth: snapshots.find((snapshot) => snapshot.instanceId === id)?.auth ?? {
                status: "unknown" as const,
              },
            },
          ]
        : [];
    });
  });

  const resolveRuntime = Effect.fn("CloudTaskService.resolveRuntime")(function* (
    instanceId: ProviderInstanceId,
    entry: ProviderInstanceConfig,
    provider: CloudProvider,
    auth: ServerProviderAuth,
  ): Effect.fn.Return<TargetRuntime, CloudOperationError> {
    const base: CloudTarget = {
      id: `cloud:${instanceId}`,
      provider,
      instanceId,
      label: `${provider === "codex" ? "Codex" : "Claude"} Cloud · ${entry.displayName ?? instanceId}`,
      executionLocation: "provider-cloud",
      bridgeStatus: "unavailable",
      cliVersion: null,
      capabilities: noCapabilities,
    };
    const current = yield* Ref.get(yield* state);
    const bound =
      auth.status === "authenticated" &&
      (provider === "codex"
        ? auth.type === "chatgpt"
        : !["apiKey", "bedrock", "vertex", "foundry", "customEndpoint"].includes(auth.type ?? "") &&
          Boolean(auth.type || auth.email));
    const known =
      current.accounts?.includes(instanceId) ??
      current.tasks.some((task) => task.targetId === base.id);
    const visible = bound || (auth.status === "unknown" && Boolean(known));
    const environment = yield* mergeProviderInstanceEnvironment(entry.environment, ambient);
    const identity = auth.profileId ?? auth.email?.toLowerCase() ?? auth.workspaceId;
    const accountKey = bound && identity ? yield* digest(`${provider}:${identity}`) : undefined;
    if (!bound)
      return {
        target: {
          ...base,
          reason: "Sign in to this provider account in Providers to use its cloud device.",
        },
        command: provider,
        env: environment,
        visible,
        ...(accountKey ? { accountKey } : {}),
      };
    const config: Option.Option<CodexSettings | ClaudeSettings> =
      provider === "codex"
        ? decodeCodexSettings(entry.config ?? {})
        : decodeClaudeSettings(entry.config ?? {});
    if (Option.isNone(config) || entry.enabled === false || config.value.enabled === false) {
      return {
        visible,
        ...(accountKey ? { accountKey } : {}),
        target: { ...base, reason: "Enable and configure this account in Providers." },
        command: provider,
        env: environment,
      };
    }
    const command = expandHomePath(config.value.binaryPath, home);
    let env = environment;
    if (provider === "codex") {
      const codex = config.value as CodexSettings;
      if (codex.setupMode === "managed") {
        return {
          visible,
          ...(accountKey ? { accountKey } : {}),
          target: {
            ...base,
            reason:
              "Cloud needs an existing Codex CLI account signed in with ChatGPT. Managed token sharing does not expose cloud authentication.",
          },
          command,
          env,
        };
      }
      const layout = yield* resolveCodexHomeLayout(codex).pipe(
        Effect.provideService(Path.Path, path),
      );
      env = {
        ...environment,
        ...(layout.effectiveHomePath ? { CODEX_HOME: layout.effectiveHomePath } : {}),
        OPENAI_API_KEY: "",
      };
    } else {
      env = yield* makeClaudeEnvironment(config.value, environment).pipe(
        Effect.provideService(Path.Path, path),
      );
      if (
        [env.CLAUDE_CODE_USE_BEDROCK, env.CLAUDE_CODE_USE_VERTEX, env.CLAUDE_CODE_USE_FOUNDRY].some(
          (value) => value === "1" || value === "true",
        )
      ) {
        return {
          visible,
          ...(accountKey ? { accountKey } : {}),
          target: {
            ...base,
            reason: "Claude Cloud requires a native Claude subscription account.",
          },
          command,
          env,
        };
      }
      env = { ...env, ANTHROPIC_API_KEY: "" };
    }
    const version = yield* processRunner
      .run({
        command,
        args: ["--version"],
        env,
        stdin: "",
        timeout: "5 seconds",
        maxOutputBytes: 4096,
      })
      .pipe(Effect.option);
    if (Option.isNone(version) || version.value.code !== 0) {
      return {
        visible,
        ...(accountKey ? { accountKey } : {}),
        target: {
          ...base,
          reason: "Install the provider CLI on this computer to control cloud tasks.",
        },
        command,
        env,
      };
    }
    const cliVersion =
      /\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?/.exec(version.value.stdout)?.[0] ?? null;
    if (!cliVersion)
      return {
        visible,
        ...(accountKey ? { accountKey } : {}),
        target: { ...base, reason: "The CLI version could not be identified." },
        command,
        env,
      };
    let capabilities = capabilitiesFor(provider);
    if (provider === "codex") {
      const help = yield* processRunner
        .run({
          command,
          args: ["cloud", "--help"],
          env,
          stdin: "",
          timeout: "5 seconds",
          maxOutputBytes: 16384,
        })
        .pipe(Effect.option);
      if (Option.isNone(help) || help.value.code !== 0) capabilities = noCapabilities;
      else {
        const advertised = (name: string) =>
          new RegExp(`^\\s*${name}\\s`, "m").test(help.value.stdout);
        capabilities = {
          ...capabilities,
          submit: advertised("exec"),
          list: advertised("list"),
          status: advertised("status"),
          diff: advertised("diff"),
          apply: advertised("apply"),
        };
      }
    }
    return {
      visible,
      ...(accountKey ? { accountKey } : {}),
      target: {
        ...base,
        cliVersion,
        capabilities,
        bridgeStatus: capabilities.submit ? "available" : "unavailable",
        reason: capabilities.submit
          ? "Cloud access is checked by the provider when you send. Tasks keep running if this computer goes offline."
          : "This CLI version does not advertise the required cloud commands.",
      },
      command,
      env,
    };
  });

  const targetRuntime = Effect.fn("CloudTaskService.targetRuntime")(function* (targetId: string) {
    const entry = (yield* readEntries()).find((item) => `cloud:${item.instanceId}` === targetId);
    if (!entry) return yield* new CloudOperationError({ reason: "not-found" });
    const runtime = yield* resolveRuntime(
      entry.instanceId,
      entry.entry,
      entry.provider,
      entry.auth,
    );
    if (!runtime.visible) return yield* new CloudOperationError({ reason: "target-unavailable" });
    return runtime;
  });

  const taskRuntime = Effect.fn("CloudTaskService.taskRuntime")(function* (task: CloudTask) {
    const runtime = yield* targetRuntime(task.targetId);
    if (task.accountKey && task.accountKey !== runtime.accountKey)
      return yield* new CloudOperationError({ reason: "target-unavailable" });
    return runtime;
  });

  const requireCapability = (runtime: TargetRuntime, capability: keyof CloudCapabilities) => {
    if (runtime.target.bridgeStatus !== "available")
      return Effect.fail(new CloudOperationError({ reason: "target-unavailable" }));
    return runtime.target.capabilities[capability]
      ? Effect.void
      : Effect.fail(new CloudOperationError({ reason: "unsupported" }));
  };

  const getTask = Effect.fn("CloudTaskService.getTask")(function* (taskId: string) {
    const task = (yield* Ref.get(yield* state)).tasks.find((item) => item.id === taskId);
    if (!task) return yield* new CloudOperationError({ reason: "not-found" });
    return task;
  });

  const run = Effect.fn("CloudTaskService.run")(function* (
    runtime: TargetRuntime,
    args: ReadonlyArray<string>,
    options: {
      readonly cwd?: string;
      readonly stdin?: string;
      readonly maxOutputBytes?: number;
      readonly onStdoutChunk?: (chunk: Uint8Array) => void;
    } = {},
  ) {
    return yield* processRunner
      .run({
        command: runtime.command,
        args,
        env: runtime.env,
        stdin: options.stdin ?? "",
        ...(options.cwd ? { cwd: options.cwd } : {}),
        timeout: "90 seconds",
        maxOutputBytes: options.maxOutputBytes ?? 1_048_576,
        ...(options.onStdoutChunk ? { onStdoutChunk: options.onStdoutChunk } : {}),
      })
      .pipe(Effect.mapError(() => new CloudOperationError({ reason: "command-failed" })));
  });

  const validateDirectory = Effect.fn("CloudTaskService.validateDirectory")(function* (
    cwd: string,
  ) {
    if (!path.isAbsolute(cwd)) return yield* new CloudOperationError({ reason: "invalid-input" });
    const stat = yield* fs
      .stat(cwd)
      .pipe(Effect.mapError(() => new CloudOperationError({ reason: "invalid-input" })));
    if (stat.type !== "Directory")
      return yield* new CloudOperationError({ reason: "invalid-input" });
  });

  const existingRequest = Effect.fn("CloudTaskService.existingRequest")(function* (
    id: string,
    fingerprint: string,
  ) {
    const request = (yield* Ref.get(yield* state)).requests.find((item) => item.id === id);
    if (!request) return undefined;
    if (request.fingerprint !== fingerprint)
      return yield* new CloudOperationError({ reason: "request-conflict" });
    return yield* getTask(request.taskId);
  });

  const beginRequest = Effect.fn("CloudTaskService.beginRequest")(function* (
    id: string,
    fingerprint: string,
    task: CloudTask,
  ) {
    const current = yield* Ref.get(yield* state);
    yield* save({
      ...current,
      tasks: [...current.tasks.filter((item) => item.id !== task.id), task],
      requests: [...current.requests, { id, fingerprint, taskId: task.id }],
    });
  });

  const diff: CloudTaskService["Service"]["diff"] = Effect.fn("CloudTaskService.diff")(
    function* (input) {
      const task = yield* getTask(input.taskId);
      const runtime = yield* taskRuntime(task);
      yield* requireCapability(runtime, "diff");
      if (!task.providerTaskId) return yield* new CloudOperationError({ reason: "unsupported" });
      const result = yield* run(
        runtime,
        ["cloud", "diff", task.providerTaskId, "--attempt", String(input.attempt)],
        { maxOutputBytes: 4_194_304 },
      );
      if (result.code !== 0) return yield* new CloudOperationError({ reason: "command-failed" });
      return {
        taskId: task.id,
        attempt: input.attempt,
        text: result.stdout,
        digest: yield* digest(result.stdout),
      };
    },
  );

  return CloudTaskService.of({
    snapshot: mutation.withPermit(
      Effect.gen(function* () {
        const entries = yield* readEntries();
        const runtimes = yield* Effect.forEach(
          entries,
          (entry) => resolveRuntime(entry.instanceId, entry.entry, entry.provider, entry.auth),
          { concurrency: 4 },
        );

        const current = yield* Ref.get(yield* state);
        const hidden = new Set(
          runtimes
            .filter((runtime) => !runtime.visible)
            .map((runtime) => runtime.target.instanceId),
        );
        const accounts = [
          ...new Set([
            ...(current.accounts ?? []).filter((instanceId) => !hidden.has(instanceId)),
            ...runtimes
              .filter((runtime) => runtime.visible)
              .map((runtime) => runtime.target.instanceId),
          ]),
        ];
        if (
          !current.accounts ||
          accounts.length !== current.accounts.length ||
          accounts.some((instanceId, index) => instanceId !== current.accounts?.[index])
        )
          yield* save({ ...current, accounts });
        return {
          checkedAt: yield* nowIso,
          targets: runtimes.filter((runtime) => runtime.visible).map((runtime) => runtime.target),
          tasks: current.tasks,
        };
      }),
    ),

    refresh: Effect.fn("CloudTaskService.refresh")(function* (input) {
      const runtime = yield* targetRuntime(input.targetId);
      yield* requireCapability(runtime, "list");
      const result = yield* run(runtime, [
        "cloud",
        "list",
        "--json",
        "--limit",
        "20",
        ...(input.cursor ? ["--cursor", input.cursor] : []),
      ]);
      if (result.code !== 0) return yield* new CloudOperationError({ reason: "command-failed" });
      const parsed = yield* decodeCodexList(result.stdout).pipe(
        Effect.mapError(() => new CloudOperationError({ reason: "output-invalid" })),
      );
      return yield* mutation.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(yield* state);
          const now = yield* nowIso;
          const tasks: CloudTask[] = [];
          for (const item of parsed.tasks) {
            const link = parseProviderLink("codex", item.url);
            if (!link?.providerTaskId || link.providerTaskId !== item.id)
              return yield* new CloudOperationError({ reason: "output-invalid" });
            const previous = current.tasks.find(
              (task) =>
                task.targetId === input.targetId &&
                task.providerTaskId === item.id &&
                (!task.accountKey || task.accountKey === runtime.accountKey),
            );
            tasks.push({
              id: previous?.id ?? (yield* newId),
              targetId: input.targetId,
              ...(runtime.accountKey ? { accountKey: runtime.accountKey } : {}),
              ...link,
              title: item.title.trim().slice(0, 256) || "Codex cloud task",
              status: statusFromProvider(item.status),
              createdAt: previous?.createdAt ?? now,
              updatedAt: now,
              ...(typeof item.summary === "string" ? { summary: item.summary.slice(0, 8192) } : {}),
            });
          }
          const ids = new Set(tasks.map((task) => task.id));
          yield* save({
            ...current,
            tasks: [...current.tasks.filter((task) => !ids.has(task.id)), ...tasks],
          });
          return { tasks, ...(parsed.cursor ? { cursor: parsed.cursor } : {}) };
        }),
      );
    }),

    submit: Effect.fn("CloudTaskService.submit")((input) =>
      mutation.withPermit(
        Effect.gen(function* () {
          const encoded = yield* encodeSubmit(input).pipe(
            Effect.mapError(() => new CloudOperationError({ reason: "invalid-input" })),
          );
          const fingerprint = yield* digest(`submit:${encoded}`);
          const previous = yield* existingRequest(input.requestId, fingerprint);
          if (previous) return previous;
          const runtime = yield* targetRuntime(input.targetId);
          yield* requireCapability(runtime, "submit");
          yield* validateDirectory(input.cwd);
          if (
            runtime.target.provider === "codex" &&
            (!input.environmentId || !/^[A-Za-z0-9_-]+$/.test(input.environmentId))
          ) {
            return yield* new CloudOperationError({ reason: "invalid-input" });
          }
          if (runtime.target.provider === "claude" && (input.environmentId || input.branch))
            return yield* new CloudOperationError({ reason: "unsupported" });
          const now = yield* nowIso;
          const pending: CloudTask = {
            id: yield* newId,
            targetId: input.targetId,
            ...(runtime.accountKey ? { accountKey: runtime.accountKey } : {}),
            title: input.prompt.trim().slice(0, 120),
            status: "submission-unknown",
            createdAt: now,
            updatedAt: now,
            summary:
              "Submission outcome is not yet confirmed. Check the provider before sending again.",
          };
          // Persist the receipt before launching: disconnects and repeated RPC requests must not create paid duplicates.
          yield* beginRequest(input.requestId, fingerprint, pending);
          const args =
            runtime.target.provider === "codex"
              ? [
                  "cloud",
                  "exec",
                  "--env",
                  input.environmentId!,
                  ...(input.branch ? ["--branch", input.branch] : []),
                  "--",
                  input.prompt,
                ]
              : ["--cloud", "--", input.prompt];
          let captured = "";
          const decoder = new TextDecoder();
          const output = yield* run(runtime, args, {
            cwd: input.cwd,
            onStdoutChunk: (chunk) => {
              if (captured.length < 65_536)
                captured += decoder
                  .decode(chunk, { stream: true })
                  .slice(0, 65_536 - captured.length);
            },
          }).pipe(Effect.option);
          const link = linkFromOutput(
            runtime.target.provider,
            Option.isSome(output) ? `${output.value.stdout}\n${output.value.stderr}` : captured,
          );
          if (!link) return pending;
          return yield* putTask({
            ...pending,
            ...link,
            status: "submitted",
            updatedAt: yield* nowIso,
            summary:
              Option.isSome(output) && output.value.code === 0
                ? "Cloud task submitted. Open the provider to view the complete conversation."
                : "The provider returned a task link and an error. Check the task before retrying.",
          });
        }),
      ),
    ),

    link: Effect.fn("CloudTaskService.link")((input) =>
      mutation.withPermit(
        Effect.gen(function* () {
          const runtime = yield* targetRuntime(input.targetId);
          const link = parseProviderLink(runtime.target.provider, input.url);
          if (!link) return yield* new CloudOperationError({ reason: "invalid-input" });
          const previous = (yield* Ref.get(yield* state)).tasks.find(
            (task) =>
              task.targetId === input.targetId &&
              task.url === link.url &&
              (!task.accountKey || task.accountKey === runtime.accountKey),
          );
          if (previous) return previous;
          const now = yield* nowIso;
          return yield* putTask({
            id: yield* newId,
            targetId: input.targetId,
            ...(runtime.accountKey ? { accountKey: runtime.accountKey } : {}),
            ...link,
            title:
              input.title ??
              `${runtime.target.provider === "codex" ? "Codex" : "Claude"} cloud task`,
            status: "linked",
            createdAt: now,
            updatedAt: now,
          });
        }),
      ),
    ),

    followUp: Effect.fn("CloudTaskService.followUp")((input) =>
      mutation.withPermit(
        Effect.gen(function* () {
          const encoded = yield* encodeFollowUp(input).pipe(
            Effect.mapError(() => new CloudOperationError({ reason: "invalid-input" })),
          );
          const fingerprint = yield* digest(`followUp:${encoded}`);
          const previous = yield* existingRequest(input.requestId, fingerprint);
          if (previous) return previous;
          const task = yield* getTask(input.taskId);
          const runtime = yield* taskRuntime(task);
          yield* requireCapability(runtime, "followUp");
          if (!task.providerTaskId)
            return yield* new CloudOperationError({ reason: "unsupported" });
          const pending: CloudTask = {
            ...task,
            status: "submission-unknown",
            updatedAt: yield* nowIso,
            summary:
              "Follow-up delivery is not confirmed. Check the provider before sending again.",
          };
          yield* beginRequest(input.requestId, fingerprint, pending);
          const output = yield* run(
            runtime,
            ["-p", "--cloud", task.providerTaskId, "--output-format", "json"],
            { stdin: input.prompt },
          ).pipe(Effect.option);
          if (Option.isNone(output)) return pending;
          const receipt = decodeClaudeReceipt(output.value.stdout);
          if (
            Option.isNone(receipt) ||
            !receipt.value.ok ||
            output.value.code !== 0 ||
            receipt.value.session_id !== task.providerTaskId
          )
            return pending;
          return yield* putTask({
            ...task,
            status: "submitted",
            updatedAt: yield* nowIso,
            summary: "Follow-up queued by Claude. This confirms delivery, not completion.",
          });
        }),
      ),
    ),

    status: Effect.fn("CloudTaskService.status")((input) =>
      mutation.withPermit(
        Effect.gen(function* () {
          const task = yield* getTask(input.taskId);
          const runtime = yield* taskRuntime(task);
          yield* requireCapability(runtime, "status");
          if (!task.providerTaskId)
            return yield* new CloudOperationError({ reason: "unsupported" });
          const result = yield* run(runtime, ["cloud", "status", task.providerTaskId]);
          if (result.code !== 0)
            return yield* new CloudOperationError({ reason: "command-failed" });
          const status = /^\s*status:\s*([a-z_-]+)/im.exec(result.stdout)?.[1];
          return yield* putTask({
            ...task,
            status: status ? statusFromProvider(status) : "unknown",
            updatedAt: yield* nowIso,
            summary: status
              ? task.summary
              : "The CLI status format was not recognized. Open the provider for current progress.",
          });
        }),
      ),
    ),

    diff,

    apply: Effect.fn("CloudTaskService.apply")((input) =>
      mutation.withPermit(
        Effect.gen(function* () {
          const task = yield* getTask(input.taskId);
          const runtime = yield* taskRuntime(task);
          yield* requireCapability(runtime, "apply");
          yield* validateDirectory(input.cwd);
          const reviewed = yield* diff(input);
          if (!reviewed.text || reviewed.digest !== input.reviewedDigest)
            return yield* new CloudOperationError({ reason: "diff-changed" });
          const clean = yield* processRunner
            .run({
              command: "git",
              args: ["status", "--porcelain"],
              cwd: input.cwd,
              stdin: "",
              timeout: "10 seconds",
              maxOutputBytes: 1_048_576,
            })
            .pipe(Effect.mapError(() => new CloudOperationError({ reason: "command-failed" })));
          if (clean.code !== 0) return yield* new CloudOperationError({ reason: "invalid-input" });
          if (clean.stdout.trim())
            return yield* new CloudOperationError({ reason: "workspace-dirty" });
          const result = yield* run(
            runtime,
            ["cloud", "apply", task.providerTaskId!, "--attempt", String(input.attempt)],
            { cwd: input.cwd },
          );
          if (result.code !== 0)
            return yield* new CloudOperationError({ reason: "command-failed" });
          return { applied: true as const };
        }),
      ),
    ),

    unlink: Effect.fn("CloudTaskService.unlink")((input) =>
      mutation.withPermit(
        Effect.gen(function* () {
          yield* getTask(input.taskId);
          const current = yield* Ref.get(yield* state);
          // Keep request receipts so retrying a removed submission cannot launch another paid task.
          yield* save({
            ...current,
            tasks: current.tasks.filter((task) => task.id !== input.taskId),
          });
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(CloudTaskService, make);
