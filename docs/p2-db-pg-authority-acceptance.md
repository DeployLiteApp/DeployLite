# P2 delivery: Database physical authority interleavings

Database physical authority interleavings. Adopt the complete planned source and matching assertions while preserving immutable execution bindings.

Refs #294; parent #292 remains open until aggregate acceptance.

The initial hosted head ran49 DB/6 API with one wrapped-error assertion failure. This correction verifies the PostgreSQL cause message and SQLSTATE P0001 while preserving all rollback/replay assertions. Fresh exact-head hosted acceptance is required.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.
