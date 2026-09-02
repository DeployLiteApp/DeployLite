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

## Current boundary

Hosted quality, PostgreSQL integration, Compose/supply-chain, and aggregate baseline gates are implemented. The Compose/supply-chain gate runs filesystem and API/web image Trivy scans, generates CycloneDX SBOMs, records image and Compose digest evidence, and builds hardened small runtime images. The release record still does not prove image provenance or signing, production deployment, infrastructure mutation, Traefik/ACME production routing, or VPS smoke. Aggregate release approval remains pending, so DeployLite is not production-ready.
