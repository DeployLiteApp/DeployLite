# VPS preview runner

`scripts/vps-preview.sh` is an operator-only diagnostic tool. It accepts
`migration-only`, `preview`, and marker-gated `cleanup` modes. The first two
require a clean checkout plus exact
commit and tree IDs, and uses only strict SSH host verification. Passwords
must be supplied through `SSHPASS` (consumed with `sshpass -e`) or an SSH key
agent; credentials are never command arguments, files, or output. An optional
local-only `VPS_SSH_IDENTITY_FILE` may select one absolute, readable private key
file with no group/other permissions; it adds `-i` and `IdentitiesOnly=yes` and
cannot be combined with `SSHPASS`. With no
custom lifecycle commands, preview creates a mode-600 environment and
deterministic commit-tagged images, explicitly builds `migrate`, `api`, and
`web`, then starts and polls only the isolated project without Traefik. Custom
migration, Compose, and health commands remain supported as an all-or-none
compatibility mode.

The local checkout must be clean at the requested full commit and tree. The
runner derives its `origin` URL (or accepts `VPS_SOURCE_URL`) and only permits
safe HTTPS URLs. The remote phase initializes a shallow Git checkout, fetches
the exact full commit, then verifies both commit and tree before doing any
work. It does not use archive or SCP transfer.

The remote script runs setup, migration capture, evidence readback, and
cleanup as separate phases. Migration output and its exit code are written
with mode `0600` before the result is returned; evidence reads those files
even when migration fails, and cleanup never replaces the primary migration
status. `migration-only` always cleans. `cleanup --id ID` requires the existing
exact ownership marker and performs only isolated resource cleanup; it does not
fetch source, run migrations, collect evidence, or start services. A full
preview starts only isolated loopback services and remains running only after bounded health verification
succeeds. Migration, Compose, and health commands are forwarded as one
shell-quoted value each, preserving spaces and quotes without exposing
credentials. Migration, preview startup, and cleanup execute under the same
preview-specific Compose project; canonical or default project fallback is
forbidden. Native cleanup retries boundedly after a failed `compose down` or
remaining project containers, verifies each container's exact Compose project
label, removes only those containers, retries Compose volume/network cleanup,
and removes only exact commit-tagged image tags parsed from the owned override.
The root is removed only after exact project resource counts reach zero;
unrelated labels and consumers fail closed. Native readiness failures report
only service state, health, exit code, OOM status, and restart count for
PostgreSQL, API, and web, plus bounded attempts and elapsed time.

For `preview`, `VPS_LOOPBACK_PORTS` optionally overrides the three comma-separated
host mappings in this order: `PostgreSQL,web,API` (for example,
`127.0.0.1:15432,127.0.0.1:18080,127.0.0.1:18443`). Each mapping must use
`127.0.0.1` and a unique decimal port from `1024` through `65535`; ports `80`
and `443` are not allowed. If unset, the default is
`127.0.0.1:55433,127.0.0.1:58080,127.0.0.1:58443`. The local runner validates
the value before SSH and the remote runner validates it again without
normalizing or reordering valid bytes.

The runner deliberately rejects canonical projects, ports `80`/`443`, router
and canonical network/volume names, ambiguous existing directories, and
unowned cleanup targets. Tests use local fake commands or local Git remotes;
they never contact a VPS or start Docker infrastructure.
