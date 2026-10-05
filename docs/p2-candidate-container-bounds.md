# P2 delivery: fix(agent): accept bounded execution candidate container names

Accept the actual execution candidate names within the existing trusted 128-character container token bound, preserving shell-free argv and unchanged 63-character noncontainer identifiers.

Refs #315; parent #292 remains open until aggregate acceptance.

Original prospective container-bound assertions preceded the fix; current focused argv regression and source checks are required before publication. This pure argv boundary has no runtime operation.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.
