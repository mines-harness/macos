# Running mines in the background

On Linux and macOS, mines can run as a service for your user so you do not need
to keep a terminal open.

## Manage the service

Install the `mines` CLI first ([Install mines](./install.md#command-line)), then
run these commands on the machine that will host mines. Use the mines CLI supplied
by your own build or distributor, not the upstream npm package:

| Task                            | Command                   |
| ------------------------------- | ------------------------- |
| Install and start               | `mines service install`   |
| Inspect status and log location | `mines service status`    |
| Move to a newer release         | `mines update`            |
| Restart                         | `mines service restart`   |
| Stop and remove from startup    | `mines service uninstall` |

Uninstalling the service leaves your projects, mines, and settings intact.
Running `mines service install` again repairs a service that `mines service status`
reports as broken.

`mines update` requires your distributor’s own release source. Without
`MINES_CLI_UPDATE_REPOSITORY` or `MINES_CLI_RELEASE_BASE_URL`, updates stay disabled;
there is no upstream release or npm fallback. A configured update can interrupt
running turns, terminals, and remote clients when the service restarts. A server
you started by hand must be restarted separately. See [Updating mines](./updating.md).

`mines uninstall` removes the background service, the `mines` launcher, and the
downloaded versions after showing you the list and asking once. Your projects,
mines, and settings under `~/.mines/userdata` are kept, along with `service.env`
under mines home. Pass `--yes` from a script.

## Local network access

The service can accept paired clients over reachable private-network addresses.
It does not supply a public hosted app or managed tunnel. To keep it reachable only
from the host, set `MINES_HOST=127.0.0.1` in `service.env`; an explicit
`MINES_HOST` replaces the default listen-address selection. Every remote client
still needs an authorized connection.

Direct peer access requires its own account/device-service configuration and host
approval. Keeping the service running does not guarantee that restrictive networks
can establish a direct connection. See [remote access](./remote-access.md).

## Configure the service environment

Put custom environment variables in `service.env` under the service's mines home
directory, normally `~/.mines/service.env`. This file survives service installation
and updates. For example:

```dotenv
MINES_PORT=3773
MINES_HOST=127.0.0.1
```

Use `KEY=VALUE` entries, quoting values that contain spaces or `#`. Values are
literal: shell commands and variable expansion are not evaluated. Entries
override the inherited service environment, except for `PATH`, `MINES_HOME`,
`MINES_BOOT_SERVICE_UNIT`, and `T3_SERVICE_LAUNCHER_CONTEXT` (including case variants).

Run `mines service restart` after changing the file. Changes apply when the service
starts again; switching the server version alone keeps the current values.
For a service installed before env-file support, run `mines service install` once
with an up-to-date CLI.
A missing file is ignored; other read failures stop service startup.
If the file contains credentials, restrict access to that file with `chmod 600`
(for the default mines home, `chmod 600 ~/.mines/service.env`).

## Platform support

Linux needs systemd user services. Setup enables lingering so mines starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported.

Account sign-out and background-service management are separate. Signing out does
not stop or uninstall the service. An awake host and a reachable route are still
required for remote work.

## Troubleshooting

Start with `mines service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running mines as root creates a separate installation and device
identity. Without administrator access, run `mines serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and `systemctl --user status mines.service`, then use the repair command printed by mines.                        |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run `mines service restart`.                         |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/app.mines.desktop.service.plist`.

For account or remote-access failures, see
[connection troubleshooting](./t3-connect-troubleshooting.md).

## Reclaim database space

mines removes superseded internal history on its own while it runs; your
conversations are kept. Databases created before this shrank automatically
still hold the freed space on disk until a one-time offline repair returns it
and turns on automatic shrinking. Settings > Storage (web and desktop) or
Settings > Maintenance (mobile) suggests the repair when at least 1 GiB can be
reclaimed.

Run `mines doctor` on the machine that hosts the environment. It reports the
database size and the space it can reclaim, then asks which repairs to run;
pass `--fix` to run the recommended ones without a prompt (for scripts), or
`--dry-run` to only report. An installed background service for the same data
directory is stopped for the repair and started again afterwards, also when
the repair fails. Quit a server you started by hand, or the desktop app, first:
the repair refuses to touch a database that is in use. Use `--base-dir` for a
different data directory.

The repair can take several minutes on a large database. It rebuilds the
database through a temporary copy, so it needs free space of about the
database's size twice over: once in the system temporary directory (`TMPDIR`
or `/tmp` on Linux and macOS) and once next to the database for its
write-ahead log.

mines uses its own data directory and does not automatically copy an upstream
installation. Import older conversations through the welcome flow. Keep any
original databases until you have checked the imported history.
