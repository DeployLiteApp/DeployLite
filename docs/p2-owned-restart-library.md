# P2 delivery: owned hosted PostgreSQL restart library

Add an inert importable restart primitive and complete recording-process guards. It validates hosted CI context, the exact owned service identity, server version, bounded restart/readiness and exclusive redacted receipts.

Refs #315; parent #292 remains open until aggregate acceptance.

Fifteen complete original fake-subprocess tests accompany this library. The workflow is unchanged and no CLI entrypoint is enabled; cleanup/evidence verification and full hosted restart activation follow in the next slice. No local Docker or PostgreSQL service is invoked.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.
