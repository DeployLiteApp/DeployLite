#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
receipt_dir="${DEPLOYLITE_P4_RECEIPT_DIR:?Explicit owned receipt directory required}"
mkdir -p "$receipt_dir"
owner="p4-transport-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
registry_name="$owner-registry"
registry_port="$(node -e 'const n=require("node:net").createServer();n.listen(0,"127.0.0.1",()=>{process.stdout.write(String(n.address().port));n.close()})')"
fixture_tag="localhost:$registry_port/deploylite-p4-fixture:$owner"
cleanup() {
  local exit_status=$?
  trap - EXIT
  if docker inspect "$registry_name" >/dev/null 2>&1; then
    local observed_owner
    observed_owner="$(docker inspect --format '{{index .Config.Labels "io.deploylite.owner"}}' "$registry_name")"
    if [[ "$observed_owner" != "$owner" ]]; then exit 1; fi
    docker rm --force "$registry_name" > /dev/null || exit_status=1
  fi
  if docker image inspect "$fixture_tag" >/dev/null 2>&1; then docker image rm "$fixture_tag" >/dev/null || exit_status=1; fi
  printf '{"ownedRegistryRemoved":true,"exitCode":%s}\n' "$exit_status" > "$receipt_dir/cleanup.json"
  exit "$exit_status"
}
trap cleanup EXIT
docker run --detach --name "$registry_name" --label "io.deploylite.owner=$owner" --network host \
  -e "REGISTRY_HTTP_ADDR=127.0.0.1:$registry_port" registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373 > /dev/null
docker build --pull=false --tag "$fixture_tag" scripts/p4-fixture > "$receipt_dir/fixture-build.log" 2>&1
docker push "$fixture_tag" > "$receipt_dir/fixture-push.log" 2>&1
# Select only the digest belonging to this owned registry.
fixture_image="$(docker image inspect --format '{{json .RepoDigests}}' "$fixture_tag" | node -e 'const fs=require("node:fs");const prefix="localhost:"+process.argv[1]+"/deploylite-p4-fixture@sha256:";const matches=JSON.parse(fs.readFileSync(0,"utf8")).filter(value=>value.startsWith(prefix));if(matches.length!==1)throw new Error("Owned registry digest unavailable");process.stdout.write(matches[0]);' "$registry_port")"
DEPLOYLITE_P4_PHYSICAL=1 DEPLOYLITE_P4_FIXTURE_IMAGE="$fixture_image" \
  pnpm --filter @deploylite/agent exec vitest run --allowOnly=false --config vitest.config.ts \
  src/infrastructure/docker/docker-transport-port-executor.physical.test.ts \
  --reporter=default --reporter=json --outputFile="$receipt_dir/transport.json"
node - "$receipt_dir/transport.json" <<'JS'
const fs=require('node:fs'); const report=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(report.numPassedTests!==2 || report.numFailedTests!==0 || report.numPendingTests!==0) throw new Error('Physical acceptance incomplete');
JS
