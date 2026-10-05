# P2 delivery: Optional observed execution proof wire

Carry a validated optional observed execution receipt while preserving legacy wire compatibility.

Refs #315; parent #292 remains open until aggregate acceptance.

The original parser cohort passed 37 focused cases with source noEmit0; physical runtime observation and API atomic consumption are later independent prerequisites.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.
