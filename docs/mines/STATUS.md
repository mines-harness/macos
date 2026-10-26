# mines implementation and release gates

Baseline: `pingdotgg/t3code@375da0fb9a20dfdbd2eb2db99050341fc30f3a23`. This document distinguishes implemented code from integration and release evidence. Do not treat a fixture result as a successful live subscription operation or a physical network test.

## Implementation map

| Area                                                                              | Owning implementation                                                                                                                    |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Native identity, menu-bar status and window lifecycle                             | `apps/desktop/src`, `apps/web/src/components/desktop/MenuBarCoordinator.tsx`                                                             |
| Shared catalog, ordered placements and encrypted persistence                      | `packages/client-runtime/src/catalog`, `apps/server/src/catalog`, web/mobile `catalog` directories                                       |
| Section/project instructions, source references and immutable execution context   | `apps/server/src/catalog/CatalogRunContextService.ts`, migration 072, shared catalog revision barrier and web/mobile context editors     |
| Group coordination, invitations, native participant execution and remote receipts | `apps/server/src/groupChat`, migrations 070–071, `packages/contracts/src/groupChat.ts`                                                   |
| Quota eligibility and recovery                                                    | `apps/server/src/orchestration-v2/AccountFailoverService.ts`, `accountFailoverPolicy.ts`                                                 |
| Read-only imports and source archives                                             | `apps/server/src/project/AgentSessionScanner.ts`, `AgentSessionImporter.ts`, `ExternalAgentSessions.ts`, `AgentSessionArchive.ts`        |
| Subscription cloud bridge and capabilities                                        | `apps/server/src/cloud/CloudTaskService.ts`, `packages/contracts/src/executionTargets.ts`                                                |
| Signed direct peer sessions                                                       | `packages/shared/src/minesPeer*`, `packages/client-runtime/src/peer`, `apps/server/src/peer`                                             |
| Registration, revocation, presence and signaling                                  | `infra/mines-control`                                                                                                                    |
| Bounded history/ranges and encrypted cache                                        | `apps/server/src/orchestration-v2/threadHistoryPaging.ts`, `threadBodyRanges.ts`, `packages/client-runtime/src/platform/historyCache.ts` |
| Phone companion                                                                   | `apps/mobile/src/connection/peer*`, mobile catalog, groups/cloud workspaces and existing remote task controls                            |

## Behavioral limits

- A mine remains on its existing execution target. Changing a target starts a separate draft or workflow. Provider credentials remain on the executing computer.
- Native group members are actual mines. Only the shared group stream is distributed automatically. A member can still refer to its own retained memory. Explicit `group.ask` calls are authenticated and bounded; incidental text never invokes another member.
- Remote coordination requires approved, reciprocally paired host routes. An offline coordinator pauses dispatch; its durable database survives window closure and process restart. Fully quitting or suspending the host stops execution until it resumes.
- Code alternatives use separate worktrees. Checkout leases serialize managed writers and no workflow merges implementations automatically.
- Unknown usage is not zero. Switching requires fresh confirmed exhaustion for the requested model, eligible isolated profiles, supported continuation, and an adapter policy allowing automation. Current unverified subscription policies expose manual recovery. No paid API is substituted.
- Cloud execution and the local CLI bridge have separate status. Cloud tasks stay attached to their original account. Claude's supported receipt/follow-up flow does not imply full transcript, cancellation or collaborative capabilities. Unsupported controls open the provider app.
- Codex native history, Claude JSONL, known OpenCode formats and verified exports are read-only import sources. Unrecognized OpenCode databases are not upgraded. Antigravity supported exports are handled; universal native-store replay is not established. Coverage reports identify partial or unsupported content.
- The catalog is separate from host-owned conversation histories. Catalog replication uses approved direct peers. Disconnected replicas may differ until synchronization. Host catalog keys use the restricted local secret store; desktop/mobile cache keys additionally use platform secure storage.
- Section instructions precede project instructions. File/folder references stay on their owning computer. Dispatch waits for the destination's catalog revision; retries and later passes for the same group member retain the first execution snapshot for that round. Editing context applies to the next user round.
- WebRTC has no TURN, relay, SSH or tunnel fallback. Direct connection failure is expected on some NAT/cellular/corporate networks. Device revocation ends approved transport access; account sign-out clears account-specific peer bindings.
- Cache budgets apply to disposable fetched content, not the owning computer's original history. Drafts/outbox and synchronization metadata are outside eviction. Page/body display limits never truncate provider context.

## Configuration required outside source code

1. A self-hosted Mines account service, authentication secret and transactional email configuration.
2. Own HTTPS control domain, PostgreSQL database and STUN service. Deployment instructions are in `infra/mines-control/README.md`.
3. Provider login in isolated supported profiles and compatible CLI versions. No credentials are bundled or copied from unrelated applications.
4. Own signing teams, bundle registrations, provisioning, distribution/update repositories and mobile development builds.
5. Own push-delivery configuration before background notifications can be certified.

## Acceptance evidence

Focused unit, transport and service integration tests are run during implementation. Real Node WebRTC peers exchange traffic locally; fixtures exercise signatures, revocation, compression and replay protection. Group service tests use independent SQLite stores and lost acknowledgments to check duplicate suppression. The app is inspected through a fresh isolated local development database.

Desktop development builds pass. The native client retains catalog sections/pins across restart and exposes saved section context in the project editor. Cloud devices now require a bound subscription account; focused tests cover sign-out, unknown probes and account ownership. Native startup captures show the mine followed by BOOM and the app; the captures are JPEGs without alpha, so desktop compositing transparency remains visually unverified despite transparent assets/window configuration. The existing unsent draft is preserved.

The unsigned iOS simulator build installs and launches, and iOS/Android Metro bundles return HTTP 200. Simulator UI inspection was unavailable through this Xcode installation's device interface. The Android debug APK builds and its 120 notification regression tests pass. These results establish local build evidence only. Standalone Codex 0.164.0 is installed and satisfies the existing compatibility guard. Its prior release is retained; the separate app-bundled chat harness and authentication/configuration were not changed.

This is not evidence of physical iPhone/Android interoperability, cellular NAT traversal, reliable mobile background delivery, live quota switching, vendor cloud operation success, signed releases or complete assistive-technology acceptance. These gates require the configured services and devices below.

## Release checklist

- [ ] Self-hosted sign-in/recovery, account switching and device-registration lifecycle against deployed configuration.
- [ ] Physical iPhone and Android LAN, cellular, restrictive network, sleep/wake, background/foreground, revocation and no-relay verification.
- [ ] Three-device offline/concurrent catalog move, pin/unpin and deleted-container convergence using real clients.
- [ ] Live provider continuation, quota recovery, cloud task submission/status/results and reviewed local diff application with dedicated test accounts.
- [ ] Huge histories, parallel streams, malformed compressed payloads, snapshot races, slow consumers and cache pressure under measured load.
- [ ] Keyboard, screen readers, large text, Reduced Motion, onboarding recovery, multi-window and menu-bar review on packaged clients.
- [x] Local iOS simulator and Android debug builds.
- [ ] Signed/notarized macOS package; signed mobile distribution; own update-feed install/rollback validation.

The local workstation selects Apple Command Line Tools by default. Full Xcode is installed and its device utilities work with a task-local `DEVELOPER_DIR`; a paired iPhone is available. No Android device was attached during the initial inspection. Physical installs and network acceptance have not been performed. Provider cloud operations, signed distribution and physical-device acceptance still require their own verification.
