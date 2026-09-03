# Release evidence contract

Use this record for a fixed commit only. A complete record is necessary evidence for later gates, not a declaration that DeployLite is ready for production or public use. DeployLite remains **Alpha/early access** until the aggregate gate and separate release decision pass.

## Required record

Create `release-evidence.json` from `schemas/release-evidence.schema.json`. The record must contain:

| Field | Evidence required |
| --- | --- |
| `commit` | Immutable commit SHA under review. |
| `alphaPosture` | Exactly `alpha-early-access`. |
| `runtime` and `inputs` | Node/pnpm versions, lock hash, Compose digest, and relevant image digests; empty objects are invalid. |
| `images` | At least one image tag, immutable `sha256:` digest, platform, and build identity. |
| `checks` | At least one command, RFC 3339 timestamp, result (`pass`, `fail`, or `exception`), and retained output location. |
| `exceptions` | ID, component, owner, rationale, compensating control, reviewer, evidence link, and unexpired RFC 3339 UTC expiry. An exception check must reference its declared exception ID. |
| `smoke` | Non-empty status and non-production target; record status as `pending` before the staging slice exists. |
| `review` | Non-empty reviewer and approval location for the current slice. |
| `artifacts` | Retained report, SBOM, scan, or command-output locations. |

## Upgrade and rollback evidence

For every supported-component update, include before/after versions and digests, vendor lifecycle source, compatibility result, pre-upgrade checks, approval, validation result, rollback trigger, rollback steps, and rollback result. Missing, malformed, or expired exception evidence, or a failing check, blocks release eligibility.

## P0 installer image evidence

On 2026-09-02, the prerequisite installer at commit `dbdc463157ed6ff80ad24379d1309a4ecdf194c7` passed an isolated validation on Ubuntu 24.04 x86_64. The bootstrap bytes matched the fixed commit, all six stages completed in order, and a second run resumed with the expected skipped durable steps. Compose validation used `config --no-interpolate`; the run generated no runtime secrets, started no application services, and created no Docker containers, networks, volumes, or images. The host was left in the documented prerequisite-only state for P1.

This is partial P0 acceptance evidence, not a complete release record. Validation on a second supported VPS image remains required before P0 can be declared complete. Host, operator, credential, and private infrastructure identifiers are intentionally excluded.

## Trusted public HTTPS validation (2026-09-03)

The 2026-09-03 runtime handoff was validated against the full merge commit `5e7f05fa5353a0628828cb6d8fd490f882be0dc4`. The exact bootstrap and source selfheal completed successfully, followed by the `env0600` step, build, and migration with exit code 0. Traefik, PostgreSQL, API, and web were healthy; API and web remained on private app ports, while Traefik provided public ingress on ports 80 and 443. HTTP redirected to HTTPS, and trusted external HTTPS checks exercised the API, bootstrap, and web routes without `-k` or any other certificate bypass. The trusted certificate issuer was Let's Encrypt, with `deploylite.com` in the SAN, and observed certificate dates of 2026-09-03..2026-12-02.

ACME state persisted across a runtime restart, and a rerun remained idempotent while leaving the runtime healthy. The sanitized evidence contains no secrets or private infrastructure identifiers, and no admin account or administrative access was used or documented.

This validates the trusted public HTTPS runtime slice only. Renewal remains unverified, and validation on a second supported P0 installer image remains pending. This evidence does not declare P0 complete or make DeployLite release-ready.

## Current boundary

Hosted quality, PostgreSQL integration, Compose/supply-chain, and aggregate baseline gates are implemented. The Compose/supply-chain gate runs filesystem and API/web image Trivy scans, generates CycloneDX SBOMs, records image and Compose digest evidence, and builds hardened small runtime images. The release record still does not prove image provenance or signing, production deployment, infrastructure mutation, Traefik/ACME production routing, or VPS smoke. Aggregate release approval remains pending, so DeployLite is not production-ready.

## ACME renewal integration command semantics

After a successful periodic renewal run, the ACME integration harness supports two explicit modes:

- `pnpm test:acme-renewal` defaults to `DEPLOYLITE_ACME_TEST_MODE=startup` and exercises the fast restart-driven renewal path.
- `pnpm test:acme-renewal:periodic` sets `DEPLOYLITE_ACME_TEST_MODE=periodic` and waits up to 100 seconds for Traefik's natural renewal ticker. The periodic path does not restart, recreate, or kill Traefik between the initial and renewed certificates, and requires at least 55 seconds before accepting replacement.

The periodic command is an opt-in integration check and is not part of baseline CI.
