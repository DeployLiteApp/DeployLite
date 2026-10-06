# P2 delivery: test(api): verify promotion races and bounded failure recovery

Exercise complete composed promotion scenarios through recording Docker transport and authenticated API boundaries, retaining explicit authority, cancellation and recovery evidence.

Refs #294; parent #292 remains open until aggregate acceptance.

Adopts the complete original source and matching tests. Source aliases and injected recording/Fastify.inject fixtures provide local checks; no actual database, Docker, listener or migration runs. Current exact-head hosted gates remain required.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.
