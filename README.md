# mines

An AI workspace for continuing useful work across your computers and phones. Mines builds on [t3code at `375da0f`](https://github.com/pingdotgg/t3code/tree/375da0fb9a20dfdbd2eb2db99050341fc30f3a23), retaining its Electron desktop, React Native companions, native provider adapters, and durable orchestration.

The interface uses a true-black canvas, restrained motion, and original mine/flag icons. Minesweeper tiles are not part of the interface.

## Develop locally

Use the versions pinned in `package.json` (Node 26.12.1 and pnpm 12.14.0).

```sh
pnpm install
pnpm dev --home-dir /absolute/path/to/mines-dev
```

The dev runner prints a local pairing URL. `pnpm dev:desktop` starts the Electron application. Mobile development lives in `apps/mobile`; the WebRTC module requires a native development build, not Expo Go. App identifiers, data directories, account configuration, icons, and distribution feeds are isolated from upstream.

Configure a dedicated Clerk application and your own device service using `.env.example`. Local work remains useful before phone setup. No upstream Clerk application, relay, telemetry destination, or release feed is enabled by default. Updates stay disabled until an explicit mines release source is configured.

## Workspace

- Library hierarchy: optional sections, projects, conversations and groups, with independent ordered pins and an encrypted Yjs catalog.
- Drag mines, projects and sections to arrange the Library or add a shortcut to Pinned. Projects and sections have custom instructions and device-specific context files/folders; section instructions apply before project instructions. Organizing a mine never moves its files or changes its execution computer.
- Adjacent model and device selectors, multi-model workflows, existing-mine groups, explicit mentions and bounded delegation.
- Isolated provider profiles and fresh-evidence quota recovery. Automatic switching is gated by the adapter's supported account policy; current unverified subscription integrations remain manual.
- Resumable, read-only history imports with provenance and explicit coverage reports.
- Codex Cloud and Claude Cloud as subscription-backed devices, with verified native CLI controls and provider links for unavailable operations.
- Direct WebRTC phone/computer connections, authenticated device approval, encrypted caches, recent-first history, gzip, range loading, and resumable live subscriptions.

The OVH service handles identity, presence and signaling. It does not relay or queue conversations. Restrictive networks can prevent direct access: switch networks or use cached content. See the [device-service deployment guide](infra/mines-control/README.md), [remote access](docs/user/remote-access.md), and [implementation and release gates](docs/mines/STATUS.md).

## Validation and release

```sh
pnpm check:changed 375da0fb9a20dfdbd2eb2db99050341fc30f3a23
pnpm icons:check
```

Physical iOS/Android networking, live subscription integrations, signing/notarization, update delivery, accessibility and performance acceptance remain release gates. Local tests and fixtures do not certify those gates. This checkout is a development implementation, not a published or signed beta.

## License and attribution

The upstream MIT license and copyright notices are retained in [LICENSE](LICENSE), alongside third-party notices. Internal workspace package names and compatibility command paths still use `@t3tools`/`t3`; these are not claims of affiliation. Original mines icon assets live in `assets/mines`.
