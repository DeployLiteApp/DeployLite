# P4 Routing, Domains, Certificates, Registries, TCP and UDP

Canonical scope: P4 in docs/community-roadmap.md. This is a working delivery record, not an approved P4 denominator or percentage. P4 remains planned and its whole acceptance boundary remains unaccepted. Base: protected-main P3 SHA c3e847c432100cd214f44bcf207446e3c33f71a1.

## Delivery lots and closure gates

These five lots turn the existing roadmap outcomes into evidence gates; they do not add a new P4 outcome. Passing a lot locally does not complete P4 or its remaining gates.

| Lot | Closure gate | Budget | State |
| --- | --- | ---: | --- |
| L1 Route identity and scope | Versioned host route intent binds project, normalized hostname, and a same-project successful deployment with a matching trusted receipt and snapshot. Exact repeat is a no-op; same-project retarget previews the prior target; foreign ownership, duplicate claims, invalid stored state, foreign deployment, and stale target fail closed. Hostname ownership is checked across all projects, including pre-existing domains. | 10–14 h | Local gate passed; review/CI pending |
| L2 Preview and apply | Server recomputes preview; mutation requires normal project.update authority and bounded idempotency key; route state, command outcome, audit, and durable terminal receipt are atomic or safely replayable. Apply goes through a verified Traefik path; unavailable/stale capabilities fail closed. | 16–24 h | Partial: claim persistence/read and authenticated preview are local; durable apply, replay ledger, and runtime route application remain |
| L3 Rollback and certificates | Route revision retains its prior binding; rollback uses normal authority and returns correlated evidence. Certificate remains bound to its domain; ACME renewal and rollback checks pass without exposing certificate material. | 12–18 h | Not started |
| L4 Registries and transport routes | Existing image trust boundary is preserved for registries; any credentials remain encrypted/redacted. TCP and UDP claims are scoped, idempotent, conflict-checked by protocol and port, and use the same authorized apply/rollback path. | 12–20 h | Not started |
| L5 Integrated acceptance | Exact-source acceptance covers domain HTTP and WebSocket traffic, issuance/renewal, rollback, registry behavior, TCP/UDP routing and conflict/retry cases, with no unexplained failure or skip and verified cleanup of owned disposable resources. | 16–24 h | Not started |

Total starting budget remains 66–100 effective hours, about 9–13 workdays and 2–3 calendar weeks with review and CI. The roadmap does not define a numeric P4 denominator, so no percentage is assigned.

## Current evidence and elapsed effort

At 2026-10-09 15:21 UTC, approximately 0.6 effective hours have been spent on L1 and the L2 preview slice. Estimate remaining: L1 9.4–13.4 h; total P4 65.4–99.4 h. This subtracts elapsed work from the existing budget; it does not restart or re-budget completed work. No range change: the time used is within the original 66–100 h estimate.

- Local: hostname contract, pure planner, cross-project DB claim reader and deployment binding, nullable deployment link on the existing P1 domains table, and read-only authenticated API preview are implemented. Existing successful deployments are stored as `succeeded` after their trusted receipt is accepted, so preview requires `succeeded`, a non-null completion time, and matching project/deployment/agent/snapshot fields in the receipt.
- Local focused evidence: TDD RED observed earlier for planner (5 failing assertions), contract validation (1 failure), and DB reader (3 failures). Current isolated Vitest run passes 31/31 across contracts, planner, DB reader, and API preview. The harness contains byte-identical copies of the implementation and test sources; no database, migration, Docker, or external service was started.
- Local TypeScript: the API source-contract check reports only the existing missing `yaml` dependency in `packages/domain/src/compose-input.ts` and resulting implicit-any errors there; it reports no errors in the new route, tests, or app composition. No dependencies were installed.
- Local: the API returns unavailable when claim storage is absent. The P1 domain table retains its existing global hostname uniqueness and rows without an attached application target remain reserved.
- Local: no durable route apply ledger, idempotent apply, rollback, or route runtime capability is complete.
- CI: no P4 CI result yet.
- Product/runtime: no route, DNS, VM, Traefik, registry, certificate, or deployment operation has been performed.
- Adapter selected: follow Dokploy's standalone Applications pattern—Traefik file provider with generated dynamic configuration, so domain changes can hot-reload without redeploying the app. Dokploy uses labels plus redeployment for Compose services. The existing DeployLite control-plane Traefik config has only the Docker provider; adding and safely exercising the file-provider path remains future local work. References: [Dokploy Domains](https://docs.dokploy.com/docs/core/domains), [Dokploy Domains & Traefik troubleshooting](https://docs.dokploy.com/docs/core/troubleshooting/domains).
- The root checkout has unrelated pre-existing WIP; it remains untouched. All P4 edits stay on feat/p4-route-policy.

## Reuse and integration findings

- PostgreSQL already has a domains table with globally unique hostname and a certificates table linked by domain_id. Reuse these; do not create duplicate domain or certificate tables.
- No current domain route repository or API/agent route capability was found.
- The existing VPS Traefik configuration uses its Docker provider for the DeployLite control-plane services; application route mutation is not implemented.
- A P4 host claim must still conflict with an existing hostname row even when that row has no application deployment target.
- GitHub authentication currently reports invalid tokens for the configured DeployLiteApp and CoreFoundryTech accounts, and api.github.com is unreachable. Authentication will not be changed. No issue was created; push and PR draft are pending restored authorized access.

## Verification caveat

The sandboxed Vitest runner could not load the hidden P4 worktree directly. Focused tests ran from a temporary harness in the writable task workspace against byte-identical implementation and test copies, verified with cmp. No dependencies or local services were added. Full workspace check and hosted CI remain outstanding.
