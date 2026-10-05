# P2 delivery: feat(domain): persist shared deployment execution authority

Reserve project, immediate-source and execution leases atomically in shared control commands, validate fresh ownership and bind terminal Stop and INITIAL results to the persisted authority.

Refs #294; parent #292 remains open until aggregate acceptance.

Adopts complete original domain and persisted repository source with all recording-session authority assertions; no real database or migration runs locally. Focused current-source checks and exact protected hosted gates precede merge.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.

Unclaimed eligible commands cannot complete in memory or PostgreSQL; three prospective terminal-status regressions reproduce and close the memory mismatch without writes.
