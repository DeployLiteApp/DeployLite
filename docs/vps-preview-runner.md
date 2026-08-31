# VPS preview runner

`scripts/vps-preview.sh` is an operator-only diagnostic tool. It accepts
`migration-only`, `preview`, and marker-gated `cleanup` modes. The first two
require a clean checkout plus exact
commit and tree IDs, and uses only strict SSH host verification. Passwords
must be supplied through `SSHPASS` (consumed with `sshpass -e`) or an SSH key
agent; credentials are never command arguments, files, or output.

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
credentials.

The runner deliberately rejects canonical projects, ports `80`/`443`, router
and canonical network/volume names, ambiguous existing directories, and
unowned cleanup targets. Tests use local fake commands or local Git remotes;
they never contact a VPS or start Docker infrastructure.
