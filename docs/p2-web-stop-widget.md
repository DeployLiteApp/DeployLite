# P2 delivery: Preserved Stop attempt and explicit retry widget

Preserved Stop attempt and explicit retry widget. Retain the accepted PR352 client prefix144 and43 regression lines while adopting the original widget and every original matching assertion.

Refs #295 and #294; parent #292 remains open until aggregate acceptance.

Fresh parser, whole-module tests and normal source consumer checks remain pending for this exact public head. Physical acceptance requires observed evidence; mocked cases do not close it.

Required quality, PostgreSQL, supply-chain and baseline checks must pass on the exact published head before protected merge.

Rollback uses a scoped revert through the protected PR flow. No production operation or local runtime authorization is implied.
