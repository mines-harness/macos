import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as AccountControl from "../account/AccountControl.ts";
import * as CliAccountService from "../account/CliAccountService.ts";
import * as LocalAccountHost from "../account/LocalAccountHost.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { makeControlUrlConfig } from "../cloud/publicConfig.ts";
import * as ServerConfig from "../config.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

export const formatAccountJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const accountJsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit account status as JSON without credentials."),
  Flag.withDefault(false),
);

class AccountCommandError extends CliError.UserError {
  override get message() {
    return String(this.cause);
  }
}

export const runWithAccount = Effect.fn("account.runWithAccount")(function* <A>(
  flags: CliAuthLocationFlags,
  run: (
    account: CliAccountService.CliAccountService["Service"],
  ) => Effect.Effect<A, CliAccountService.CliAccountError>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const origin = yield* makeControlUrlConfig("https://mines.gemstud.io");
  const host = LocalAccountHost.layer.pipe(
    Layer.provide(LocalAccountHost.layerConnection),
    Layer.provide(EnvironmentAuth.layerRuntime),
  );
  const account = CliAccountService.layer.pipe(
    Layer.provide(Layer.mergeAll(AccountControl.layer(origin), ServerSecretStore.layer, host)),
    Layer.provide(ServerConfig.layer(config)),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
  );
  return yield* CliAccountService.CliAccountService.pipe(
    Effect.flatMap(run),
    Effect.provide(account),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", credentials: "omit" }),
    Effect.mapError((cause) => new AccountCommandError({ cause: cause.message })),
  );
});

const login = Command.make("login", {
  ...authLocationFlags,
  noBrowser: Flag.Boolean("no-browser").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Sign in to your Mines account and enable this host's device sync."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      const headless = yield* Config.all({
        ssh: Config.String("SSH_CONNECTION").pipe(Config.option),
        tty: Config.String("SSH_TTY").pipe(Config.option),
      });
      return yield* runWithAccount(flags, (account) =>
        Effect.gen(function* () {
          const result = yield* account.login((code) =>
            Effect.gen(function* () {
              yield* Console.log(
                `Open ${code.verificationUriComplete}\nConfirm code: ${code.userCode}\nWaiting for approval. Press Ctrl+C to cancel.`,
              );
              if (!flags.noBrowser && Option.isNone(headless.ssh) && Option.isNone(headless.tty)) {
                yield* launcher.launchBrowser(code.verificationUriComplete).pipe(Effect.ignore);
              }
            }),
          );
          yield* Console.log(
            `Signed in as ${result.user.email}. Device signaling ${result.host.online ? "online" : "configured"}.`,
          );
        }),
      );
    }).pipe(Effect.provide(ExternalLauncher.layer)),
  ),
);
const status = Command.make("status", { ...authLocationFlags, json: accountJsonFlag }).pipe(
  Command.withDescription("Show your account and this host's device sync status."),
  Command.withHandler((flags) =>
    runWithAccount(flags, (account) =>
      Effect.gen(function* () {
        const result = yield* account.status;
        if (flags.json) {
          yield* Console.log(formatAccountJson(result));
          return;
        }
        if (result.status === "signed-out") {
          yield* Console.log("Signed out. Run `mines account login`.");
          return;
        }
        if (result.status === "expired") {
          yield* Console.log("Account session expired or revoked. Run `mines account login`.");
          return;
        }
        yield* Console.log(
          `${result.user.email}: ${result.status === "offline" ? "account service unavailable; saved sign-in kept" : "signed in"}.\nDevice signaling: ${result.host ? (result.host.online ? "online" : "configured, signaling offline") : "local host unavailable or not linked"}.`,
        );
      }),
    ),
  ),
);
const logout = Command.make("logout", { ...authLocationFlags, json: accountJsonFlag }).pipe(
  Command.withDescription("Clear this CLI's account and stop this host's account sharing."),
  Command.withHandler((flags) =>
    runWithAccount(flags, (account) =>
      Effect.gen(function* () {
        const result = yield* account.logout;
        if (flags.json) {
          yield* Console.log(formatAccountJson({ status: "signed-out", ...result }));
          return;
        }
        yield* Console.log(
          `CLI account cleared.${result.hostUnchanged ? " Unrelated host settings kept." : result.hostDisconnected ? " Host sharing stopped." : " Host unavailable: sharing teardown could not be confirmed."}${result.sessionRevoked ? "" : " Remote session revocation could not be confirmed."}`,
        );
      }),
    ),
  ),
);
export const accountCommand = Command.make("account").pipe(
  Command.withDescription("Manage your Mines account on this host."),
  Command.withSubcommands([login, status, logout]),
);
