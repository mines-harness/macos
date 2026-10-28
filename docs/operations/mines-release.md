# Mines releases

`mines-harness/macos` is the canonical source and release repository for desktop and CLI on every platform. Its name does not select a macOS-only codebase. Platform differences belong behind operating-system boundaries in that source. The `windows`, `android`, `ios`, and `cli-source-private` repositories retain earlier work; they are not independent release trains. The public `cli` repository retains historical downloads.

## From source to an update

[Mines release](../../.github/workflows/mines-release.yml) starts after canonical `main` passes the complete `CI / Check` gate. It allocates the next unused stable patch, using [.github/mines-release.json](../../.github/mines-release.json) as the minimum version. Manual dispatch defaults to a maintainer preview. Stable tags and stable/nightly dispatches must also identify a commit whose CI passed; dispatch `CI` first when testing a branch that has no check on its exact commit. A failed or incomplete build publishes nothing.

The workflow builds the web client, server, and Electron shell once, then packages that bundle for macOS, Linux, and Windows on both architectures. Windows packages embed the Linux CLI from the same run for their WSL backend. Each standalone CLI is smoke-tested on its target platform. macOS x64 supports the Electron app, but Node does not support its standalone SEA executable; no x64 macOS CLI is advertised.

Every target records the full source commit, Git tree, lockfile hash, version, workflow run, and download hashes. Publication requires all six desktop targets and five supported CLI archives, so an app cannot ship while its pinned SSH bootstrap downloads still return 404. macOS requires both its DMG and updater ZIP, plus blockmaps and channel feeds. Every feed must reference the recorded artifact sizes and SHA-512 hashes. All targets must agree on source and version.

The complete set is uploaded to a draft release before publication. Stable downloads and the in-app updater use [the canonical releases](https://github.com/mines-harness/macos/releases); official builds require no feed override. Previews carry no update feed. `release-source.json`, `provenance-<target>.json`, `release-report.json`, and `SHA256SUMS` accompany the downloads. The web client inside desktop and CLI archives also contains `release-source.json`, so the source can be identified without relying on a version label.

## Configure signing once

Official publication requires a consistent Developer ID Application identity, its team identifier, and Apple notarization credentials. Packaging reads `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` from repository secrets and `APPLE_TEAM_ID` from repository variables. A provisioning profile is needed only for the optional associated-domain/passkey capability. Windows publication requires the existing [Azure Trusted Signing configuration](release.md#3-azure-trusted-signing-setup-windows).

Missing credentials stop every official channel, including maintainer previews, before packaging. The repository-scoped `GITHUB_TOKEN` publishes the release; no cross-repository publishing token is needed. Keep the signing identity, bundle identifier, Windows installer identity, app name, and install path stable across updates. Moving from an old ad-hoc signature to the proper identity can require one final permission grant; future releases must retain that identity.

A local development build can use `--local-signed` with an Apple Development certificate already installed in Keychain. Pin its SHA-1 fingerprint in `MINES_DESKTOP_LOCAL_SIGN_IDENTITY` when more than one exists. This mode has no notarization or production update feed and cannot replace the official release gate.

## Update the installed Mac app

```sh
node scripts/install-desktop.ts --audit
node scripts/install-desktop.ts /path/to/mines.app
```

The second command is a preflight. After the app has stopped, add `--apply` to install at `/Applications/mines (Beta).app`. Rollbacks are compressed under `~/Library/Caches/mines/desktop-rollbacks`, outside Launch Services' app discovery. A changed app identity requires an intentional one-time `--allow-identity-change`. Never reset the profile, database, paired devices, or Keychain to make an update pass.

An installed-release claim requires the installed version and commit, matching release provenance, signature verification, runtime health, and preservation of conversations and account/device identity. A passing source build alone does not identify the app the user launched.

## Resolve platform drift before implementing “latest”

[Mines source parity](../../.github/workflows/mines-source-parity.yml) runs on canonical pushes and daily. Its `source-parity.json` records exact source commits and every changed, missing, or platform-only shared file. Native mobile repositories are compared over their mobile/shared dependency projection. README differences are excluded. An unreadable private repository is explicitly unavailable, never assumed aligned.

```sh
node scripts/mines-source-parity.ts --output /tmp/mines-source-parity.json
```

Use `--strict` when a task requires all compared snapshots to match. Before implementing the latest changes, fetch canonical `main`, preserve dirty checkout work, inspect platform-only changes in the report, and integrate them into the canonical source. Do not force-push one platform over another. Compare the installed commit with the canonical release provenance before rebuilding. Explicit legacy `MINES_CLI_UPDATE_REPOSITORY=mines-harness/cli` settings remain supported for older releases; new builds default to the canonical release repository.

The broader [upstream release guide](release.md) describes retained T3 infrastructure. Its upstream-only release and relay workflows do not publish Mines releases.
