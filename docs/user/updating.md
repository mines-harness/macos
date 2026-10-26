# Updating mines

Update the app and the computer running your agents separately when they are on
different devices. A protocol mismatch prevents the client from connecting until
the versions are compatible.

## Choose a mines release source

This fork has no default public release feed. Automatic updates stay unavailable
until your build or administrator configures a mines release source. It never
substitutes the upstream T3 Code application or npm package.

For an installed command-line host, configure `MINES_CLI_UPDATE_REPOSITORY` or
`MINES_CLI_RELEASE_BASE_URL` with your own published mines releases. Then use the
host's **Update server** action or run:

```sh
mines update <version>
```

Keep the client open while a remote update installs and reconnects. A service
update asks before restarting; if you defer, run `mines service restart` when
ready. A manually started server must be stopped and restarted with its usual
options. For a source checkout, update and rebuild that checkout instead.

Desktop updates require the build's own configured distribution feed. Until one
is available, install a new mines build from the same trusted distributor. Do not
run `npx t3` or install the upstream package to update mines.

## Before restarting

Updates can interrupt agents and terminal commands. Saved mines, settings, and
project files remain. Back up the host's `userdata` directory before a major
upgrade; it is normally `~/.mines/userdata`.

**Settings → General → Continue mines after restarts** controls recovery of
supported active mines. The host must start again; this setting does not enable
startup by itself. Mines waiting for approval, answers, or secrets remain paused.
Sessions without provider resume state need a new message. Terminal commands may
need to be started again.

If an update fails, read the reported error on the affected computer and retry
once the cause is resolved. A failed service update can roll back to its previous
version. Only one server can use a mines home directory at a time.

## Update providers

**Settings → Providers** shows updates for each connected environment. Update a
provider there, or follow its manual instructions when automatic installation is
unavailable. These checks concern the provider's CLI, not the mines release feed.
Existing sessions can keep using the old CLI until they end. After an update,
refresh provider status if its models or capabilities have not refreshed.

## Mobile updates

Use the mines build supplied by your distributor. Store delivery and over-the-air
updates require that distributor's own app registrations, signing credentials,
and update configuration; this repository does not provide a live public mobile
release service.

From the phone, **Settings → Environments** offers maintenance only for connected
hosts that advertise it. A host without a configured mines update source must be
updated on that computer. Updating the phone does not update those hosts.
