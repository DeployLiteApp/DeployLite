---
meta:
  title: How will DeployLite grow?
  contentType: Conceptual
  category: Community
---

# How will DeployLite grow?

DeployLite is an open-source, community-oriented, self-hosted deployment control plane. This roadmap separates the verified `main` baseline from planned P0 to P8 work, so contributors can evaluate scope without treating a future phase as shipped behavior.

## Page plan

| Topic | Plan |
| --- | --- |
| Goal | Explain the public roadmap and each phase boundary |
| Audience | Contributors, operators, and prospective users |
| Content | Verified baseline, planned phases, and community expectations |
| Open questions | Priorities, maintainers, and phase proposals are decided in public project discussion |

## Start from the verified baseline

The `main` branch provides an HTTP-first VPS installer, first-owner setup, cookie sessions and role-based access control (RBAC), project metadata management, encrypted environment-value foundations with masked handling, control-plane deployment and log metadata, a read-only MCP surface, bounded `runtimePort` handling with tests, and protected hosted baseline gates.

The baseline records CI evidence for quality, PostgreSQL integration, and Compose and supply-chain checks. Those checks include image scanning, software bills of materials (SBOMs), digest evidence, and hardened runtime images. They do not prove image provenance, production deployment, infrastructure mutation, or release approval.

The current runtime path remains non-executing by default. Its `runtimePort` contract bounds and validates a requested port, while the Docker dry-run spawns no process, opens no network connection, reads no secret source, and mutates no infrastructure. Hardened transport foundations exist, but the default runtime capability returns `capability_unavailable`; production activation remains a separate concern.

The following capabilities are not shipped on `main`: privileged host mutation, production routing, VPS smoke, production hardening, provenance or signing, and release approval. Existing Traefik, ACME, and certificate metadata are configuration and data foundations, except for the verified HTTPS and periodic renewal evidence described below; that evidence is not proof of a working production path.

## Build toward the Dokploy-class goal

DeployLite’s product goal is a Dokploy-class self-hosted platform: a one-command, resumable TUI prepares only the supported host runtime and prerequisites; the web UI handles first-owner setup and product configuration; later phases add real applications, networks, volumes, proxy routing, TLS, and infrastructure operations.

The installer must not ask for application configuration. The web UI and shared command boundary own product actions, while operators retain explicit authorization and visible results for infrastructure changes.

## Follow the planned phases

Each phase has an outcome and a short acceptance boundary. A phase is not complete until its boundary is met on a supported environment and the result has evidence.

## Current phase evidence

The current status separates verified slices from full phase completion and release approval:

- **P0 partial**: The prerequisite installer has isolated validation on Ubuntu 24.04 x86_64. Validation on a second supported VPS image remains pending.
- **P1 acceptance boundary evidenced and completed**: The trusted HTTPS slice covers public proxy ingress, HTTP redirect, Let’s Encrypt issuance, persistent ACME state, and the supported-runtime domain smoke. Merged [PR #269](https://github.com/DeployLiteApp/DeployLite/pull/269) also proves natural periodic renewal without restarting, recreating, or killing Traefik. The periodic check is opt-in and is not baseline CI; aggregate release readiness remains pending.
- **P2 first digest-pinned execution slice**: On `main` at [`1a306c6f3d214432c86fb1ea29ebb145c0064644`](https://github.com/DeployLiteApp/DeployLite/commit/1a306c6f3d214432c86fb1ea29ebb145c0064644), [#270](https://github.com/DeployLiteApp/DeployLite/issues/270) and its children [#271](https://github.com/DeployLiteApp/DeployLite/issues/271), [#273](https://github.com/DeployLiteApp/DeployLite/issues/273), [#274](https://github.com/DeployLiteApp/DeployLite/issues/274), and [#276](https://github.com/DeployLiteApp/DeployLite/issues/276) complete immutable snapshots, capability and authenticated transport, the real agent Docker path, real status and log evidence, and durable replay and audit. Full P2 remains incomplete because safe stop, redeploy, and user-facing rollback remain planned and unverified.

| Phase | Planned outcome | Acceptance boundary |
| --- | --- | --- |
| P0 | Ship a one-command, resumable TUI for host prerequisites | Interactive by default; idempotently validates and installs the supported Docker and Compose runtime; records safe preflight results; never asks for app configuration; hands product setup to the web UI |
| P1 | Add Traefik, Let’s Encrypt, and HTTPS access | The proxy owns 80/443; HTTP redirects to HTTPS; ACME issuance and renewal, persistent certificate storage, and a supported-VPS domain smoke test pass |
| P2 | Add real applications and deployment operations | A capability-negotiated agent executes Docker; deployments persist immutable config snapshots, expose real status, stream real logs, and support safe stop, redeploy, and rollback with audit evidence |
| P3 | Make Compose, networks, and volumes first-class resources | Compose is parsed, canonicalized, policy-validated, dry-runable, and secret-safe; ownership, attachment, inspection, backup where applicable, and confirmed cleanup are tested |
| P4 | Add domains, routing, certificates, registries, TCP, and UDP | Routes are scoped and idempotent; ownership conflicts fail closed; changes support preview, apply, and rollback evidence; renewal and HTTP, WebSocket, and domain smoke tests pass |
| P5 | Add stateful workloads and operations | Managed databases and catalog apps have isolated storage, generated credentials, backup and retention policy, destructive restore confirmation, restore evidence, health checks, and secret-safe telemetry |
| P6 | Add CI/CD, webhooks, notifications, scheduling, observability, and health checks | Automation is idempotent, cancellable, and traceable; webhooks are verified; jobs expose delivery status; metrics, logs, health checks, alerts, and optional provider-backed outbound email work |
| P7 | Publish a versioned API and controlled MCP writes | Tokens are scoped and rotatable; webhooks are signed and replay-safe; MCP writes use the web UI’s command, audit, idempotency, authorization, capability, preview, and confirmation path |
| P8 | Add audited AI assistance and release readiness | AI uses allowlisted, redacted context and normal command previews; production execution, rollback, provenance, signing, release approval, and independent evidence gates pass; AI never controls infrastructure autonomously |

## Separate current capability from planned work

The roadmap includes real Git and Dockerfile execution, Docker Compose, Swarm, networks, volumes, backups, managed databases, service-level secrets, routing, certificates, TCP, UDP, catalog applications, registries, CI/CD, webhooks, observability, health checks, functional rollback, and remote build servers. These remain planned unless the verified baseline names them as shipped.

The hosted baseline is a required CI control with retained evidence. The local evidence bridge is advisory only. Neither makes DeployLite production-ready, changes release eligibility, replaces hosted provenance, or activates the default runtime capability.

## Post-release: optional managed mail

Managed inbound mail is outside P0 to P8 and is not a current capability. A future module would need MX hosting, SMTP reception, IMAP or POP, webmail, mailbox storage, spam filtering, antivirus, IP reputation, and mail-server DNS and port operations.

P6 may send transactional email through an optional external SMTP or API provider for alerts, invitations, password recovery, and deployment notifications. DeployLite does not need to run a mail server for that capability.

Any managed-mail module must be isolated from the control plane and run on a dedicated host or explicitly selected infrastructure. It needs separate backup, abuse, reputation, DNS, and lifecycle requirements before implementation.

## Keep planned work honest

DeployLite will not copy third-party code, templates, credentials, private endpoints, or deployment configuration into this project. References may inform a problem statement, but DeployLite defines and tests its own public behavior.

## Contribute within the safety boundary

Read [how to contribute](../CONTRIBUTING.md) before opening work. Read [the security policy](../SECURITY.md) before reporting a vulnerability.

Contributions must keep secrets encrypted at rest, redacted in every read path, and outside AI and MCP context. Infrastructure mutations must use a shared command boundary with authorization, audit evidence, idempotency, capability negotiation, and a visible terminal result. Unsupported or disabled capabilities must fail closed without reaching Docker, host shells, or production infrastructure.
