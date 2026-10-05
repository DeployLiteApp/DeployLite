# P2 delivery: feat(agent): return observed active container identity

Return inspected active container identity after promotion, retaining strict owner/project/execution/candidate/image/port/network alignment before eligible proof can be consumed.

Refs #315; parent #292 remains open until aggregate acceptance.

Original observed-identity strict-TDD assertions preceded implementation. The existing API recording fixture now supplies container/image inspection output required by this transport; its real assertion failure was reproduced before the fixture adaptation. Source checks and protected hosted gates are required; no real Docker engine is invoked locally.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.
