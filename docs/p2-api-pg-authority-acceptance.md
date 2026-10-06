# P2 delivery: API physical authority acceptance

API physical authority acceptance. Adopt the complete planned source and matching assertions while preserving immutable execution bindings.

Refs #294; parent #292 remains open until aggregate acceptance.

Fresh focused checks and normal production consumer types are pending for this exact delivery head. Physical cases remain NOT RUN locally; required hosted acceptance stays authoritative.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.

The first hosted run passed 35 database cases and failed three of six API cases because the test administrator had a project grant while redeploy requires a deployment scope. The fixture now supplies the same explicit administrator platform grant as the memory scenarios and reuses that grant for the shared suite administrator; production policy and assertions are unchanged. The corrected head still requires all six API cases and all four protected checks to pass.
