# DeployLite Infrastructure

This directory contains local-development infrastructure and the first reviewable VPS prerequisite contract used by `scripts/bootstrap.sh` and `scripts/install.sh`.

- No production Traefik, ACME, DNS, or certificate mutation is performed here.
- No host source-tree bind mount or host shell command is required by these templates. The Traefik overlay intentionally mounts `/var/run/docker.sock` read-only so Traefik can discover labeled services.
- Future infrastructure changes must stay behind explicit review and real environment configuration.

## Local PostgreSQL

`infra/local/postgres.yml` is the deterministic local PostgreSQL fixture used by the onboarding runbook and opt-in DB integration checks.

## VPS installer contract

The installer installs Docker prerequisites, copies the base Compose file and Traefik overlay to `/opt/deploylite`, refreshes `/opt/deploylite/runtime-handoff.sh` (mode `0755`, root-owned), and validates their merged structure. It does not generate or persist runtime secrets, activate a Compose profile, or start the web, API, database, migrations, or any other container.

- `postgres` uses `postgres:16-alpine` with a durable named volume.
- `migrate` remains a runtime-profile service and is not executed by the installer.
- Traefik is the sole host listener on ports `80` and `443`; API and web have no host ports.
- The Traefik overlay describes HTTPS and persistent ACME state, but the installer does not activate the `bootstrap` or `runtime` profile.
- Traefik is pinned to `v3.6.7`. Its Docker v28.3.3 client uses Docker API `1.51`, so the Docker provider can discover the labeled API and web routers on Docker 29 (API `>=1.40`) instead of failing with the obsolete API `1.24` client error. This is observed Docker 29 compatibility only, not proof of support, lifecycle, provenance, supply-chain integrity, or upgrade readiness; see the [platform support policy](../docs/support-policy.md).
- API CORS and the web API URLs remain Compose runtime configuration; the installer does not resolve or apply them.
- Health checks remain Compose runtime conditions; the installer does not wait for container health.

For local review, render the installer-safe base and Traefik overlay without starting services or enabling the runtime profile:

```bash
docker compose -f infra/vps/compose.yml -f infra/vps/compose.tls.yml config --no-interpolate
```

The installer does not claim a public host, perform DNS or ACME checks, or make the web surface available. P0 prerequisite setup is complete when it exits; runtime setup was not executed. It prints `sudo /opt/deploylite/runtime-handoff.sh --env-file <operator-file>`. The operator file must be a canonical, root-owned regular file with mode exactly `0600` and exactly these five runtime keys: `DEPLOYLITE_PUBLIC_HOST`, `POSTGRES_PASSWORD`, `DATABASE_URL`, `DEPLOYLITE_SECRET_KEY`, and `DEPLOYLITE_ACME_EMAIL`. The handoff never prints secret values.

## VPS installer runbook

Audit a host without installing packages, writing files, generating secrets, contacting a remote service, or activating Docker:

```bash
sudo bash scripts/install.sh --check
```

The check reports the supported OS/architecture, required local commands, Docker/Compose versions, and readiness of ports `80` and `443`. It exits `0` only when every prerequisite passes and `2` when one or more checks fail. `--check` performs probes; it is distinct from `--noop`, which skips preflight and installation entirely.

Bootstrap from an audited immutable GitHub commit SHA on a clean supported VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/CoreFoundryTech/DeployLite/<sha>/scripts/bootstrap.sh | sudo DEPLOYLITE_VERSION=<40-char-sha> bash
```

Skip the default prerequisite confirmation TUI only for automation:

```bash
curl -fsSL https://raw.githubusercontent.com/CoreFoundryTech/DeployLite/<sha>/scripts/bootstrap.sh | sudo DEPLOYLITE_VERSION=<40-char-sha> bash -s -- --non-interactive
```

`DEPLOYLITE_VERSION` must be a 40-character commit SHA. The bootstrapper uses bounded downloads, a private temporary directory, and validates that the extracted tree contains the installer.

Alternatively, run from a reviewed source checkout:

```bash
sudo bash scripts/install.sh
```

The installer supports Ubuntu 20.04/22.04/24.04 and Debian 11/12 on x86_64 or arm64. It requires root or sudo, verifies ports `80` and `443`, installs/verifies Docker Engine and the Compose plugin through `apt`, copies both Compose files, validates the merged files with `config --no-interpolate`, refreshes the handoff entrypoint even when a durable install-directory step is skipped, and prints the runtime command. The web, API, and Postgres are not running when this command completes.

Run the bounded runtime handoff only after saving a validated operator file:

```text
DEPLOYLITE_PUBLIC_HOST=app.example.com
POSTGRES_PASSWORD=<strong-password>
DATABASE_URL=postgres://deploylite:<url-safe-password>@postgres:5432/deploylite
DEPLOYLITE_SECRET_KEY=<at-least-16-printable-characters>
DEPLOYLITE_ACME_EMAIL=invalid@example.invalid
```

Set that file to root ownership and mode `0600`, then run the printed command. The handoff validates both Compose files with `--no-interpolate`, starts the existing `bootstrap` profile in dependency order, waits using Compose readiness, runs the existing migration service, and starts API/web without host ports. It is safe to rerun and never removes volumes or runs `down --volumes` or global prune. Verify DNS, ACME, and HTTPS externally; the printed URL is tentative and does not assert availability.

The env file follows Docker Compose dotenv semantics: blank lines, comments, quoted values, inline comments, `#`, and `=` are supported. The handoff scans only assignment names (without sourcing or evaluating values), snapshots the root-owned `0600` file into a private temporary directory, and asks Compose to normalize the snapshot. The normalized `DEPLOYLITE_ACME_EMAIL` is checked for a bounded practical email shape, valid domain labels, and placeholder/public-host values without displaying it. The original file is never used after the snapshot and the temporary directory is removed on every exit path.

During a normal install, the same six-step progress contract is printed in interactive and noninteractive modes: host preflight, curl, Docker/Compose, install-directory and overlay copy, config validation, and P1 handoff. Each stage first emits a numbered `[current/6] ...: RUNNING` transition, then exactly one numbered terminal status ending in `PASS`, `SKIP`, or `FAIL`. The optional whiptail UI only enhances the prerequisite confirmation prompt. A failed or interrupted run reports the active step and the protected state path. Re-run the installer to resume: only the durable curl, Docker, and install-directory steps are skipped when their state is already complete, while checks and validation run again.

This contract does not configure a custom public domain, ACME identity, firewall, backups, upgrades, uninstall/reset, Dokploy, or a deployment agent/server Docker socket.
