# P5 Stateful Workloads and Operations

Canonical boundary: P5 in `docs/community-roadmap.md`. Base protected main: `8c72c0b51c002d4e9c55fcc5898ecb461a796448`; P4 is accepted and remains unchanged. ODD, prospective RED/GREEN, existing ports/adapters/cipher/authority, RDD off. This tracker supplies work units, not a new approved phase denominator or time percentage.

## Roadmap outcomes and remaining acceptance

- Managed databases and catalog applications must use isolated, project-owned persistent storage.
- Generated workload credentials must use the existing encrypted secret repository and project scope; secret values must not enter metadata, audit, receipts or telemetry.
- Backup and retention must use an explicit policy, verified source/contents, durable inventory, scoped authority and protected restore references.
- Destructive restore must use existing confirmation and authority, verified immutable backup evidence, correlated audit and bounded recovery evidence.
- Health checks and telemetry must be workload-scoped, bounded and secret-safe.
- Actual integrated acceptance must verify the whole boundary before P5 can be marked accepted. Existing P3/P4 foundations alone grant no P5 completion credit.

## Active delivery units

| Unit | Boundary | Status |
| --- | --- | --- |
| R1 | Pure retention preview over verified P3 backup receipts, explicit keep-newest count and restore-protected archives | Draft PR #389; exact `806c7dd` CI 38058774713 passed 7/7; source 14/14 and full check pass; protected-main integration not yet authorized |
| R2 | Durable backup inventory and authorized retention preview with audit/replay and stale-inventory fences | Proof preparation draft #390 (`78a13a7`) CI 38059688641 approved; SQL draft #391 at `ecd700d` CI38064887220 approved (all applicable gates); 5/5 physical P5 PG cases pass. Authenticated ingestion source + factory wiring passes; sixth SQL audit case prepared; authorized retention API remains pending |
| S1 | Managed database/catalog profile planning with project-owned storage and approved immutable images | Pending; reuse Compose and image policy |
| S2 | Generated credentials using existing cipher/repository, atomic secret-safe configuration and replay | Pending |
| B1 | Database-consistent backup and verified durable archive evidence | Pending |
| R3 | Authorized retention execution with fresh scope/hash/protection verification and atomic evidence | Pending |
| D1 | Confirmed destructive restore, verification, audit and recovery | Pending |
| H1 | Scoped health and secret-safe telemetry | Pending |
| A1 | Integrated PostgreSQL/Docker acceptance and phase review on protected main | Pending |

R1 is metadata planning only and grants no deletion authority. The count policy is explicit and positive, with no guessed retention duration or default. Restore-protected archives are retained even outside the count. Archive IDs, SHA-256 content/manifest, timestamp, project, volume, destination, keep count and protected IDs bind the preview; inventory order is deterministic. Duplicate archive IDs, unknown/duplicate protection references, invalid count, foreign receipt scope and non-contract fields fail with a bounded generic error.

## Current evidence

- Prospective initial behavior assertion: RED because planning was unavailable, then GREEN with a scoped retention plan.
- Three prospective binding assertions observed RED: inventory digest omitted scope; plan omitted protection that was already retained; retained archive integrity did not bind the plan. GREEN now binds all three. Additional guard/purity/order cases characterize the implementation and are not described as retrospective RED.
- `pnpm --filter @deploylite/domain exec vitest run src/backup-retention.test.ts`: 14 PASS. `pnpm --filter @deploylite/domain typecheck`: exit 0, Node 24.20.0. Binding RED log: `/tmp/deploylite-p5-retention-red.log`.
- No archive deletion, restore, local service, production credential, VPS, firewall or external DNS operation was performed. Full Node 24.20.0 `pnpm check` exits 0 (`/tmp/deploylite-p5-retention-check.log`); exact-source hosted CI remains a delivery gate. P5 remains unaccepted.

- R2 proof preparation accepts only an authenticated transport receipt corroborated against a server-owned completed `project.update` command, exact project/command/digest/correlation/actor and existing successful backup audit metadata. It rejects mismatches, foreign agent/scope and invalid/future creation time. It does not authenticate arbitrary HTTP input or write inventory. The 19 negative/positive assertions observed prospective RED then GREEN (`/tmp/deploylite-p5-inventory-red.log`).
- Automatic approval review rejected the proposed PR #389 protected-main merge because current authorization covers P5 implementation, not that specific integration. The safer draft delivery remains available; no bypass or retry was attempted. Source implementation continues on its dependent branch.

- Full Node 24.20.0 `pnpm check` for the R2 proof-preparation source exits 0; receipt `/tmp/deploylite-p5-inventory-check.log`. SQL/API/durable acceptance remains pending.

- R2 SQL unit: immutable scoped `backup_inventory` projection, project/command/audit FKs, unique archive scope/command/audit, database-enforced receipt binding and original audit time. Authenticated cache replay preserves the original audit status/time; a colliding command/archive fails without overwriting. Reader rejects invalid/foreign evidence and refuses truncated inventories above 10,000 records. Unit RED: 9 failures before implementation, then 9 GREEN; `/tmp/deploylite-p5-inventory-store-red.log`. No local PostgreSQL/Docker or migration execution occurred. Five physical PostgreSQL cases are source-prepared for the existing disposable hosted job (DB inventory now 66 cases, original 61 retained); execution is still pending. No retention deletion or destructive restore is authorized by this projection.

- SQL unit full Node 24.20.0 `pnpm check` exits 0 (`/tmp/deploylite-p5-inventory-store-check-fixed.log`). Initial failure preserved in `/tmp/deploylite-p5-inventory-store-check.log`: the added suite changed the missing-URL error wording; correction retained the existing guard and its 2/2 tests pass. Mocked CI evidence guards: 38 PASS. These local checks do not claim physical P5 PostgreSQL execution.

- R2 ingestion source: three prospective assertions failed before implementation, then GREEN with 47 existing backup API cases retained. Configured SQL repositories provide an agent-bound inventory writer; completion/audit precede ingestion, completed receipt replay retries a failed inventory append without another backup, and configured unavailable inventory fails before dispatch. Factory wiring observed RED then GREEN without DB connection. The original ingestion assertion was corrected to inspect the safe audit identity/correlation: the in-memory log projection intentionally omits command metadata. Existing generic redaction already preserves canonical `backup_<32 hex>` IDs; no redaction change is needed or retained. A sixth physical SQL case now exercises the actual shared project-update completion/audit rather than only seeded audit fixtures.
- First #391 hosted PostgreSQL run38064532614 failed the five added fixture cases because a seed parameter was inferred as both UUID and text. Focal fixture correction `ecd700d` uses separate parameters, preserving source/gates and the original failure log `/tmp/deploylite-p5-store-ci-failure.log`; exact corrected hosted run38064887220 is pending.

- Corrected #391 hosted PG run38064887220: DB66/66, including all five P5 cases, zero failure/skip; API12/12 and Compose15/15 retain their existing gates. Restart and zero-fixture cleanup verified. The artifact binds GitHub test merge `52cfa4045cb1e62c0b8a5bdeb3a86fd815a0164e` (parents #390 head `78a13a7` and #391 head `ecd700d`); all 79 source hashes match exact `ecd700d`. Evidence `/tmp/deploylite-p5-store-ecd700d`. This is draft-source physical acceptance, not protected-main integration or whole-P5 closure.

- Ingestion unit full Node24.20.0 `pnpm check` exits0 (`/tmp/deploylite-p5-ingestion-check-fixed.log`); API focal51/51 and API/DB source typechecks pass. The added physical fixture uses logical archive ID `string`, correcting the initial inferred UUID-only type; original failed check retained. Rollback boundary: remove the optional ingestion hook/writer port, DB factory and their tests; retain existing P3 backups, archives, immutable inventory/audit rows and migration0027. No destructive rollback/drop is implied.

## Explicit complete test execution partitions

Jerson forbids skipped tests inside suites as well as skipped jobs. Keep every original case and its physical assertion. Unit collection retains all recorded guards, while the existing explicit PostgreSQL/P2/P3/P4 flags collect their physical files in mandatory hosted jobs. The two mixed files retain74 P2 recorded guards and1 diagnostic unit guard in unit collection; their original13 physical and1 opt-in cases execute in their existing required jobs. No physical test is treated as PASS merely because unit collection does not load it. Complete delivery requires observed execution of every partition on the exact published source. Physical count/title/restart/cleanup/source/ownership checks remain unchanged.

Five source-scope cases: four assertions observed RED (`/tmp/deploylite-explicit-test-scopes-red.log`), one characterizes active collection. GREEN/refactor `/tmp/deploylite-explicit-test-scopes-refactor.log`,5/5 with zero skipped. Each disabled physical-file invocation now fails rather than returning skipped success; the two existing DB/API gating guards retain both cases and strengthen that failure expectation to match the explicit policy. Initial DB/API scope runs preserved their old expected-skip failure; this adaptation is recorded as guard correction, not retrospective RED. All direct physical entries retain explicit flag preflight before runtime effects. Native scope authorization is unchanged. Agent unit collection480/480 with zero skipped includes preserved untracked S1 readiness/UID WIP14 cases; these14 are not yet delivered. Full root unit check and exact hosted physical partitions remain pending.

Intermediate #400 exactc491dd0 CI38082085026 has7/7 successful jobs,0skipped jobs. P3 physical1/1,11operations,22 exact hashes match head, cleanup verified (`/tmp/deploylite-pr400-p3-c491dd0`). That source still produces skipped cases in the old general unit collection; it does not satisfy the stricter complete-suites rule and is not accepted as final delivery. Historical skipped commits remain historical evidence, never rewritten into PASS.

Rollback is not permission to remove mandatory tests: preserve all case bodies and gates. The collection helper/configs may be replaced only with another execution path that runs all required cases and refuses incomplete evidence. No whole-P5 acceptance or main merge is granted by this preparation.

- Explicit partition full Node24 pnpm check exits0 (`/tmp/deploylite-explicit-test-scopes-check.log`):8 unit projects,2564 passed,0skipped. Includes preserved local S1 WIP14 cases; published scope-only head will contain2550 existing unit cases. Node scope5/5 and Python baseline57/57+P3hosted7/7 pass with0skips. This certifies unit execution only; physical PostgreSQL/Docker partitions on the scope-corrected exact head remain mandatory and pending.

Verified correction reference: #406 `49ff6309fe843e84e3a4ec0589b593949a000efa`, CI38083327173,7/7 PASS; published unit2550/2550, P2 87/87+diagnostic2/2, DB69/69, API13/13, ComposePG15/15, P3 1/1, P4 3/3; all0pending/0failed with exact source hashes and cleanup. Earlier stack heads retain their own cases/counts; every propagated head needs fresh CI and is pending until observed. Historical44 missing-run lookups return0runs; evidence gaps remain unaccepted.

The quality job now produces a JSON report for every configured unit workspace and rejects any skipped, failed, missing, empty or inconsistent execution. Unit-report guard: seven rejection assertions observed RED, one complete-report characterization; GREEN8/8, zero skipped. Every physical partition remains mandatory independently.
