# P2 canonical snapshot reconstruction

Reconstruct canonical snapshot evidence with its real hash, bytes and immutable origin; reject malformed or mismatched stored bindings.

Refs #315; parent #292 remains open until aggregate acceptance.

The full dedicated recording-query suite covers canonical data, repeated-hash origin selection, optional legacy fields, image references, corrupt evidence and immutable returned bytes.

Depends on the receipt/schema foundation. Together both PRs retain all eight original reviewed source blobs; no test or code is omitted to meet review budgets.

Require every exact-head protected gate and actual hosted integration; rollback is a scoped protected revert, with no production or local runtime operation.
