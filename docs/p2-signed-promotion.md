# P2 delivery: feat(agent): authenticate promotion authority and separate recovery budgets

Validate signed replacement authority before replay admission, forward immutable prior runtime and explicit promotion policy, and settle bounded preparation independently from cutover and restoration.

Refs #294; parent #292 remains open until aggregate acceptance.

Complete original receiver and dispatcher promotion tests accompany the source. Current recording/fake regressions and consumer source types precede exact-head protected hosted checks; no real Docker, database, listener or migration runs locally.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.
