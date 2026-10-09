# P4 Routing, Domains, Certificates, Registries, TCP and UDP

Canonical scope: P4 in `docs/community-roadmap.md`. This is a working delivery record, not an approved numeric denominator or percentage. P4 remains unaccepted as a whole. Base: protected-main P3 SHA `c3e847c432100cd214f44bcf207446e3c33f71a1`.

## Delivery lots and closure gates

These five lots turn the existing roadmap outcomes into evidence gates; they do not add a new P4 outcome. A local or branch CI pass does not make P4 shipped on `main`.

| Lot | Closure gate | Re-estimated remaining effort | State |
| --- | --- | ---: | --- |
| L1 Route identity and scope | Versioned host route intent binds project, normalized hostname, and a same-project successful deployment with a matching trusted receipt and snapshot. Exact repeat is a no-op; same-project retarget previews the prior target; foreign ownership, duplicate claims, invalid stored state, foreign deployment, and stale target fail closed. Hostname ownership is checked across all projects, including pre-existing domains. | 1–2 h review/closeout | Implementation and exact branch CI passed; awaiting PR review |
| L2 Preview and apply | Server recomputes preview; mutation requires normal `project.update` authority and bounded idempotency key; route state, command outcome, audit, and durable terminal receipt are atomic or safely replayable. Apply goes through a verified Traefik path; unavailable/stale capabilities fail closed. | 1–2 h review/closeout | Implementation and exact branch CI passed; PostgreSQL suite 59/59 on the last L2 head; awaiting PR review |
| L3 Rollback and certificates | Route revisions retain prior bindings; rollback uses normal authority and returns correlated evidence. Certificate remains bound to its domain; isolated ACME issuance/renewal acceptance passes without exposing certificate material. | 3–7 h | Branch lot complete: exact-source CI run 37970129129 passed all six gates on ba5cb6d; awaiting PR review |
| L4 Registries and transport routes | Existing image trust boundary is preserved for registries; credentials remain encrypted/redacted. TCP and UDP claims are scoped, idempotent, conflict-checked by protocol and port, and use the same authorized apply/rollback path. | 8–14 h | Not started |
| L5 Integrated acceptance | Exact-source acceptance covers domain HTTP and WebSocket traffic, issuance/renewal, rollback, registry behavior, TCP/UDP routing and conflict/retry cases, with no unexplained failure or skip and verified cleanup of owned disposable resources. | 7–13 h | Not started |

Estimated remaining development effort for L4–L5: **15–27 effective hours**. Hosted wait is separate: the latest full baseline run took 7m05, so budget **about 7–12 minutes per exact-source run** and another 7–12 minutes for each fix-and-rerun cycle. PR review wait has no reliable estimate; PR #387 currently has no reviews, so treat that queue as unbounded rather than adding a guessed number. These figures are not a calendar promise. The engineering estimate reflects reuse of the L1/L2 route intent, command authorization, idempotency, trusted execution receipt, agent transport and Traefik file provider; PostgreSQL domain/certificate tables; the disposable PostgreSQL acceptance workflow; and the existing Pebble ACME renewal harness. L4 still adds protocol/port claims and their conflict behavior. L5 must prove those parts together with real HTTP/WebSocket behavior and cleanup.

The L1/L2 commits span 1 h 54 min from the first route preview commit (`d352a43`, 12:23 local) to the L2 closeout record (`ead30d3`, 14:17 local) on 2026-10-09. That is elapsed commit time, not measured active effort, so the remaining estimate is based on the verified reuse and untested risks above rather than extrapolating from the span. No new P4 denominator or overall product percentage is inferred.

## P4 acceptance criteria status

This list makes the current work visible without treating unlike criteria as equal percentage points.

| # | Criterion | State |
| --- | --- | --- |
| 1 | Normalized route ownership, cross-project conflict checks, same-project trusted deployment binding | L1 implementation and hosted branch gate passed |
| 2 | Server-recomputed preview; stale or unavailable route capability fails closed | L1 implementation and hosted branch gate passed |
| 3 | Authorized, idempotent apply with atomic route state, audit, and terminal replay receipt | L2 implementation and hosted branch gate passed |
| 4 | Verified target and isolated Traefik file-provider route update | L2 implementation and hosted branch gate passed |
| 5 | Successful route changes append revisions preserving previous bindings | Exact-source CI run 37970129129 passed on ba5cb6d |
| 6 | Rollback uses `project.update`, trusted prior receipt, idempotency, and correlated audit evidence | Exact-source PostgreSQL gate passed in run 37970129129 on ba5cb6d |
| 7 | Certificate metadata remains bound to its domain and isolated ACME renewal passes without material disclosure | PostgreSQL and Pebble ACME gates passed in run 37970129129 on ba5cb6d |
| 8 | Registry trust boundary and credential encryption/redaction | Pending L4 |
| 9 | TCP/UDP protocol-and-port-scoped claims, conflicts, apply, and rollback | Pending L4 |
| 10 | Integrated exact-source HTTP/WebSocket/TLS/rollback/registry/TCP/UDP/retry and owned-resource cleanup acceptance | Pending L5 |

## Current evidence

- The latest verified L1/L2 head is `ead30d397f0a888683f658ed3355d6640fec7105` on draft [PR #387](https://github.com/DeployLiteApp/DeployLite/pull/387). Exact CI [run 37965207204](https://github.com/DeployLiteApp/DeployLite/actions/runs/37965207204) passed all six gates: `quality`, `postgres-integration`, `compose-and-supply-chain`, `p2-docker-acceptance`, `p3-docker-acceptance`, and `baseline-gate`. Its PostgreSQL report was 59/59 with zero failures/skips. This is L1/L2 evidence only; it predates the current local L3 changes. PR review is pending; no merge is recorded.
- Local L3 work adds `domain_route_revisions`, including an active-route baseline backfill and redacted evidence fields. Route completion appends the revision in the same transaction as domain state, command outcome, command audit and correlated audit event. Rollback selects an earlier different binding, verifies the same project and trusted execution receipt, dispatches through the existing authorized agent path and records the target revision. Same-key retries recover the stored reservation or completed receipt.
- The PostgreSQL integration case covers apply, retarget, authorized rollback and replay; it asserts that the existing certificate row remains attached to the domain and that revision evidence contains only allow-listed redacted fields. The PostgreSQL job passed in 48s on exact source ba5cb6d in run 37970129129; a report artifact was produced.
- The existing ACME acceptance uses isolated Pebble, binds its published Pebble API/management and Traefik TLS ports to loopback, and reports issuer, serial, expiry and an ACME-storage digest; it does not print certificate or private-key material. A Compose contract assertion protects the loopback bindings. The exact-source CI `compose-and-supply-chain` job runs `pnpm test:acme-renewal` and passed in 3m29s on ba5cb6d in run 37970129129; its report artifact was produced.
- Four commits were pushed to the existing draft branch after direct user authorization; remote head is `ba5cb6d`. Exact CI run 37970129129 passed all six gates, including PostgreSQL and Pebble ACME. PR #387 remains draft and unmerged; these are branch results, not protected-main evidence.
- Local verification on 2026-10-09 with Node 24.20.0: 26 focused tests pass (contracts 13, API 6, DB repository 3, Traefik file store 4); source typechecks pass for domain, contracts, DB, API and agent. Static DB validation checked all 23 migrations; CI evidence configuration, JSON parsing, `git diff --check`, 55 acceptance-harness guard tests, 38 PostgreSQL-restart evidence tests, and the Vitest forbid-only contract pass. Exact-source hosted PostgreSQL and Pebble ACME gates now also pass in run 37970129129.
- Runtime boundary: no local PostgreSQL connection, migration execution, Docker, Traefik, VM, DNS, registry, certificate, or deployment operation was run. Hosted PostgreSQL and Pebble CI use their existing disposable jobs. The unrelated root checkout and Moteles resources remain untouched.

## Adapter and reuse decisions

- Selected adapter: follow Dokploy's standalone Applications pattern—Traefik's watched file provider with generated dynamic configuration and hot reload. Dokploy uses labels plus redeployment for Compose services; those labels are not the right update path for an already-running standalone application. References: [Dokploy Domains](https://docs.dokploy.com/docs/core/domains), [Dokploy Domains and Traefik troubleshooting](https://docs.dokploy.com/docs/core/troubleshooting/domains).
- PostgreSQL already has `domains` and `certificates` linked by `domain_id`; keep these relations and do not create duplicate domain or certificate tables.
- Existing project image receipts and digest policy provide the registry trust foundation; L4 still needs to preserve that boundary while adding registry behavior.
- A P4 host claim conflicts with any existing hostname row, even if that row has no application deployment target. Shared route networking is not used because it would allow cross-project app traffic; route targets use project-isolated networking.
- L3 implementation is published on `feat/p4-route-policy` at `ba5cb6d`; exact-source run 37970129129 passed. PR #387 remains a draft and is not merged to protected main. The protected-main checkout, other projects, and external runtime configuration are outside this delivery.
