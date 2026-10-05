# P2 delivery: feat(api): persist initial terminal proof atomically

Persist digest INITIAL terminal outcomes and received physical execution proof through the shared atomic completion port before publishing terminal SSE and API success, preserving legacy proofless success.

Refs #315; parent #292 remains open until aggregate acceptance.

Adopts the original reviewed source and complete strict-TDD terminal API assertions. Current source checks and focused injected recording tests are required before protected publication; physical PostgreSQL/Docker acceptance and aggregate P2 closure remain separate.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.
