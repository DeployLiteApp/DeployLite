# P2 delivery: Corrected rollback route

Adopt the complete rollback route with one bounded canonical replay using the durable terminal time.

Refs #294, #296 and #315; parent #292 remains open. The original F17-api-vertical boundary completes only after route and whole-test deliveries.

The whole private 281-line recorded module (46 cases), exact parser and full strict API source types are required. Source review and its evidence are recorded separately; final physical cases remain NOTRUN.

Quality, actual hosted 49 DB/6 API with 0 failures/0 skips, one owned restart/cleanup 0, supply-chain and baseline gates must pass on the exact head.

P2 remains 7/14; final 57 DB/12 API/13 Docker acceptance is pending. Rollback uses a scoped protected revert.
