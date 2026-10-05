# P2 delivery: feat(contracts): retain coordinated replacement and stop authority

Extend the existing versioned wire schemas with optional coordinated execution authority, strict replacement image policy and observed stop identity while retaining legacy parsing.

Refs #294; parent #292 remains open until aggregate acceptance.

Adopts complete original source and matching parser assertions. Focused current-source tests and type checks precede ordinary source review; real protected hosted gates are required before merge.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.
