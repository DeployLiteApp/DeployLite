# VPS preview runner

`scripts/vps-preview.sh` is an operator-only diagnostic tool. It accepts
`migration-only` and `preview` modes, requires a clean checkout plus exact
commit and tree IDs, and uses only strict SSH host verification. Passwords
must be supplied through `SSHPASS` (consumed with `sshpass -e`) or an SSH key
agent; credentials are never command arguments, files, or output.

The remote script runs setup, migration capture, evidence readback, and
cleanup as separate phases. Migration output and its exit code are written
with mode `0600` before the result is returned. `migration-only` always
cleans. A full preview starts only isolated loopback services and remains
running only after bounded health verification succeeds.

The runner deliberately rejects canonical projects, ports `80`/`443`, router
and canonical network/volume names, ambiguous existing directories, and
unowned cleanup targets. Tests use local fake commands or local Git remotes;
they never contact a VPS or start Docker infrastructure.
