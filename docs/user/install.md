# Install mines

mines runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the computer where agents will work first.

## Requirements

You need an installed, authenticated provider before starting a mine. You can
launch mines and configure providers afterwards. The current repository is a
development implementation; it does not include a published, signed desktop or
mobile release. Use a trusted build supplied by your mines distributor, or follow
the [source development instructions](../../README.md#develop-locally).

mines keeps its state separate from upstream T3 Code, normally in `~/.mines`, with
runtime data under `userdata`. `MINES_HOME` selects another base directory. A
fresh installation does not automatically copy another app’s sessions, settings,
or browser cookies. Use the welcome flow to import supported conversation history.

## Command line

The mines desktop build can install its bundled `mines` launcher. A separately
distributed mines CLI can run without the desktop app. The upstream `t3` npm
package, installers, and package-manager entries install upstream T3 Code; they
do not install this fork.

| Task                                                | Command                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| Start the server and open its web app               | `mines`                                                                    |
| Start without opening a browser                     | `mines serve`                                                              |
| Keep it running in the background on macOS or Linux | `mines service install` ([details](./background-service.md))               |
| Check for an own-source update                      | `mines update`                                                             |
| Reclaim database space                              | `mines doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove the CLI and service                          | `mines uninstall`                                                          |

Run `mines --help` for the reference. Use `mines ./my-project` for a working
directory. If a server already owns the data directory, connect to it or choose a
separate `--base-dir` for another server.

Updates and automatic SSH installation require your distributor’s own mines
release repository or release URL. They remain disabled when none is configured.
A source-only server is updated by rebuilding that checkout.

### Intel Macs

Use a build that explicitly supports your architecture. This checkout does not
promise a published Intel Mac binary; source-build requirements and packaging
remain subject to the distributor’s validation.

## Desktop app

Use a mines build from your distributor. There is no default public download or
update feed. Upstream T3 Code releases and store listings are separate products.

<a id="the-t3-command"></a>

### The `mines` command

Open **Settings → General → About** and install the bundled command. On macOS and
Linux this creates a `mines` launcher on your `PATH`; on Windows it installs the
command wrapper. Open a new terminal afterwards. Remove it from the same setting.
The launcher belongs to this mines installation and uses its isolated data home.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects there.
Install provider CLIs inside that distro. The desktop build supplies its own
server runtime; the first launch after an app update can take longer.

### Open a project from a terminal

With the mines desktop app running on the same computer:

```bash
mines app
```

This opens a new mine for the current directory. Pass a path, such as
`mines app ../my-project`, to open another directory. This command needs the
running desktop app; a standalone server or an SSH session is not enough.

## Mobile app

The phone companion lives in `apps/mobile` in this repository. It needs a native
iOS or Android build from your own mines project; the WebRTC module is not
available in Expo Go. No App Store, Google Play, TestFlight, or public APK release
is configured by default.

The phone controls work on another computer. Follow [remote access](./remote-access.md)
for approved direct peer connections or a separately paired LAN/private-network
route. Account-based discovery requires your own mines Clerk and device-service
configuration. The computer must remain awake for live work.

For startup problems, open **Settings → Diagnostics** after a successful launch.
Review diagnostic text before sharing it, because errors can contain local values.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from mines’ provider settings.                                                                                            |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |

Provider CLIs must be on the server's `PATH`. If mines cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

mines warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when mines cannot tell. Update a CLI installed with
mise through mise. Cursor and Antigravity update with mines. Homebrew installs
compare against the version Homebrew offers, which can trail the npm release by
a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, mines does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Pi](./providers-pi.md), and
[Muse Code](./providers-muse.md).

## Next steps

- [Working with mines](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating mines](./updating.md): update the app and connected servers.
