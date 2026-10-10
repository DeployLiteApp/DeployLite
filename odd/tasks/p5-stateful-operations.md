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
| R1 | Pure retention preview over verified P3 backup receipts, explicit keep-newest count and restore-protected archives | PR #389 merged after explicit user authorization; exact `806c7dd` CI 38058774713 passed 7/7; source 14/14 and full check pass |
| R2 | Durable backup inventory and authorized retention preview with audit/replay and stale-inventory fences | Proof, SQL inventory and authenticated ingestion PRs #390/#391/#392 merged; refreshed exact heads 6404a8f/b3c348f/a172587 each passed 7/7 gates. Ingestion physical PG67/67 includes P5 6/6. Authorized preview #393 remains draft: 8 domain and 13 API cases/full check pass, original exact d00894e CI38066864070 approved; server restore-protection persistence and executable retention remain pending |
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
- Automatic approval review initially rejected the proposed #389 protected-main merge because implementation authorization did not cover that integration. No bypass was attempted. The user subsequently explicitly answered “Sí, integrar esos cuatro PRs de P5”; all four normal integrations now completed in order with refreshed required gates.

- Full Node 24.20.0 `pnpm check` for the R2 proof-preparation source exits 0; receipt `/tmp/deploylite-p5-inventory-check.log`. SQL/API/durable acceptance remains pending.

- R2 SQL unit: immutable scoped `backup_inventory` projection, project/command/audit FKs, unique archive scope/command/audit, database-enforced receipt binding and original audit time. Authenticated cache replay preserves the original audit status/time; a colliding command/archive fails without overwriting. Reader rejects invalid/foreign evidence and refuses truncated inventories above 10,000 records. Unit RED: 9 failures before implementation, then 9 GREEN; `/tmp/deploylite-p5-inventory-store-red.log`. No local PostgreSQL/Docker or migration execution occurred. Five physical PostgreSQL cases passed on the disposable hosted job (DB66/66, original61 retained), including the refreshed main-based source. No retention deletion or destructive restore is authorized by this projection.

- SQL unit full Node 24.20.0 `pnpm check` exits 0 (`/tmp/deploylite-p5-inventory-store-check-fixed.log`). Initial failure preserved in `/tmp/deploylite-p5-inventory-store-check.log`: the added suite changed the missing-URL error wording; correction retained the existing guard and its 2/2 tests pass. Mocked CI evidence guards: 38 PASS. These local checks do not claim physical P5 PostgreSQL execution.

- R2 ingestion source: three prospective assertions failed before implementation, then GREEN with 47 existing backup API cases retained. Configured SQL repositories provide an agent-bound inventory writer; completion/audit precede ingestion, completed receipt replay retries a failed inventory append without another backup, and configured unavailable inventory fails before dispatch. Factory wiring observed RED then GREEN without DB connection. The original ingestion assertion was corrected to inspect the safe audit identity/correlation: the in-memory log projection intentionally omits command metadata. Existing generic redaction already preserves canonical `backup_<32 hex>` IDs; no redaction change is needed or retained. A sixth physical SQL case now exercises the actual shared project-update completion/audit rather than only seeded audit fixtures.
- First #391 hosted PostgreSQL run38064532614 failed the five added fixture cases because a seed parameter was inferred as both UUID and text. Focal fixture correction `ecd700d` uses separate parameters, preserving source/gates and the original failure log `/tmp/deploylite-p5-store-ci-failure.log`; exact corrected hosted run38064887220 subsequently passed; original failure evidence remains preserved.

- Corrected #391 hosted PG run38064887220: DB66/66, including all five P5 cases, zero failure/skip; API12/12 and Compose15/15 retain their existing gates. Restart and zero-fixture cleanup verified. The artifact binds GitHub test merge `52cfa4045cb1e62c0b8a5bdeb3a86fd815a0164e` (parents #390 head `78a13a7` and #391 head `ecd700d`); all 79 source hashes match exact `ecd700d`. Evidence `/tmp/deploylite-p5-store-ecd700d`. This records the initial draft-source physical acceptance; later refreshed-head integration is recorded below. It does not close whole P5.

- Ingestion unit full Node24.20.0 `pnpm check` exits0 (`/tmp/deploylite-p5-ingestion-check-fixed.log`); API focal51/51 and API/DB source typechecks pass. The added physical fixture uses logical archive ID `string`, correcting the initial inferred UUID-only type; original failed check retained. Rollback boundary: remove the optional ingestion hook/writer port, DB factory and their tests; retain existing P3 backups, archives, immutable inventory/audit rows and migration0027. No destructive rollback/drop is implied.

- Authorized retention preview source: strict HTTP contract accepts only volume, destination, positive keep count and optional expected inventory digest. Caller inventories/protections/execute flags are rejected. Existing project.update policy/role/auth run before project/archive reads. Explicit server access requires scoped authenticated inventory and server-owned protection reader, with no empty-protection fallback. Two observed snapshots fence changes to inventory/protection, stable replay preserves the same bound metadata, and a valid server deadline bounds even reads that ignore cancellation. Audit is correlated and secret-safe; final fences withhold success if configured agent/storage changes during audit. Eight domain assertions observed RED→GREEN; ten API assertions observed initial RED, plus two post-audit assertions observed separate RED→GREEN; the foreign-agent guard is additional characterization. Runtime effect is N/A: preview has executionAllowed:false and no archive mutation/retention authority. Rollback removes this endpoint/preparation/contracts/tests while leaving authenticated backup ingestion, stored inventory and P3 backups intact.
- Ingestion draft #392 exact `4b568fd` CI38065527919 approved all applicable gates. DB67/67 includes sixth P5 case using actual completion/audit (P5 6/6),0failure/skip,80 hashes match exact head, restart and cleanup verified. Evidence `/tmp/deploylite-p5-ingestion-4b568fd`; binding test merge51322acb has verified parents ecd700d and 4b568fd. The user explicitly authorized normal integration of #389 → #390 → #391 → #392; all four are merged. The preview remains a separate draft delivery.

- Preview local validation: 8/8 domain and 13/13 API cases, API typecheck, 38 mocked CI evidence guards and full Node 24 `pnpm check` pass. Receipt `/tmp/deploylite-p5-retention-preview-check.log`. Server-owned restore-protection persistence and destructive retention execution remain pending.

## Authorized inventory integration

Normal merges completed in order: #389 `9d37a6f`, #390 `60f69e2`, #391 `56f79c7`, #392 `733f720fe8114d68e032cbf5f97dd5c2d37fe281`. Each dependent branch was retargeted to main and updated through a normal merge, then its exact fresh CI passed7/7 before integration: #390 run38066768116/head6404a8f, #391 run38067307951/headb3c348f, #392 run38067841140/heada172587. No bypass, force push or production/runtime operation occurred. Main integration run:38068350315 at733f720; final outcome is preserved with its exact artifact receipt.

Refreshed #392 evidence `/tmp/deploylite-p5-ingestion-a172587`: DB67/67, P5inventory6/6, API12/12, zero failures/skips,80 source hashes match exact head; restart/cleanup verified. Preview #393 initial source `d00894e` run38066864070 approved all applicable gates; its physical inventory evidence `/tmp/deploylite-p5-preview-d00894e` has86 exact hashes and the same67/67+6/6 cases. #393 remains draft after retargeting to main; its endpoint has no deletion authority and requires explicit trusted protections.

Whole-P5 acceptance remains open: approved engine/catalog scope, managed workload storage/image plans, generated encrypted credentials, database-consistent backups, persistent restore protection, retention execution, confirmed restore/recovery, health/telemetry and integrated phase acceptance are not supplied by these four inventory PRs.
