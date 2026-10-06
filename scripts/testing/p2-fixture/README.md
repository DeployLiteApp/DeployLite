# P2 static HTTP fixture

This source prepares two immutable, public-content fixtures for a separately
approved physical acceptance run. Build target `a` serves
`deploylite-p2-fixture=A\n` at `/version`; target `h` serves
`deploylite-p2-fixture=H\n`. Both serve `ok\n` at `/healthz` on TCP 8080.
A later rollback creates new R from the pinned H image; R is a new runtime
identity, not a third flavor. These files do not implement rollback or prove it.

The pinned official BusyBox 1.37.0 musl OCI index supports native Linux amd64
and arm64/v8. Exact child manifests and public verification sources are in
[base-image.json](base-image.json). The official builder uses `defconfig`;
the hash-verified release source enables `httpd`, `wget` and wget timeouts.
Upstream documents foreground static HTTP and non-root port 8080 usage.
[BusyBox applets](https://busybox.net/downloads/BusyBox.html),
[official builder](https://github.com/docker-library/busybox/blob/4c1756d5e2fd5dc60276cba8c01b366e5eb667ef/latest-1/musl/Dockerfile.builder).

The Dockerfile copies only the three static payloads, without `RUN`, package
installation, a shell entrypoint, secrets, volumes or build-time networking.
Use only this directory as the build context. Its allowlist excludes the
README, provenance, repository and unrelated files. The bundled BuildKit
frontend must support `COPY --chmod` (Dockerfile 1.2 or newer); no external
frontend is requested. UID/GID 65532 reads root-owned mode 0444 content.
Stock `httpd` runs in the foreground at an unprivileged port. The stock wget
health command disables proxies and fetches only loopback, with a 1-second
read timeout and Docker health timeout, 1-second interval, 2-second startup
period and two retries. [Dockerfile reference](https://docs.docker.com/reference/dockerfile/).

This is compatible by source inspection with `--read-only`, `--cap-drop=ALL`,
`--security-opt=no-new-privileges`, and tmpfs mounts outside `/www`; it requires
no writable application directory. Actual hardened execution remains NOT RUN.
The future check must observe Docker's intrinsic healthy state and exact A/H
HTTP bodies. It must also verify file ownership/modes, runtime user and image
platform. The files have no custom behavior requiring fabricated RED/GREEN
claims; source checks are separate from those physical observations.

## Prospective isolated preparation

No Docker operation is authorized by this source. The user must separately
authorize resources and operations; root verifies and executes that scope. The
grant must identify the disposable native Linux engine/socket/ID, owner/run IDs,
expiry, platform and resource budget before build/pull/run/push or removal.
The proposed 2 CPU/2 GiB whole-engine and 512 MiB new fixture/cache ceilings are
not accepted user budgets; reconciliation of limits for owned resources remains
pending. Proposed loopback ports are 49172 for preparation and 49170/49171 for
later physical cases. Do not use protected ports or alter a shared daemon.
Preparation and cases run serially. No QEMU, privileged containers, host bind
mounts or ambient Docker configuration/credentials are needed.

The existing provider is GitHub Actions (`.github/workflows/baseline.yml`,
`ubuntu-24.04`); an owned preparation on that provider or an approved disposable
host is feasible without a new provider or registry account. A default hosted
runner is not assumed to meet the physical harness's engine-information ceiling.
The current private whole-engine gate is a proposal awaiting reconciliation;
root will resolve an owned-resource budget before the final harness. No stock
runner compliance, shared-daemon change or new runtime grant is inferred.
No workflow is changed or triggered here.

After approval, verify source hashes and the native engine/platform, fetch only
the pinned public base, then build targets `a` and `h` serially with networking
for build steps disabled and only this source context. Save build metadata and
image inspections. Tags and Docker image IDs are not acceptance RepoDigests.
Derived A/H digest pins are pending until observed; build timestamps/tool
versions can change them even though the source and response bodies are fixed.

The prepared physical harness requires the exact accepted image reference in
`docker image inspect .RepoDigests`. If build/load alone does not supply it,
the concrete private plan uses one separately approved pinned official registry
on loopback 49172, memory-backed owned storage and no external publication.
Push each built flavor only there, read its exact manifest digest, pull that
exact digest into the same engine and verify RepoDigest/config/platform.
Remove the owned registry and its network before cases; retain the verified
local images and use `--pull=never`. Exact registry pin, caps, commands,
verification and cleanup boundaries are in the private preparation plan passed
to root. No credentials or arbitrary user-provided image are requested.

Run one serial hardened smoke per flavor on loopback 49171, bounded to 15
seconds for healthy startup, then remove its exact recorded container ID.
Publish an acceptance manifest only after both inspections and bodies pass;
otherwise leave derived pins pending. A preloaded fixture from the same source
may skip preparation only when its exact RepoDigest, platform, intrinsic health
configuration and source provenance are already verified. The existing physical
harness currently accepts one image; A/H/R scenarios need root's later harness
sequencing and are not claimed by these sources.

The user authorizes resources/operations. Root owns review, commit and acceptance
manifests, and verifies/executes only that authorized scope.
Rollback of this source unit removes only this new fixture directory. No engine,
image, service, port, credential, runtime proof or P2 acceptance was created.
