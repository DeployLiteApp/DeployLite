# DeployLite project instructions

## Mandatory complete validation — Jerson, 2026-10-10

No test or gate may remain skipped/omitted in evidence used to accept a phase, integrate changes or declare delivery complete. Every required test and gate must execute and PASS. Never count skipped as success, disable tests, reduce suites or change expectations to manufacture approval. If environment/dependencies prevent execution, record and resolve the blocker; do not accept closure. When a control requires a specific event, use that valid execution path and bind its exact source evidence. Partial stacked-PR checks are intermediate observations only, not final acceptance/integration/delivery evidence. This applies to P5, Release baseline gates, P3 Docker acceptance and opt-in physical suites; preserve runtime authorization and repository protections.

The no-skipped rule applies to every old and new PR, including already merged history. Audit exact-head checks; skipped or missing evidence is unaccepted. Record historical gaps and resolve through authorized complete executions; never retroactively claim omitted checks passed.
