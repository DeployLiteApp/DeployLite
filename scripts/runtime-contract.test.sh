#!/usr/bin/env bash
set -Eeuo pipefail

readonly EXPECTED_NODE_VERSION="24.20.0"
readonly EXPECTED_PNPM_VERSION="9.15.4"
readonly EXPECTED_LOCK_SHA256="a3f1e60e58e356becb061ee8d527e86de2b8b0efc0e56c941c23b4fad676ea8d"
readonly NODE_IMAGE="node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf"

fail() {
  printf 'runtime contract failed: %s\n' "$*" >&2
  exit 1
}

require_file() {
  [[ -f "$1" ]] || fail "missing required file: $1"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
root_dir="$(git -C "${script_dir}/.." rev-parse --show-toplevel 2>/dev/null)" || fail "script must run from a Git checkout"
expected_script="${root_dir}/scripts/runtime-contract.test.sh"
[[ "${script_dir}/runtime-contract.test.sh" == "${expected_script}" ]] || fail "script must be located at scripts/runtime-contract.test.sh inside the checkout"

cd -- "${root_dir}"

require_file .node-version
require_file package.json
require_file pnpm-lock.yaml
require_file apps/api/Dockerfile
require_file apps/web/Dockerfile

node_version="$(tr -d '[:space:]' <.node-version)"
[[ "${node_version}" == "${EXPECTED_NODE_VERSION}" ]] || fail "expected .node-version ${EXPECTED_NODE_VERSION}, got ${node_version:-empty}"

package_manager="$(node --input-type=module -e 'const pkg = JSON.parse(await (await import("node:fs/promises")).readFile("package.json", "utf8")); process.stdout.write(pkg.packageManager ?? "")')"
[[ "${package_manager}" == "pnpm@${EXPECTED_PNPM_VERSION}" ]] || fail "expected packageManager pnpm@${EXPECTED_PNPM_VERSION}, got ${package_manager:-empty}"

node_engine="$(node --input-type=module -e 'const pkg = JSON.parse(await (await import("node:fs/promises")).readFile("package.json", "utf8")); process.stdout.write(pkg.engines?.node ?? "")')"
pnpm_engine="$(node --input-type=module -e 'const pkg = JSON.parse(await (await import("node:fs/promises")).readFile("package.json", "utf8")); process.stdout.write(pkg.engines?.pnpm ?? "")')"
[[ "${node_engine}" == ">=24 <25" ]] || fail "expected engines.node >=24 <25, got ${node_engine:-empty}"
[[ "${pnpm_engine}" == "${EXPECTED_PNPM_VERSION}" ]] || fail "expected engines.pnpm ${EXPECTED_PNPM_VERSION}, got ${pnpm_engine:-empty}"

grep -Fqx "lockfileVersion: '9.0'" pnpm-lock.yaml || fail "pnpm-lock.yaml must use lockfileVersion 9.0"
lock_sha256="$(shasum -a 256 pnpm-lock.yaml | awk '{print $1}')"
[[ "${lock_sha256}" == "${EXPECTED_LOCK_SHA256}" ]] || fail "lockfile hash mismatch; intentionally regenerate with Node ${EXPECTED_NODE_VERSION} and pnpm ${EXPECTED_PNPM_VERSION}, review the dependency diff, then update EXPECTED_LOCK_SHA256"

for dockerfile in apps/api/Dockerfile apps/web/Dockerfile; do
  grep -Fq "FROM ${NODE_IMAGE} AS build" "${dockerfile}" || fail "${dockerfile} must use the pinned Node build image"
  grep -Fq "FROM ${NODE_IMAGE} AS runtime" "${dockerfile}" || fail "${dockerfile} must use the pinned Node runtime image"
  grep -Fq "RUN corepack enable" "${dockerfile}" || fail "${dockerfile} must enable Corepack"
  grep -Fq "pnpm install --frozen-lockfile" "${dockerfile}" || fail "${dockerfile} must use a frozen pnpm install"
done

printf 'Runtime contract passed: Node %s, pnpm %s, lock %s\n' "${EXPECTED_NODE_VERSION}" "${EXPECTED_PNPM_VERSION}" "${lock_sha256}"
