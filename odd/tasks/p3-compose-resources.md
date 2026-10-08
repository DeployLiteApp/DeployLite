# P3 Compose, Networks and Volumes

Canonical repository locator: `odd/tasks/p3-compose-resources.md`; official FULL Engram mirror: project `deploylite`, topic `odd/p3-compose-resources/tasks`. Method: ODD; strict prospective RED → GREEN → REFACTOR, RDD OFF. Base main: `fd5f674044b70f702f293bd469c860217ad4167b`; P2 is complete 14/14 and is preserved.

## Authorized outcome

Current community roadmap: make Compose, networks and volumes first-class resources. Compose must be parsed, canonicalized, policy-validated, dry-runable and secret-safe; ownership, attachment, inspection, backup where applicable and confirmed cleanup must be tested. Jerson authorized starting P3 on 2026-10-08, local repository work in isolation and draft PR/CI. No new production/VPS/DNS/credentials/runtime access is inferred. No local services, Docker/DB, heavy builds or dependency changes. Existing other-project resources and Safari remain untouched.

## Finite acceptance outcomes

These eight outcomes are derived from the existing roadmap; they are a working acceptance denominator, not a count of code files, tests, commits or PRs. None is accepted yet: 0/8. Baseline reuse does not mean zero implemented code and earns no new P3 acceptance credit.

| ID | Result and completion evidence | State |
| --- | --- | --- |
| C1 | Compose input parsing, canonical equivalent intent and scoped digest, explicit closed policy, effect-free dry run and no literal/resolved secret exposure; supported-format/invalid/unsupported/canonicalization evidence | Pending; bounded JSON preview source in progress; YAML remains pending |
| C2 | Project-owned Compose resource and immutable revision lifecycle exposed through API/UI, safe reads and auditable normal authorization, idempotency and capability boundaries | Pending |
| C3 | Network/volume identities and ownership with conflict/foreign-resource rejection; durable repository parity and observed owner evidence | Pending |
| C4 | Service-to-resource attachment/detachment with matching ownership, running-use and stale-state guards; bounded retry/failure cases | Pending |
| C5 | Capability-negotiated inspection from actual observations with safe API/UI projections, missing/disabled capability rejection and no simulated physical credit | Pending |
| C6 | Backup of applicable owned persistent volumes, bounded destination/operation, integrity/completeness evidence and safe failure reporting; database restore/retention remains P5 | Pending |
| C7 | Exact-scope confirmed cleanup through shared command/audit/idempotency path, expiration/replay/stale/attached/foreign rejection and visible observed terminal result; no indiscriminate purge | Pending |
| C8 | Same-source integrated Compose/network/volume/backup/cleanup acceptance on a specifically authorized disposable supported environment; zero unexplained failures/skips, own cleanup and full documentary custody | Pending |

## Reuse and verified gaps

Reusable main foundations: project grants/RBAC, audit/correlation, destructive confirmations and idempotency, digest-image validation, agent effect/inspection boundaries, repository ports/PostgreSQL foundations and redacted secret metadata. No application Compose parser/revision model or managed network/volume resource routes/tables were found on current main; previous installer/preview Compose infrastructure and historical memories are prerequisites, not shipped P3 product resource management. Fresh GitHub main/identity and open PRs checked: DeployLiteApp identity unchanged; no open PR or matching active P3 issue found. No duplicate issue was created.

## Provisional work budget

Hours below are active implementation/verification work, not calendar ETA or an approved delivery promise. They are based on the missing model/lifecycle across contracts/domain/repositories/agent/API/UI and existing reusable infrastructure. P2 required multiple source/CI corrections; no assumption of a single successful CI attempt is made.

| Block | Active hours |
| --- | ---: |
| Compose parsing/policy/canonicalization/preview | 4–7 |
| Owned resources/revisions/API/UI | 5–8 |
| Attachments/inspection | 5–8 |
| Applicable volume backup | 3–6 |
| Confirmed cleanup/failure recovery | 5–8 |
| Integrated isolated acceptance | 4–7 |
| Review/CI corrections | 3–6 |
| Total provisional | 29–50 |

Calendar depends on hosted CI queue/review, parser dependency decision and concrete disposable runtime authorization. The last P2 documentary five-gate run took about376 seconds; source retries added time. The Mac currently has about12GiB free; no competing local service/build was launched. Full local `pnpm check` is not run under the shared-Mac heavy-build boundary; the expected command remains unchanged and hosted required gates must pass before readiness.

## First vertical increment and checkpoint

Worktree/branch are isolated from current main. `POST /api/v1/projects/:projectId/compose/preview` composes session/role/project.deploy grants, a bounded closed Compose JSON model, existing image policy, canonical project/policy digest, proposed project-scoped network/volume identities, explicit/implicit network attachments and named-volume mount/secret-reference metadata. It does not persist source, resolve secrets or reach any runtime. `executionAllowed` is always false. Unsupported fields and unsafe inputs fail closed with generic source-safe errors. No deployment, resource creation or ownership observation is claimed by the preview.

Observed prospective RED: domain29FAIL/1PASS and API11FAIL/1PASS; initial fixture syntax/setup failures are retained separately and do not count as behavioral RED. Observed audit RED:1FAIL/1PASS because the existing safe projection discarded digest/counts. Final focused GREEN: domain30/30, API12/12, audit2/2 and affected redaction regressions8/8; fail0/skip0. Current-source and all three new-test noEmit checks exit0. Audit now admits only a64-character lowercase hexadecimal inputDigest and bounded integer service/network/volume counts; source/env/secret fields remain excluded. Type-only test refactor removed temporary any annotations. Draft delivery and unchanged hosted required gates are required before readiness; exact PR/head/CI custody is recorded separately in the project checkpoint and canonical mirror. This is one vertical source increment inside the first of six principal work blocks; eight acceptance outcomes remain fixed and unaccepted.

YAML is not accepted by this increment. No YAML parser is declared on main; the existing installed js-yaml version differs the current locked policy and is not adopted from transitive/ambient installation. A proper parser dependency decision is still needed under the existing no-dependency-changes instruction. JSON input currently uses standard JSON.parse semantics; this is a closed JSON preview, not complete Compose Specification compatibility or runtime normalization. Full C1 and C8 remain unaccepted.

## Primary semantic references

[Compose Specification](https://docs.docker.com/reference/compose-file/), [networks](https://docs.docker.com/reference/compose-file/networks/), [volumes](https://docs.docker.com/reference/compose-file/volumes/) and [interpolation](https://docs.docker.com/reference/compose-file/interpolation/) inform the closed subset and the distinctions between declarations, implicit default networks, external resources and unresolved references. Project policy rejects unsupported fields instead of emulating their effects.

## Preview delivery and UI checkpoint

Initial API/domain/audit source is [draft PR381](https://github.com/DeployLiteApp/DeployLite/pull/381), commit `acd7d7d889ed5f56a46ec07c87550428e318aba0`. [Hosted run37708592409](https://github.com/DeployLiteApp/DeployLite/actions/runs/37708592409) passed all five unchanged required gates on that exact head: quality, PostgreSQL integration, Compose/supply chain, Docker acceptance and baseline gate. These baseline compatibility jobs provide no new P3 physical acceptance or runtime authority.

The next coherent source unit integrates the scoped JSON preview into the project page for admin/operator roles; the existing API still enforces project.deploy grants. Browser credentials remain browser-managed; no cookie value is passed to the new component. The draft remains transient, has explicit clear controls and no browser storage writes. Results show proposed identities, attachments, secret-reference names and digest; source errors are generic, invalid/executable/foreign previews are rejected and editing invalidates pending or completed old results. No apply/deploy/resource deletion action is offered.

Prospective UI/client assertions observed19FAIL/3PASS; project entry assertions2FAIL/2PASS. Those five initially passing cases are characterization, not retrospective RED. One missing semantic heading and two typed fixture details were corrected with original reports retained. Final UI/client/page source passes26 new cases,27 existing rendering regressions and noEmit exit0; fail0/skip0. Latest draft head and its required CI status must be read from the project checkpoint; the initial passing SHA does not certify a later commit. YAML, durable resource revisions, observed ownership and every remaining lifecycle criterion are still pending:0/8 accepted.

## YAML source preparation after initial merge

PR381 is now merged normally through protected main as `09b9561491499fd842daa072cd7e9fafec0b4b40`; both exact source head `d6cd2f35e4e1de3c1f1c14025520c37c9e41beb8` and the automatic post-merge [main run37711295812](https://github.com/DeployLiteApp/DeployLite/actions/runs/37711295812) passed all five unchanged workflow gates. The earlier draft wording above is a retained historical delivery checkpoint, not current PR state. No protections, authentication, runtime access or unrelated WIP were changed; own branches/worktrees and12 stash OIDs remain preserved.

An isolated YAML source branch starts from this merged main. Domain35/API6/UI2 prospective cases observed41 assertion FAIL and2 already passing role/scope characterization cases; none skipped. The first unwrapped missing-feature report is retained separately; final RED uses explicit assertions and no syntax/setup failure is counted. Supported YAML1.2/JSON equivalence, canonical markers/comments/defaults, project/policy binding, no ambient secret lookup, closed resource policy and source-safe parse errors are covered. Unsupported/ambiguous duplicate keys, aliases/merge keys/tags, multiple documents and bounded depth/node/UTF8 input are specified before implementation. GREEN and C1 acceptance are still pending.

The preferred dependency proposal is exactly `yaml@2.9.1` in the domain package, no runtime dependencies and686297 unpacked bytes. It provides a document AST, errors/warnings, unique-key checks and alias limits. The alternative `js-yaml` would follow the existing4.3.2 override and require argparse plus more custom AST/alias policy work; the ambient4.3.1 install is not adopted. Primary registry metadata and the exact manifest proposal are recorded privately. Existing AGENTS.md says "No heavy builds/dependency changes"; an explicit one-package exception was requested. No manifest/lock/tooling/dependency installation was changed while the answer is pending. Node24.20 and existing source runners remain in use, with no local services, heavy build, Docker, DB, migration, VPS, DNS, credentials or Safari action.

Six principal work blocks and eight fixed acceptance outcomes remain unchanged. No outcome is accepted yet:0/8. Next dependent action is the bounded YAML parser implementation after that concrete dependency decision; no timer or passing old-case count substitutes for approval or acceptance.

## YAML dependency resolution and local verification

The exact `yaml@2.9.1` dependency and its importer/package/snapshot lock records were directly approved by Jerson's “Si” on 2026-10-08T02:12:32Z. This resolves only the preceding one-package dependency blocker; no other dependency/tooling/global settings or runtime authorization is inferred. The official archive was verified against its SHA512 integrity, adds zero runtime transitives and was unpacked for focused source tests without lifecycle scripts or a workspace install. Structural lock verification preserves every other manifest/lock record; actual frozen pnpm9 installation is left to unchanged hosted gates.

The preview now decodes one YAML1.2 core/JSON mapping before applying the same closed Compose policy, canonicalization, project/policy-bound digest, proposed resource identities and effect-free API/UI path. Supported comments/BOM/document markers and equivalent JSON/YAML produce the same plan. Duplicate keys (including JSON), extra documents, other YAML versions, explicit tags/custom directives, anchors/aliases/merges/complex keys, more than8192 AST visits or depth16, and more than64KiB UTF8 fail closed with a generic `COMPOSE_INVALID_DOCUMENT` code. Unsupported Compose fields and unsafe images/resources remain rejected by the existing policy. Literal or ambient/default secret values are never resolved. This is an explicit supported subset, not complete Compose Specification support.

Prospective evidence: the original43 cases had41 behavioral assertion failures and2 passing existing role/scope characterizations. Four added cases exercised deep/large content inside actual root mappings, unused anchors and custom tag directives (4 assertion RED); two additional diagnostic-flag cases observed assertion RED before rejecting parsing when the dependency could print raw tokens. The implementation does not mutate diagnostic flags or any environment setting. A first GREEN attempt exposed the library's silent-mode multidocument omission; changing only parser logging to error-level preserves errors while keeping source out of warnings/logs. All these expectations remain unchanged in final GREEN.

Final focused verification is144/144 PASS: domain71 (41 new +30 prior), API18 (6 new +12 prior), UI55 (2 new +26 prior Compose +27 existing rendering), zero failures/skips. Total new49:47 prospective assertion RED→GREEN and2 existing boundary characterizations. Current-source/new-test noEmit for API/domain and web both exit0. The three existing label assertions were updated solely for the supported YAML/JSON field label. Ordinary source review and unchanged hosted full checks are required on the exact submitted head; full local `pnpm check` remains deferred under the shared-Mac heavy-build restriction. Root WIP/index/stashes, P2 source/doc custody, unrelated worktrees and Moteles resources remain unchanged.

Current delivery status: local C1 source/verification complete; exact protected CI/merge remains pending. P3 remains0/8 accepted until that delivery is proven. The fixed six work blocks and eight outcomes are unchanged. After YAML delivery, proceed with the project-owned immutable revision contract/repository source boundary; observed ownership/attachment/inspection/backup/cleanup and disposable runtime acceptance remain later outcomes.
