# Platform support policy

DeployLite is **Alpha/early access**. This policy defines the release-baseline boundary; it does not authorize a production deployment or public-ready claim.

## Support matrix

| Component | Version/range owner | Support boundary and compatibility expectation | Update cadence/trigger |
| --- | --- | --- | --- |
| Node.js | `.node-version`, `package.json`, and application Dockerfiles own `24.20.0` / `>=24 <25`. | Only Node 24.20.0 is supported for the current baseline. Local, CI, and both image stages use the declared patch and digest. | Review a Node patch monthly and promptly for an upstream security advisory; treat Node 25 as an explicit major migration. |
| Corepack-managed pnpm | `package.json` owns `pnpm@9.15.4` and `engines.pnpm: 9.15.4`. | Corepack must resolve this exact pnpm release; installs use the committed lockfile with `--frozen-lockfile`. | Review monthly and for pnpm security or lockfile-format advisories; any version change requires intentional regeneration and dependency-diff evidence. |
| Docker Engine | The supported-host record owns the tested Engine range. | Linux hosts with Docker Engine 29.x and API `>=1.40` are the current baseline; installer support remains limited to its documented Ubuntu/Debian and architecture matrix. | Revalidate on every Docker major/minor upgrade, Docker API change, or host OS support change. |
| Docker Compose plugin | The supported-host record owns the tested Compose plugin range. | The Docker Compose v2 plugin must be installed with the supported Docker Engine and render `infra/vps/compose.yml` plus its TLS overlay without mutation. | Revalidate with each Engine update, Compose release, or Compose-file change. |
| Traefik | `infra/vps/compose.yml` owns `traefik:v3.6.7@sha256:a9890c898f379c1905ee5b28342f6b408dc863f08db2dab20e46c267d1ff463a`. | The Compose image is digest-pinned, and the current configuration defines labeled HTTPS routers and ACME settings. Traefik v3.6.7 has observed Docker 29 compatibility only. This is not proof of support, lifecycle, provenance, supply-chain integrity, or upgrade readiness. | Revalidate for each Traefik update, Docker API change, router-label change, or vendor advisory. |
| PostgreSQL | `infra/vps/compose.yml` owns `postgres:16-alpine`; the schema/migrations own database compatibility. | PostgreSQL 16 is the baseline for local fixtures and the bootstrap profile. PostgreSQL 17+ and any storage-format migration are unsupported until separately approved. | Revalidate for PostgreSQL patch releases, extension changes, migration changes, or vendor security advisories. |

## Upgrade controls

Before an upgrade, record the current and proposed versions and image digests, vendor lifecycle source, compatibility matrix, approval, and a release-evidence entry. Run the relevant frozen-install, build, lint/typecheck/test, Compose-render, hosted baseline, scanner, and non-production smoke checks. A failed or missing check blocks the upgrade.

## Rollback policy

Rollback triggers include a failed validation, incompatibility, vendor advisory without an accepted exception, expired exception, or operational regression. Revert only the component pin/configuration and its evidence to the prior reviewed commit or digest; restore the previous compatible Engine/Compose package only through the host's documented package rollback. PostgreSQL rollback requires a separately approved, tested data-compatibility plan—never downgrade a data directory speculatively. Record the trigger, executed steps, result, and reviewer in release evidence.

## Exceptions and expiry

An exception is valid only with an ID, component, owner, rationale, compensating control, reviewer, evidence link, and UTC expiry. Expired, malformed, or unapproved exceptions block release eligibility; renewal requires a fresh review and evidence. Exceptions do not widen the supported range.

## Non-goals

This policy does not implement image provenance or signing, backups, production deployment, VPS smoke, infrastructure mutation, major runtime migrations, or runtime lock changes. Hosted baseline CI, dependency/image scanning, SBOM generation, digest evidence, and hardened runtime images are implemented, but they do not make DeployLite production-ready or public-ready.
