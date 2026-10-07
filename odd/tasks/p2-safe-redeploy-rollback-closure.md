# P2 Safe Redeploy and Rollback Closure

Repository locator: odd/tasks/p2-safe-redeploy-rollback-closure.md.
Canonical official mirror: project deploylite, topic odd/p2-safe-redeploy-rollback-closure/tasks, observation 25489.
The preceding FULL history is retained in historical observation 25585 (project deploylite; private locator) and a private copy. Full native readback verified all 49,865 bytes before canonical cutover.

## Final acceptance

Accepted physical P2 source: 8dd1c943b14daab5b7ab3d94a77b0c4049f65a2f; Actions run 37684250303, attempt 1; accepted 2026-10-07T20:58:56Z.
All physical evidence below was independently verified before the protected source merge. Criterion 7.1 additionally requires protected documentary merge, local cutover and FULL canonical readback before the final 14/14 status becomes authoritative.
Source integration, mocked tests, physical execution and release approval remain distinct.

| Evidence | Accepted result | Exact receipt |
| --- | --- | --- |
| Hosted PostgreSQL | 57 DB + 12 API; zero failures/skips | [run](https://github.com/DeployLiteApp/DeployLite/actions/runs/37684250303); [11510542574](https://github.com/DeployLiteApp/DeployLite/actions/runs/37684250303/artifacts/11510542574); ZIP SHA256 `1ced9bc4db4a31707fa24a08e902adb779037203908ff8b16e20685b8e594b12` |
| Restart / cleanup | One owned PG restart; cleanup exit0 | [11510542574](https://github.com/DeployLiteApp/DeployLite/actions/runs/37684250303/artifacts/11510542574); ZIP SHA256 `1ced9bc4db4a31707fa24a08e902adb779037203908ff8b16e20685b8e594b12`; `restart.json`, `cleanup.json` and `binding.json` verified against the current source, exact job/attempt and actual job completion time |
| Docker | 74 mocked guards + 13 real physical cases; zero failures/skips | [11510875603](https://github.com/DeployLiteApp/DeployLite/actions/runs/37684250303/artifacts/11510875603); ZIP SHA256 `79fd896ea023c557e74ec3c6ac5578a0e1cf60af9cce0724ec11d0a0fd8155e4` |
| Runtime truth | INITIAL/redeploy/Stop/A/H/R, observed active identity and current image digests | [11510875603](https://github.com/DeployLiteApp/DeployLite/actions/runs/37684250303/artifacts/11510875603); ZIP SHA256 `79fd896ea023c557e74ec3c6ac5578a0e1cf60af9cce0724ec11d0a0fd8155e4`; `verified.json` binds 59 source hashes, checkout tree, job/engine, all 13 case receipts and actual image digests |
| Outage / recovery | Observed outage <=30,000 ms; recovery <=60,000 ms | [11510875603](https://github.com/DeployLiteApp/DeployLite/actions/runs/37684250303/artifacts/11510875603); ZIP SHA256 `79fd896ea023c557e74ec3c6ac5578a0e1cf60af9cce0724ec11d0a0fd8155e4`; maximum observed upper bounds rounded upward: outage 15,734 ms; recovery 5,562 ms; policy unchanged |
| Protected gates | All final required checks pass on exact source/run/attempt | [PR #379](https://github.com/DeployLiteApp/DeployLite/pull/379); [all five checks](https://github.com/DeployLiteApp/DeployLite/actions/runs/37684250303) passed on the accepted head before protected merge `c8425c82849ea37124502ff5bd3280b784510208` |
| Authorization | Concrete hosted runtime publication grant retained | [11510875603](https://github.com/DeployLiteApp/DeployLite/actions/runs/37684250303/artifacts/11510875603); ZIP SHA256 `79fd896ea023c557e74ec3c6ac5578a0e1cf60af9cce0724ec11d0a0fd8155e4`; exact `job-grant.json` SHA256 `0285cc3f82dd3806d8a6f199f60b3c50510c4316763db51e290914c7a9433396`; private retained original authorization SHA256 `5af5cab10598a2947cd8ac6491a0c13eb66cf2c6bd31b8a969fd7fa947e62ea6`, explicit bridge/egress supplement SHA256 `90030ccd5e87ed5f6a6cfafc45caf6e526661589bb98a53a54b90fb0a943b467` |

## Stable criteria

This fixed 14-entry checklist includes its existing aggregates; aggregates add no independent physical evidence.
Historical 5/14 and later 7/14 remain in the retained FULL history. After actual final acceptance, criteria are 14/14 (100%).

| Criterion | Accepted evidence |
| --- | --- |
| 1.1 WIP/stash custody | Root custody verified: 429 protected paths, nine final-source paths, 12 stash OIDs and the empty index retained; only the two documented local paths change at final cutover. Whole prior documents are privately archived. |
| 1.2 Trusted receipt schema | [PR #317](https://github.com/DeployLiteApp/DeployLite/pull/317) / [#319](https://github.com/DeployLiteApp/DeployLite/pull/319) foundations; strict current trusted handoff verified by [PR #379](https://github.com/DeployLiteApp/DeployLite/pull/379) and DB/API acceptance. |
| 1.3 Immutable memory proof/outcome | Immutable proof/outcome and source normalization preserved in current [PR #379](https://github.com/DeployLiteApp/DeployLite/pull/379); exact DB/API titles and source hashes verified. |
| 2.1a Atomic primitive | Storage-neutral atomic completion in the accepted source; observed DB/API terminal and denial cases, [PR #379](https://github.com/DeployLiteApp/DeployLite/pull/379). |
| 2.1b-memory Corrective adapter | [PR #320](https://github.com/DeployLiteApp/DeployLite/pull/320) corrective shared-memory source and prospective RED/GREEN retained; current source integrated in [PR #379](https://github.com/DeployLiteApp/DeployLite/pull/379). |
| 2.1b-postgres Mandatory hosted acceptance | [11510542574](https://github.com/DeployLiteApp/DeployLite/actions/runs/37684250303/artifacts/11510542574); ZIP SHA256 `1ced9bc4db4a31707fa24a08e902adb779037203908ff8b16e20685b8e594b12`; DB 57 / API 12, zero failures/skips, exactly one owned server restart and zero fixture databases. |
| 2.1b Adapter parity | Memory/PostgreSQL parity accepted only with current atomic terminal/replay cases and all five exact-head gates, [PR #379](https://github.com/DeployLiteApp/DeployLite/pull/379). |
| 2.1c Genuine proof / atomic terminals / lineage | Genuine INITIAL/redeploy proof, atomic terminal success and repeated lineage observed in DB/API and 13 real Docker cases, [PR #379](https://github.com/DeployLiteApp/DeployLite/pull/379). |
| 2.1 U2 aggregate | Non-additive aggregate of the evidenced 2.1 subunits; no extra tests or completion credit, [PR #379](https://github.com/DeployLiteApp/DeployLite/pull/379). |
| 3.1 Promotion / recovery / execute-stop authority | Safe health-gated promotion, independent recovery and fresh execute/Stop authority; 74 guards and 13 physical cases, [PR #379](https://github.com/DeployLiteApp/DeployLite/pull/379); policy 30,000/60,000 ms. |
| 4.1 Accessible redeploy / Stop | Merged redeploy/Stop controls (#350/#351/#352/#353), strict correlated envelopes and immutable lineage. Current fixture preservation: 36 desktop/mobile states, keyboard/focus 6/6 and pending-lock 6/6; private visual receipt SHA256 `d23b8465b44abdf195d414c677deb5c5d4274c84176af6de2aac7fd835e8605e`. No live UI or spoken assistive output claim. |
| 5.1 Independent A/H/R rollback | A/H/R source (#367/#368/#369) and current real physical acceptance in [PR #379](https://github.com/DeployLiteApp/DeployLite/pull/379); distinct R, immutable H lineage and independent original-A recovery. |
| 6.1 Accessible rollback | [PR #375](https://github.com/DeployLiteApp/DeployLite/pull/375) rollback controls; current 1440/390 fixture, keyboard/focus, named accessible roles and correlated server-evidence rendering preserve the accepted composition. Literal Penpot pixel identity and Inter font rendering were not certified. |
| 7.1 Ordered final evidence / documentary closure | Protected source merge and all six ordered issue closures verified. This documentary criterion becomes authoritative after this record is merged through protected main, the two local document paths are cut over, and canonical 25489 receives byte-equal FULL native readback with immutable merged-document custody. Historical 25585 is already FULL verified; the final private receipt records the actual documentation PR/main and canonical hash. |

## Ordered issue closure

[#315](https://github.com/DeployLiteApp/DeployLite/issues/315) -> [#294](https://github.com/DeployLiteApp/DeployLite/issues/294) -> [#295](https://github.com/DeployLiteApp/DeployLite/issues/295) -> [#296](https://github.com/DeployLiteApp/DeployLite/issues/296) -> [#297](https://github.com/DeployLiteApp/DeployLite/issues/297) -> [#292](https://github.com/DeployLiteApp/DeployLite/issues/292).
Retain each actual issue state/UTC/evidence before its dependent aggregate closes: [#315 closure](https://github.com/DeployLiteApp/DeployLite/issues/315#issuecomment-6046774839) CLOSED at 2026-10-07T21:01:31Z; [#294 closure](https://github.com/DeployLiteApp/DeployLite/issues/294#issuecomment-6046776365) CLOSED at 2026-10-07T21:01:36Z; [#295 closure](https://github.com/DeployLiteApp/DeployLite/issues/295#issuecomment-6046778039) CLOSED at 2026-10-07T21:01:43Z; [#296 closure](https://github.com/DeployLiteApp/DeployLite/issues/296#issuecomment-6046779856) CLOSED at 2026-10-07T21:01:50Z; [#297 closure](https://github.com/DeployLiteApp/DeployLite/issues/297#issuecomment-6046781783) CLOSED at 2026-10-07T21:01:57Z; [#292 closure](https://github.com/DeployLiteApp/DeployLite/issues/292#issuecomment-6046783882) CLOSED at 2026-10-07T21:02:06Z.

## Historical custody

The preceding FULL tracker is 49,789 UTF-8 bytes/280 lines, SHA256 8b77fa39b2e6a59ca4740f8b250752b0b4a460524525bed9a8e35e30c63fcff2.
Pre-cutover canonical body: 49,865 bytes, SHA256 262e0bf2fa5d594a51d557958c2d3a82c9b6d08c8c4e16a0303daa3547392376; FULL history retained before updating canonical 25489.
Root retains the whole prior tracker and official response. No earlier failure/RED/skip/source result or runtime boundary is dropped from that history.
The old tracker was absent from public main: no public historical permalink is claimed. Private archives and official Engram history are identified as such.

## Scope and remaining work

P2 covers the reviewed digest-image operations lane; it does not approve production, release readiness or P3-P8.
P0 stays partial; P1's documented boundary stays complete; see [the roadmap](../../docs/community-roadmap.md).
P0's second supported image and separate release approval remain pending. This record starts no P3 work.
ODD remains active, TDD applies to new behavior and RDD stays off. Documentary closure creates no behavioral RED or runtime grant.
