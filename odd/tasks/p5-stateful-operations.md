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
| R1 | Pure retention preview over verified P3 backup receipts, explicit keep-newest count and restore-protected archives | Source implemented; focused 14/14 and domain typecheck pass; full `pnpm check` passed; exact-source PR CI pending |
| R2 | Durable backup inventory and authorized retention preview with audit/replay and stale-inventory fences | Pending |
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
