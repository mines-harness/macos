# Run a mines host on a Linux VPS

The headless host runs mines and provider sessions on the VPS without Electron. The Mac and VPS keep separate projects, provider credentials, and mines homes. Device registration/signaling is a separate service; see [Mines device service](../../infra/mines-control/README.md).

## Build the archive

Use the repository's pinned Node version and Rust 1.95 or newer for the resource helper. Build from the checkout that contains the desired server and web changes:

```sh
vp run --filter t3 build
node apps/server/scripts/cli.ts build-exe --target linux-x64
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target x86_64-unknown-linux-gnu
mkdir -p /tmp/mines-cli-monitor
cp native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor /tmp/mines-cli-monitor/
node scripts/build-cli-archive.ts --platform linux --arch x64 --version 0.1.2 --resource-monitor-dir /tmp/mines-cli-monitor --output-dir release-cli
```

Cross-building the Rust helper requires a Linux linker; a native Linux build is simpler. Use `arm64` and `aarch64-unknown-linux-gnu` for an ARM VPS. The archive contains its own Node runtime, native dependencies, web client, `mines` command, and service installer. Keep the extracted directory together. Git and the provider CLIs used by your mines must be installed separately.

For a development host without the Rust helper, pass `--without-resource-monitor` instead of `--resource-monitor-dir` and skip the Cargo build. Native process telemetry is unavailable in that archive; the host still runs and terminal process checks use their existing system fallback. Standard archives require the helper by default.

On a Linux machine matching the archive, verify it before installing:

```sh
node scripts/smoke-cli-archive.ts --archive release-cli/mines-0.1.2-linux-x64.tar.gz --expect-version 0.1.2
sha256sum release-cli/mines-0.1.2-linux-x64.tar.gz
```

The smoke check uses a temporary home, no browser, and a temporary loopback port. A cross-build alone does not establish that the VPS can start the archive or connect to another device.

## Install under your project account

Copy the archive to the VPS and extract it into a versioned directory, for example `~/.local/opt/mines/mines-0.1.2-linux-x64`. Run these commands as the account that owns the projects and provider logins:

```sh
cd "$HOME/.local/opt/mines/mines-0.1.2-linux-x64"
./mines --help
./install-service.sh --runtime-dir "$PWD" --print
./install-service.sh --runtime-dir "$PWD" --start
systemctl --user status mines-host.service
journalctl --user -u mines-host.service -f
```

The installer uses `~/.local/share/mines-host` for state, `~/mines-projects` for its working directory, and `127.0.0.1:3773` for HTTP. Override them with `--home-dir`, `--workdir`, and `--port`. It captures the installing shell's `PATH` so provider commands installed under your account remain available. Reinstall the unit after moving a versioned Node/provider executable.

To retain the user service after logout and reboot, enable lingering for that account if the VPS administrator has not already done so:

```sh
sudo loginctl enable-linger "$USER"
```

Optional environment configuration can be loaded with `--environment-file /absolute/path/host.env`. Restrict that file to the project owner. The device/control connection and approvals still need to be configured using the mines app; setting an environment file does not pair devices. Keep the host HTTP listener on loopback. Direct device connections use the configured WebRTC path and need working UDP connectivity; this installer does not provision the control service or alter firewall rules.

Authenticate each provider separately on the VPS using its supported login flow. The Mac's provider login and local `.env` files are not included in a mine transfer. Prepare the destination repository and dependencies before transferring work for shorter interruptions.

## Update, stop, and remove

This unit executes the local archive directly. It does not download releases or automatically replace the runtime. `mines service install` uses the separate pinned-release mechanism and requires your own configured release source; use the included installer for a locally built archive.

To update, extract a new archive alongside the old one, stop the host after its work is paused, and rerun the new directory's installer with `--start`. Retain the previous directory for rollback. The configured mines home stays in place.

```sh
systemctl --user stop mines-host.service
systemctl --user disable mines-host.service
rm "$HOME/.config/systemd/user/mines-host.service"
systemctl --user daemon-reload
```

These commands remove the service while keeping project files and mines history. Back up the mines home and projects before removing runtime versions or state.
