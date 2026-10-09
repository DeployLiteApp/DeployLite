# P4 Routing, Domains, Certificates, Registries, TCP and UDP

Canonical scope: P4 in docs/community-roadmap.md. This is a working delivery record, not an approved P4 denominator or percentage. P4 remains planned and its whole acceptance boundary remains unaccepted. Base: protected-main P3 SHA c3e847c432100cd214f44bcf207446e3c33f71a1.

## Delivery lots and closure gates

These five lots turn the existing roadmap outcomes into evidence gates; they do not add a new P4 outcome. Passing a lot locally does not complete P4 or its remaining gates.

| Lot | Closure gate | Budget | State |
| --- | --- | ---: | --- |
| L1 Route identity and scope | Versioned host route intent binds project, normalized hostname, and a same-project successful deployment with a matching trusted receipt and snapshot. Exact repeat is a no-op; same-project retarget previews the prior target; foreign ownership, duplicate claims, invalid stored state, foreign deployment, and stale target fail closed. Hostname ownership is checked across all projects, including pre-existing domains. | 10–14 h | Local gate passed; hosted CI passed on PR #387; review pending |
| L2 Preview and apply | Server recomputes preview; mutation requires normal project.update authority and bounded idempotency key; route state, command outcome, audit, and durable terminal receipt are atomic or safely replayable. Apply goes through a verified Traefik path; unavailable/stale capabilities fail closed. | 16–24 h | Partial: authenticated preview, deterministic Traefik renderer, and atomic local file store are implemented; authorized apply protocol, durable DB outcome/replay, live-target verification, and per-project network attachment remain |
| L3 Rollback and certificates | Route revision retains its prior binding; rollback uses normal authority and returns correlated evidence. Certificate remains bound to its domain; ACME renewal and rollback checks pass without exposing certificate material. | 12–18 h | Not started |
| L4 Registries and transport routes | Existing image trust boundary is preserved for registries; any credentials remain encrypted/redacted. TCP and UDP claims are scoped, idempotent, conflict-checked by protocol and port, and use the same authorized apply/rollback path. | 12–20 h | Not started |
| L5 Integrated acceptance | Exact-source acceptance covers domain HTTP and WebSocket traffic, issuance/renewal, rollback, registry behavior, TCP/UDP routing and conflict/retry cases, with no unexplained failure or skip and verified cleanup of owned disposable resources. | 16–24 h | Not started |

Total starting budget remains 66–100 effective hours, about 9–13 workdays and 2–3 calendar weeks with review and CI. The roadmap does not define a numeric P4 denominator, so no percentage is assigned.

## Current evidence and elapsed effort

At 2026-10-09 15:44 UTC, re-estimated remaining work by scoped implementation, not elapsed clock time: L1 review/merge 1–2 h; L2 apply 11–17 h; L3 12–18 h; L4 12–20 h; L5 16–24 h. Total remaining is 52–81 effective hours. This credits the completed L1 implementation and the L2 preview plus deterministic renderer/file-store foundation (roughly 7–9 hours of planned scope); later L3–L5 estimates are unchanged. This is a working estimate, not a roadmap percentage: P4 has no formal numeric denominator.

- Local: hostname contract, pure planner, cross-project DB claim reader and deployment binding, nullable deployment link on the existing P1 domains table, and authenticated read-only API preview are implemented. Preview requires a successful deployment, a non-null completion time, and matching project/deployment/agent/snapshot fields in the trusted receipt.
- Local: deterministic Traefik file-provider config rendering requires the canonical route, matching trusted execution receipt, active container naming, and a project-derived network name. The agent file store writes by same-directory temp file, fsync and atomic rename; exact replay is a no-op and symlink/non-file targets fail closed. These helpers are not yet wired to an authorized API/agent apply command.
- Local: the TLS Compose overlay now enables Traefik's watched file provider and mounts a dedicated dynamic-config volume read-only in Traefik and writable in the agent. Both Compose documents parse as YAML. No Compose or Docker command was run.
- Local dependency/gates: Node 24; selectively installed `yaml@2.9.1` from the existing lockfile with `--frozen-lockfile --offline`; no lockfile/version change. Typechecks pass for contracts, config/domain build, domain, agent, DB, and API. Focused tests pass 43/43: contracts 11, planner 7, Traefik renderer 9, DB reader 3, API preview 10, and agent atomic file store 3.
- Published increment: `d352a4329213db806ffad67fee9cc4c00388b6ad` is on `feat/p4-route-policy`; draft [PR #387](https://github.com/DeployLiteApp/DeployLite/pull/387) is open. Exact-SHA CI run [37952403985](https://github.com/DeployLiteApp/DeployLite/actions/runs/37952403985) passed quality, Compose/supply-chain, PostgreSQL integration, P2 Docker acceptance, P3 Docker acceptance, and baseline gate. The follow-on renderer/store work is a separate increment and is not included in that run.
- Remote history check: PRs #384, #385, and #386 are merged; their head branches still exist remotely. No branch was deleted and no duplicate issue was created.
- Runtime boundary: no migration, DB, Docker, Traefik, VM, DNS, registry, certificate, or deployment operation was run. Shared route networking was rejected because it would allow cross-project app traffic. Apply still needs isolated per-project network attachment, current target health/identity verification, an authorized API/agent protocol, and durable route/command/audit/replay completion.
- Adapter selected: follow Dokploy's standalone Applications pattern—Traefik's file provider with generated dynamic configuration and hot reload. Dokploy uses labels plus redeployment for Compose services. References: [Dokploy Domains](https://docs.dokploy.com/docs/core/domains), [Dokploy Domains & Traefik troubleshooting](https://docs.dokploy.com/docs/core/troubleshooting/domains).
- The root checkout has unrelated pre-existing WIP; it remains untouched. All P4 edits stay on feat/p4-route-policy.

## Reuse and integration findings

- PostgreSQL already has a domains table with globally unique hostname and a certificates table linked by domain_id. Reuse these; do not create duplicate domain or certificate tables.
- The current API has an authenticated preview and a DB claim reader; the generated file provider and atomic writer are still local helpers, not yet an API/agent route execution capability.
- Deployments currently use an existing image receipt and their route target network must be project-isolated. Attaching all projects to one shared route network is unsafe; the agent must manage and verify per-project network attachment before a route can be applied.
- A P4 host claim must still conflict with an existing hostname row even when that row has no application deployment target.
- The authorized push to the DeployLiteApp repository succeeded after the sandbox network review; no authentication or remote URL was changed. PR #387 is the only P4 draft for this branch.

## Verification caveat

All 43 focused source-level tests ran against the actual isolated P4 worktree after the frozen, offline dependency install. Hosted CI run `37952403985` covers published commit `d352a43`; follow-on renderer/store work needs its own hosted CI evidence. No full-workspace test suite, database migration, or runtime service was run.
