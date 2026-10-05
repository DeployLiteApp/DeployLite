# P2 delivery: feat(domain): bind execution proof to active observations

Generate trusted proof only from returned active observations aligned with captured canonical snapshot and configured runtime bindings; legacy void observations remain readable.

Refs #315; parent #292 remains open until aggregate acceptance.

Original prospective proof assertions preceded implementation. Current domain proof regression and source checks are required before protected publication; no physical observation is claimed by synthetic transports.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.
