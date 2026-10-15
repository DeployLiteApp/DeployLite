# P5 disposable restore acceptance scope

Jerson explicitly authorized real restore tests only in temporary disposable CI databases containing synthetic data, and allowed choosing scenarios for all five engines. This authorization does not cover production or existing user databases. No local Docker or database service is used.

## Exact execution boundary

Use `DeployLiteApp/DeployLite`, the exact proposed PR head, a fresh GitHub Actions `ubuntu-24.04` runner, job `p5-native-operator-acceptance`, and its own Docker Unix socket. Admission must bind repository, job, run ID, run attempt, nonce and all source hashes. The control PostgreSQL service must match its owned container ID, labels, dynamic port and pinned `postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777`; never accept a caller database URL or fixed local port.

Engine profiles and immutable image digests are exactly those in `scripts/ci/p5-native-profiles.json` at that head. Each engine receives a fresh random project and agent ID, database identifier `orders`, and newly created owned network, volume and original container. Fresh-resource and readiness inspectors must corroborate original container/image/network/volume creation identity before any operation. Every actual resource ID is recorded by the job, not invented in advance. The private backup destination is `$RUNNER_TEMP/deploylite-p5-native-private-<projectId>`, mode 700, with mode 600 files and a 2 MiB archive ceiling.

## Existing private decode cases

- PostgreSQL: synthetic table `p5_probe`, value `p5-persistent-value`; custom gzip archive decoded into a unique new `p5_restore_<UUID without hyphens>` database, compared with the original, then dropped.
- MySQL and MariaDB: the same synthetic table plus `p5_nontransactional` using MyISAM and value `p5-nontransactional-value`; global-read-lock capture, unique new target database, both rows compared, target dropped and source writers checked.
- MongoDB: synthetic `p5_probe` document `{_id:"probe",value:"p5-persistent-value"}`; known quiescence capture, archive namespace remapped into a unique new `p5_restore_<UUID without hyphens>` database, exact document/count comparison, target dropped and source writers checked.
- Redis: synthetic key `p5_probe=p5-persistent-value`; archive from the corroborated stopped original volume, private staged source, new `/tmp/p5-restore.XXXXXXXX` directory inside the owned container, separate Redis process with TCP port 0 and a private Unix socket. Compare key data and terminate only that process; remove only that directory and owned staging/archive paths.

These five cases retain their original captures, lifecycle, browser, recovery and cleanup assertions. Archive integrity must be verified before decode and after durable inventory reopen/replay. Existing private decode proof does not close destructive product restore.

## Additional product-flow scenarios to implement

For each engine, create the fresh owned fixture and capture the synthetic original value. Change only that fixture to `p5-post-backup-value` after capture; prepare selection from its authenticated immutable inventory and verify its original archive. Prepare a destructive confirmation bound to that source and both hashes. An unconsumed, expired, mismatched or reused nonce must cause no restore dispatch. Only an original valid atomically consumed confirmation may restore the owned fixture to `p5-persistent-value`.

Record before-capture, pre-restore and post-restore values without credentials or archive bytes; require original source/resource and receipt correlation. Simulate a lost successful response, reopen the existing command/cache state and require recovery of the same immutable receipt without a second effect. Preserve unresolved failures and never claim database rollback. Cleanup must corroborate ownership and absence of all job-created resources and temporary restore namespaces/processes. A missing/failed/skipped case blocks acceptance; do not reduce the suite to obtain green CI.

Authenticated API admission, original-cache corroboration, durable protection, atomic confirmation claim, product executor, correlated receipt/audit and these additional scenarios remain pending. Current read-only integrity code and pending intent do not authorize those effects by themselves.
