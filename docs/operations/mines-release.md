# Mines releases

`mines-harness/macos` is the canonical source and release repository for desktop and CLI on every platform. Its name does not select a macOS-only codebase. Platform differences belong behind operating-system boundaries in that source. The `windows`, `android`, `ios`, and `cli-source-private` repositories retain earlier work; they are not independent release trains. The public `cli` repository retains historical downloads.

## From source to an update

The selected release profile starts after canonical `main` passes the complete `CI / Check` gate. With the repository Actions variable `MINES_RELEASE_MODE=personal`, [Mines personal release build](../../.github/workflows/mines-personal-release.yml) prepares the shared bundle and Linux/Windows artifacts for local Mac signing. Otherwise, [Mines release](../../.github/workflows/mines-release.yml) performs distribution signing and publication in CI. Both allocate the next unused stable patch, using [.github/mines-release.json](../../.github/mines-release.json) as the minimum version. Stable tags and dispatches must identify a commit whose CI passed. A failed or incomplete build publishes nothing.

The workflow builds the web client, server, and Electron shell once, then packages that bundle for macOS, Linux, and Windows on both architectures. Windows packages embed the Linux CLI from the same run for their WSL backend. Each standalone CLI is smoke-tested on its target platform. macOS x64 supports the Electron app, but Node does not support its standalone SEA executable; no x64 macOS CLI is advertised.

Every target records the full source commit, Git tree, lockfile hash, version, workflow run, and download hashes. Publication requires all six desktop targets and five supported CLI archives, so an app cannot ship while its pinned SSH bootstrap downloads still return 404. macOS requires both its DMG and updater ZIP, plus blockmaps and channel feeds. Every feed must reference the recorded artifact sizes and SHA-512 hashes. All targets must agree on source and version.

The complete set is uploaded to a draft release before publication. Stable downloads and the in-app updater use [the canonical releases](https://github.com/mines-harness/macos/releases); official builds require no feed override. Previews carry no update feed. `release-source.json`, `provenance-<target>.json`, `release-report.json`, and `SHA256SUMS` accompany the downloads. The web client inside desktop and CLI archives also contains `release-source.json`, so the source can be identified without relying on a version label.

## Configure signing once

Official publication requires a consistent Developer ID Application identity, its team identifier, and Apple notarization credentials. Packaging reads `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` from repository secrets and `APPLE_TEAM_ID` from repository variables. A provisioning profile is needed only for the optional associated-domain/passkey capability. Windows publication requires the existing [Azure Trusted Signing configuration](release.md#3-azure-trusted-signing-setup-windows).

Missing credentials stop every official channel, including maintainer previews, before packaging. The repository-scoped `GITHUB_TOKEN` publishes the release; no cross-repository publishing token is needed. Keep the signing identity, bundle identifier, Windows installer identity, app name, and install path stable across updates. Moving from an old ad-hoc signature to the proper identity can require one final permission grant; future releases must retain that identity.

A local development build can use `--local-signed` with an Apple Development certificate already installed in Keychain. Pin its SHA-1 fingerprint in `MINES_DESKTOP_LOCAL_SIGN_IDENTITY` when more than one exists. This mode has no notarization or production update feed and cannot replace the official release gate.

An explicitly authorized Personal Team release uses `--personal-release` with a stable or nightly version. macOS also requires `--local-signed`, generating the DMG, updater ZIP, blockmaps, and canonical GitHub feed without notarization. Keep the same pinned certificate for subsequent releases; its SHA-1 can live in the gitignored root `.env` or `.env.local`, and an explicit environment value takes priority. Label these Mac downloads as development-signed and unnotarized. Gatekeeper may require users to approve the first installation. Matching Linux and Windows builds use `--personal-release` without `--local-signed`; Windows is unsigned unless its separate Azure signing configuration is available. Ordinary unsigned Windows, local Mac builds, and previews still have no production feed. The official CI workflow continues to require Developer ID and notarization credentials.

The personal workflow uploads `release-source` and `js-bundle` before the other targets finish. On the maintainer Mac, check out that exact commit, restore the shared bundle under `apps`, and package both Mac architectures with `--skip-build`, plus the matching darwin-arm64 CLI. Record both Mac target manifests against that run's `release-source.json`. Create a draft `v<version>` targeting the full source commit and upload the Mac installers, updater ZIPs, blockmaps, per-architecture feeds, CLI archive, both provenance manifests, and `SIGNING.json`; [the publication workflow](../../.github/workflows/mines-personal-publish.yml) checks the exact handoff set. The signing key remains in the Mac's Keychain.

Dispatch publication with the shared-bundle run ID. A successful base run supplies its non-Mac artifacts directly. If packaging failed after the source and shared bundle succeeded, the publisher rebuilds the four non-Mac targets from that same tested source and bundle. It rejects intervening application changes on `main`, verifies all six desktop targets and five CLI archives, merges the updater feeds, and checks uploaded hashes before publishing the stable release. `build-runs.json` distinguishes the original bundle run from a packaging recovery run.

```sh
gh workflow run mines-personal-publish.yml --repo mines-harness/macos --ref main -f build_run_id="<shared-bundle-run-id>"
```

```sh
MINES_DESKTOP_LOCAL_SIGN_IDENTITY="<certificate SHA-1>" vp run dist:desktop:artifact --platform mac --target dmg --arch arm64 --build-version 0.1.19 --local-signed --personal-release
```

## Update the installed Mac app

```sh
node scripts/install-desktop.ts --audit
node scripts/install-desktop.ts /path/to/mines.app
```

The second command is a preflight. After the app has stopped, add `--apply` to install at `/Applications/mines (Beta).app`. Personal Team signatures require `--allow-development`. Rollbacks are compressed under `~/Library/Caches/mines/desktop-rollbacks`, outside Launch Services' app discovery. A changed app identity requires an intentional one-time `--allow-identity-change`. Never reset the profile, database, paired devices, or Keychain to make an update pass.

An installed-release claim requires the installed version and commit, matching release provenance, signature verification, runtime health, and preservation of conversations and account/device identity. A passing source build alone does not identify the app the user launched.

## Resolve platform drift before implementing “latest”

[Mines source parity](../../.github/workflows/mines-source-parity.yml) runs on canonical pushes and daily. Its `source-parity.json` records exact source commits and every changed, missing, or platform-only shared file. Native mobile repositories are compared over their mobile/shared dependency projection. README differences are excluded. An unreadable private repository is explicitly unavailable, never assumed aligned.

```sh
node scripts/mines-source-parity.ts --output /tmp/mines-source-parity.json
```

Use `--strict` when a task requires all compared snapshots to match. Before implementing the latest changes, fetch canonical `main`, preserve dirty checkout work, inspect platform-only changes in the report, and integrate them into the canonical source. Do not force-push one platform over another. Compare the installed commit with the canonical release provenance before rebuilding. Explicit legacy `MINES_CLI_UPDATE_REPOSITORY=mines-harness/cli` settings remain supported for older releases; new builds default to the canonical release repository.

The broader [upstream release guide](release.md) describes retained T3 infrastructure. Its upstream-only release and relay workflows do not publish Mines releases.
