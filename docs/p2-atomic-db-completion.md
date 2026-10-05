# P2 delivery: feat(db): complete deployment and control outcomes atomically

Complete deployment and command outcomes in the same database transaction with compare-and-set replay.

Refs #315; parent #292 remains open until aggregate acceptance.

Retained adapter and recording database checks; no migration execution or physical database validation is claimed by this unit.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.
