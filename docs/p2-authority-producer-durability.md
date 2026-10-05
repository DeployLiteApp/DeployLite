# P2 delivery: durable execution authority

Validate fresh shared execution authority inside durable replay claim and terminal completion transactions, preserving equal replay and atomic outcome/proof/command publication.

Refs #294 and #315; parent #292 remains open until aggregate acceptance.

Complete original recording-session tests accompany the repository changes. Local checks use recording clients; no real database, Docker, listener or migration runs.

The transport context contract is paired with its CLI implementation in the following source boundary; domain execution and signed/API integration remain subsequent.

Exact-head protected quality, PostgreSQL, supply-chain and baseline gates precede merge. A scoped protected revert is the rollback path; final physical acceptance remains pending.
