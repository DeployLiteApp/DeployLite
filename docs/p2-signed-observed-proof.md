# P2 delivery: feat(agent): validate configured proof before signed replay publication

Capture configured runtime identity before dispatch and validate observed execution proof before durable replay completion or signed transport return, retaining legacy proofless compatibility.

Refs #315; parent #292 remains open until aggregate acceptance.

Adopts the original reviewed source with its prospective strict-TDD evidence. Focused authenticated-receiver/API regression and current-source TypeScript checks are required before protected publication; these injected recording tests do not constitute physical Docker or PostgreSQL acceptance.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.
