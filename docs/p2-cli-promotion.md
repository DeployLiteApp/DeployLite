# P2 delivery: bounded CLI promotion

Pair the complete concrete CLI adapter with its original exported context types and cancellation helper, preserving compatibility with existing executor call forms.

Refs #294 and #315; parent #292 remains open until aggregate acceptance.

Recording-runner tests cover authority checks, ownership, candidate inspection, bounded handoff and restoration. No real Docker, database, listener or migration runs locally.

The executor interface and context forwarding arrive in the following source boundary, after this compatible concrete implementation.

Exact-head protected quality, PostgreSQL, supply-chain and baseline gates precede merge. A scoped protected revert is the rollback path; final physical acceptance remains pending.
