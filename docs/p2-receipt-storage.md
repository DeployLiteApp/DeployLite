# P2 receipt storage foundation

Persist immutable execution receipts and snapshot origin; preserve terminal identity and evidence on lifecycle writes.

Refs #315; parent #292 remains open until aggregate acceptance.

Retained strict-TDD recording SQL and mapper tests cover receipt round-trip, immutable guards, legacy reads and schema migrations; actual PostgreSQL follows in required hosted CI.

This PR includes the receipt schema, repeated-hash index and historical dispatch status alignment. Canonical snapshot reconstruction and its dedicated tests follow in a dependent PR.

Require every exact-head protected gate; rollback is a scoped protected revert, with no production or local runtime operation.
