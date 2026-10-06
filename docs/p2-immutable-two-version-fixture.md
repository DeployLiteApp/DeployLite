# P2 delivery: test(fixtures): pin isolated healthy and active image versions

Provide distinct immutable active and healthy fixture versions from the existing reviewed BusyBox index, using non-root execution and a bounded local health probe.

Refs #294; parent #292 remains open until aggregate acceptance.

Static source and pin metadata checks only; derived images and runtime are NOT_RUN here. Exact original source and protected hosted checks precede merge. The final CI coordinator alone prepares bounded disposable fixtures.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.
