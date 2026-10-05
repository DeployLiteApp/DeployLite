# P2 delivery: owned hosted PostgreSQL restart acceptance

Complete the owned restart helper with bounded fixture cleanup, strict JSON evidence verification and fail-closed CLI dispatch, then activate the hosted PostgreSQL restart path with exact service labels and preserved pinned image.

Refs #315; parent #292 remains open until aggregate acceptance.

All 27 complete original fake-subprocess guards accompany the final helper. The hosted workflow requires actual restart identity/version/readiness receipts, database/API case reports and owned fixture cleanup before success. Local validation uses injected fake processes only; final 57/12/13 aggregate P2 acceptance remains pending.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.
