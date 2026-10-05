# P2 delivery: feat(api): separate redeploy execution from canonical origin

Retain the canonical snapshot origin and immediate source execution separately when dispatching and persisting redeploy outcomes, with strict signed source identity and receipt bindings.

Refs #315; parent #292 remains open until aggregate acceptance.

Adopts the original reviewed source with complete signed-transport, repository and API lineage regression tests. Current-source checks and protected hosted gates are required before merge; physical P2 acceptance remains pending.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.

The hosted HTTP authentication fixture uses distinct source/execution identities, retaining wrong-key, tamper and stale-lease status assertions.
