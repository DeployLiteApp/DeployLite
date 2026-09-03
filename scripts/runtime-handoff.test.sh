#!/usr/bin/env bash
# shellcheck disable=SC1091,SC2016,SC2034,SC2329
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT_DIR/scripts/runtime-handoff.sh"
PASS=0; FAIL=0
FIXTURE=''
trap '[[ -z "$FIXTURE" ]] || run_as_root rm -rf "$FIXTURE"' EXIT
ok() { printf 'ok - %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'not ok - %s\n' "$1"; FAIL=$((FAIL + 1)); }
run_as_root() { "$@"; }
 fixture_manifest() { local root="$1" base="${2:-$1}" path relative hash mode; for path in "$root"/* "$root"/.[!.]* "$root"/..?*; do [[ -e "$path" || -L "$path" ]] || continue; [[ "$path" != "$base/.deploylite-source" ]] || continue; relative="${path#"$base"/}"; if [[ -d "$path" ]]; then printf 'owner=0:0|type=directory|mode=0755|path=%s|sha256=-\n' "$relative"; else mode=0644; [[ "$path" == *.sh ]] && mode=0755; hash="$(sha256sum "$path" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$path" | awk '{print $1}')"; printf 'owner=0:0|type=file|mode=%s|path=%s|sha256=%s\n' "$mode" "$relative" "$hash"; fi; [[ -d "$path" && ! -L "$path" ]] && fixture_manifest "$path" "$base"; done; }
  fixture_manifest_sha() { if command -v sha256sum >/dev/null 2>&1; then fixture_manifest "$1" | LC_ALL=C sort | LC_ALL=C sha256sum | awk '{print $1}'; else fixture_manifest "$1" | LC_ALL=C sort | LC_ALL=C shasum -a 256 | awk '{print $1}'; fi; }
new_fixture() {
  FIXTURE="$(mktemp -d)"; mkdir -p "$FIXTURE/install" "$FIXTURE/bin" "$FIXTURE/tmp"
  cp "$ROOT_DIR/infra/vps/compose.yml" "$FIXTURE/install/compose.yml"; cp "$ROOT_DIR/infra/vps/compose.tls.yml" "$FIXTURE/install/compose.tls.yml"
  mkdir -p "$FIXTURE/install/.sources/source-version/apps/api" "$FIXTURE/install/.sources/source-version/apps/web" "$FIXTURE/install/.sources/source-version/scripts"
  cp "$ROOT_DIR/apps/api/Dockerfile" "$FIXTURE/install/.sources/source-version/apps/api/Dockerfile"; cp "$ROOT_DIR/apps/web/Dockerfile" "$FIXTURE/install/.sources/source-version/apps/web/Dockerfile"
  cp "$ROOT_DIR/package.json" "$ROOT_DIR/pnpm-lock.yaml" "$ROOT_DIR/.node-version" "$FIXTURE/install/.sources/source-version/"
  cp "$ROOT_DIR/scripts/runtime-handoff.sh" "$FIXTURE/install/.sources/source-version/scripts/runtime-handoff.sh"; chmod 0755 "$FIXTURE/install/.sources/source-version/scripts/runtime-handoff.sh"
  digest="$(fixture_manifest_sha "$FIXTURE/install/.sources/source-version")"
  mv "$FIXTURE/install/.sources/source-version" "$FIXTURE/install/.sources/$digest"; chmod 0700 "$FIXTURE/install/.sources"
  printf 'schema=2\nrepository=CoreFoundryTech/DeployLite\ncommit=fccff176a9cefa4e92ec9ebd23f94d85dc36c431\narchive_sha256=%064d\nmanifest_sha256=%s\n' 0 "$digest" >"$FIXTURE/install/.sources/$digest/.deploylite-source"; chmod 0644 "$FIXTURE/install/.sources/$digest/.deploylite-source"
  ln -s ".sources/$digest" "$FIXTURE/install/source"
  cat >"$FIXTURE/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
 if [[ "${FAKE_SIGNAL:-}" == TERM && "$*" == *'--profile bootstrap up -d'* ]]; then kill -TERM "$PPID"; sleep 1; exit 143; fi
 case "$*" in *'ps -aq '*) if [[ -e "$FAKE_RESOURCE_MARK.after" ]]; then [[ "${FAKE_RESOURCES:-0}" == 1 ]] && printf 'old\nnew\n'; exit "${FAKE_PS_POST_STATUS:-0}"; fi; [[ "${FAKE_BASELINE:-0}" == 1 ]] && printf 'old\n'; exit "${FAKE_PS_INITIAL_STATUS:-0}" ;; *'network ls -q '*) if [[ -e "$FAKE_RESOURCE_MARK.after" ]]; then [[ "${FAKE_RESOURCES:-0}" == 1 ]] && printf 'oldnet\nnewnet\n'; exit "${FAKE_NETWORK_POST_STATUS:-0}"; fi; [[ "${FAKE_BASELINE:-0}" == 1 ]] && printf 'oldnet\n'; exit "${FAKE_NETWORK_INITIAL_STATUS:-0}" ;; *'volume ls -q '*) exit "${FAKE_VOLUME_INITIAL_STATUS:-0}" ;; *' config --environment'*) printf 'DEPLOYLITE_PUBLIC_HOST=app.example.com\nPOSTGRES_PASSWORD=strong#=password\nDATABASE_URL=postgres://deploylite:strong#=password@postgres:5432/deploylite\nDEPLOYLITE_SECRET_KEY=0123456789abcdef\n'; : >"$FAKE_RESOURCE_MARK.after"; printf 'replaced-original\n' >"$FAKE_ORIGINAL"; exit 0 ;; *' config '*) exit "${FAKE_CONFIG_STATUS:-0}" ;; *' run '*|*' run') exit "${FAKE_RUN_STATUS:-0}" ;; *inspect*) [[ "$*" == *' old'* || "$*" == *' oldnet'* ]] && printf 'other\n' || printf 'deploylite\n'; exit 0 ;; *'rm -f'*) [[ -e "$FAKE_ROLLBACK_LOG" ]] || printf '%s\n' "$*" >"$FAKE_ROLLBACK_LOG"; printf 'removed\n' >>"$FAKE_DOCKER_LOG"; exit 0 ;; *'network rm'*) [[ -e "$FAKE_ROLLBACK_LOG" ]] || printf '%s\n' "$*" >"$FAKE_ROLLBACK_LOG"; printf 'removed\n' >>"$FAKE_DOCKER_LOG"; exit 0 ;; *) exit "${FAKE_UP_STATUS:-0}" ;; esac
DOCKER
  chmod +x "$FIXTURE/bin/docker"; : >"$FIXTURE/docker.log"; : >"$FIXTURE/resource.mark"
  cat >"$FIXTURE/env" <<'ENV'
# Compose-compatible syntax

DEPLOYLITE_PUBLIC_HOST="app.example.com" # inline comment
POSTGRES_PASSWORD="strong#=password"
DATABASE_URL="postgres://deploylite:strong#=password@postgres:5432/deploylite"
DEPLOYLITE_SECRET_KEY='0123456789abcdef'
ENV
  chmod 600 "$FIXTURE/env"
}
  invoke() { local canonical; canonical="$(cd -P "$(dirname "$FIXTURE/env")" && pwd -P)/env"; run_as_root env TMPDIR="$FIXTURE/tmp" "PATH=$FIXTURE/bin:$PATH" FAKE_DOCKER_LOG="$FIXTURE/docker.log" FAKE_ROLLBACK_LOG="$FIXTURE/rollback.log" FAKE_ORIGINAL="$FIXTURE/env" FAKE_RESOURCE_MARK="$FIXTURE/resource.mark" FAKE_OWNER="${FAKE_OWNER:-0}" FAKE_RESOURCES="${FAKE_RESOURCES:-0}" FAKE_PS_INITIAL_STATUS="${FAKE_PS_INITIAL_STATUS:-0}" FAKE_NETWORK_INITIAL_STATUS="${FAKE_NETWORK_INITIAL_STATUS:-0}" FAKE_PS_POST_STATUS="${FAKE_PS_POST_STATUS:-0}" FAKE_NETWORK_POST_STATUS="${FAKE_NETWORK_POST_STATUS:-0}" FAKE_UP_STATUS="${FAKE_UP_STATUS:-0}" DEPLOYLITE_INSTALL_DIR="$FIXTURE/install" bash -c 'source "$1"; is_root(){ :; }; stat_value(){ case "$1" in %u) printf "$FAKE_OWNER" ;; %u:%g) printf 0:0 ;; %d:%i*) printf "0:%s" "$3" ;; *) stat -c "%a" "$3" 2>/dev/null || stat -f "%Lp" "$3" ;; esac; }; main --env-file "$2"' _ "$SCRIPT" "$canonical"; }
test_success_order_and_redaction() {
  new_fixture; local output log; output="$(invoke 2>&1)" || return 1; log="$(<"$FIXTURE/docker.log")"
  [[ "$output" == *'https://app.example.com/'* && "$output" != *'strong#=password'* && "$(<"$FIXTURE/env")" == replaced-original ]] || return 1
  [[ "$log" == *'compose --env-file '* && "$log" == *'config --no-interpolate'* ]] || return 1
  [[ "$log" == *'--profile bootstrap up -d --wait'* && "$log" == *'run --rm --no-deps migrate'* ]] || return 1
}
test_rejects_duplicate_and_bad_permissions() {
  new_fixture; printf 'DEPLOYLITE_PUBLIC_HOST=app.example.com\n' >>"$FIXTURE/env"; if invoke >/dev/null 2>&1; then return 1; fi
  new_fixture; run_as_root chmod 640 "$FIXTURE/env"; if invoke >/dev/null 2>&1; then return 1; fi
}
test_rejects_unknown_missing_malformed_crlf_and_symlink() {
  new_fixture; printf 'UNKNOWN=value\n' >>"$FIXTURE/env"; if invoke >/dev/null 2>&1; then return 1; fi
  new_fixture; sed '/^POSTGRES_PASSWORD=/d' "$FIXTURE/env" >"$FIXTURE/no-env"; mv "$FIXTURE/no-env" "$FIXTURE/env"; if invoke >/dev/null 2>&1; then return 1; fi
  new_fixture; printf 'not-an-assignment\n' >>"$FIXTURE/env"; if invoke >/dev/null 2>&1; then return 1; fi
  new_fixture; printf '\r\n' >>"$FIXTURE/env"; if invoke >/dev/null 2>&1; then return 1; fi
  new_fixture; ln -s "$FIXTURE/env" "$FIXTURE/link"; if invoke_path "$FIXTURE/link" >/dev/null 2>&1; then return 1; fi
}
  invoke_path() { run_as_root env TMPDIR="$FIXTURE/tmp" "PATH=$FIXTURE/bin:$PATH" FAKE_DOCKER_LOG="$FIXTURE/docker.log" FAKE_ORIGINAL="$FIXTURE/env" DEPLOYLITE_INSTALL_DIR="$FIXTURE/install" bash -c 'source "$1"; is_root(){ :; }; stat_value(){ case "$1" in %u) printf 0 ;; %u:%g) printf 0:0 ;; %d:%i*) printf "0:%s" "$3" ;; *) stat -c "%a" "$3" 2>/dev/null || stat -f "%Lp" "$3" ;; esac; }; main --env-file "$2"' _ "$SCRIPT" "$1"; }
test_rejects_foreign_owner_and_cleans_snapshot() {
  new_fixture; FAKE_OWNER=501; if invoke >/dev/null 2>&1; then return 1; fi
  new_fixture; FAKE_OWNER=0; invoke >/dev/null 2>&1 || return 1; [[ -z "$(find "$FIXTURE/tmp" -mindepth 1 -print -quit)" ]]
}
test_xtrace_and_docker_errors_are_redacted() {
  new_fixture; local output; output="$(FAKE_RUN_STATUS=37 invoke_xtrace 2>&1)" || :
  [[ "$output" != *'strong#=password'* && "$output" != *'strong#=password@postgres'* && "$output" == *'Compose operation failed'* ]]
}
  invoke_xtrace() { local canonical; canonical="$(cd -P "$(dirname "$FIXTURE/env")" && pwd -P)/env"; env TMPDIR="$FIXTURE/tmp" "PATH=$FIXTURE/bin:$PATH" FAKE_DOCKER_LOG="$FIXTURE/docker.log" FAKE_ORIGINAL="$FIXTURE/env" FAKE_RESOURCE_MARK="$FIXTURE/resource.mark" DEPLOYLITE_INSTALL_DIR="$FIXTURE/install" FAKE_RUN_STATUS="${FAKE_RUN_STATUS:-0}" bash -c 'set -x; source "$1"; is_root(){ :; }; stat_value(){ case "$1" in %u) printf 0 ;; %u:%g) printf 0:0 ;; %d:%i*) printf "0:%s" "$3" ;; *) stat -c "%a" "$3" 2>/dev/null || stat -f "%Lp" "$3" ;; esac; }; main --env-file "$2"' _ "$SCRIPT" "$canonical"; }
test_failure_preserves_resources_and_exit_code() {
  new_fixture; local output status canonical; canonical="$(cd -P "$(dirname "$FIXTURE/env")" && pwd -P)/env"; output="$(run_as_root env PATH="$FIXTURE/bin:$PATH" FAKE_DOCKER_LOG="$FIXTURE/docker.log" FAKE_ORIGINAL="$FIXTURE/env" FAKE_RESOURCE_MARK="$FIXTURE/resource.mark" FAKE_RESOURCES=1 DEPLOYLITE_INSTALL_DIR="$FIXTURE/install" FAKE_RUN_STATUS=23 bash -c 'source "$1"; is_root(){ :; }; stat_value(){ case "$1" in %u) printf 0 ;; %u:%g) printf 0:0 ;; %d:%i) printf "%s" "$3" ;; *) stat -c "%a" "$3" 2>/dev/null || stat -f "%Lp" "$3" ;; esac; }; main --env-file "$2"' _ "$SCRIPT" "$canonical" 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 23 && "$output" == *'no volumes or pre-existing resources were removed'* ]] || return 1
  [[ "$output" != *'strong#=password'* && "$(<"$FIXTURE/docker.log")" == *removed* && "$(<"$FIXTURE/docker.log")" != *' down '* && "$(<"$FIXTURE/docker.log")" != *'compose volume'* ]] || return 1
}
test_initial_ps_error_fails_closed() { new_fixture; if FAKE_PS_INITIAL_STATUS=7 invoke >/dev/null 2>&1; then return 1; fi; [[ "$(<"$FIXTURE/docker.log")" != *'compose '* && ! -s "$FIXTURE/rollback.log" ]]; }
test_initial_network_error_fails_closed() { new_fixture; if FAKE_NETWORK_INITIAL_STATUS=7 invoke >/dev/null 2>&1; then return 1; fi; [[ "$(<"$FIXTURE/docker.log")" != *'compose '* && ! -s "$FIXTURE/rollback.log" ]]; }
test_missing_source_fails_before_docker() { new_fixture; rm -rf -- "$FIXTURE/install/source"; if invoke >/dev/null 2>&1; then return 1; fi; [[ ! -s "$FIXTURE/docker.log" ]]; }
test_rejects_unsafe_versioned_source_layouts() {
  new_fixture; rm -f "$FIXTURE/install/source"; rm -rf -- "$FIXTURE/install/.sources"; ln -s "$FIXTURE/tmp" "$FIXTURE/install/.sources"; if invoke >/dev/null 2>&1; then return 1; fi
  new_fixture; digest="$(basename "$(readlink "$FIXTURE/install/source")")"; ln -s "$digest" "$FIXTURE/install/.sources/chained"; rm -f "$FIXTURE/install/source"; ln -s '.sources/chained' "$FIXTURE/install/source"; if invoke >/dev/null 2>&1; then return 1; fi
  new_fixture; rm -f "$FIXTURE/install/source"; ln -s "$FIXTURE/install/.sources/$digest" "$FIXTURE/install/source"; if invoke >/dev/null 2>&1; then return 1; fi
  new_fixture; rm -f "$FIXTURE/install/source"; ln -s '.sources/../.sources/'"$digest" "$FIXTURE/install/source"; if invoke >/dev/null 2>&1; then return 1; fi
}
test_empty_baseline_removes_only_new_labeled() { new_fixture; local status; FAKE_RESOURCES=1 FAKE_UP_STATUS=23 invoke >/dev/null 2>&1 && status=0 || status=$?; [[ "$status" -eq 23 && "$(<"$FIXTURE/rollback.log")" == *'new'* && "$(<"$FIXTURE/rollback.log")" != *'old'* ]]; }
test_post_failure_discovery_error_preserves_resources() { new_fixture; local status; FAKE_RESOURCES=1 FAKE_UP_STATUS=23 FAKE_PS_POST_STATUS=7 invoke >/dev/null 2>&1 && status=0 || status=$?; [[ "$status" -eq 23 && ! -s "$FIXTURE/rollback.log" ]]; }
test_err_exit_rollback_runs_once_and_preserves_code() { new_fixture; local status count; FAKE_RESOURCES=1 FAKE_UP_STATUS=23 invoke >/dev/null 2>&1 && status=0 || status=$?; count=$(wc -l <"$FIXTURE/rollback.log"); [[ "$status" -eq 23 && "$count" -eq 1 ]]; }
test_success_commits_and_preserves_created_resources() { new_fixture; local output; output="$(FAKE_RESOURCES=1 invoke 2>&1)" || return 1; [[ "$output" == *'runtime handoff transaction committed'* && "$output" == *'Runtime handoff completed'* && ! -e "$FIXTURE/rollback.log" && "$output" != *'failed:'* ]] || return 1; [[ "$(printf '%s\n' "$output" | awk '/runtime handoff transaction committed/{c=NR} /Runtime handoff completed/{print (c < NR); exit}')" == 1 ]]; }
test_preexisting_resources_disable_destructive_rollback() { new_fixture; local output status; output="$(FAKE_BASELINE=1 FAKE_RESOURCES=1 FAKE_UP_STATUS=23 invoke 2>&1)" && status=0 || status=$?; [[ "$status" -eq 23 && "$output" == *'destructive rollback disabled'* && ! -e "$FIXTURE/rollback.log" && "$output" != *'completed'* ]]; }
test_signal_rolls_back_once() { new_fixture; local status count; FAKE_RESOURCES=1 FAKE_SIGNAL=TERM invoke >/dev/null 2>&1 && status=0 || status=$?; count=$(wc -l <"$FIXTURE/rollback.log"); [[ "$status" -eq 143 && "$count" -eq 1 ]]; }
test_root_gate() { [[ "$(id -u)" == 0 ]] || ! env DEPLOYLITE_INSTALL_DIR=/tmp bash "$SCRIPT" --env-file /no/such/file >/dev/null 2>&1; }
test_stat_identity_uses_exact_numeric_tuple() {
  local dir file before after replacement output
  dir="$(mktemp -d)"; file="$dir/secret.env"
  printf 'POSTGRES_PASSWORD=do-not-print\n' >"$file"; chmod 600 "$file"
  before="$(bash -c 'source "$1"; stat_identity_runtime "$2"' _ "$SCRIPT" "$file")" || { rm -rf -- "$dir"; return 1; }
  [[ "$before" =~ ^[0-9]+(:[0-9]+){5}$ ]] || { rm -rf -- "$dir"; return 1; }
  printf 'POSTGRES_PASSWORD=changed-value-with-new-size\n' >"$file"
  after="$(bash -c 'source "$1"; stat_identity_runtime "$2"' _ "$SCRIPT" "$file")" || { rm -rf -- "$dir"; return 1; }
  replacement="$dir/replacement"; printf 'POSTGRES_PASSWORD=changed-value-with-new-size\n' >"$replacement"; chmod 600 "$replacement"
  [[ "$before" != "$after" && "$(bash -c 'source "$1"; stat_identity_runtime "$2"' _ "$SCRIPT" "$replacement")" != "$before" ]] || { rm -rf -- "$dir"; return 1; }
  mkdir "$dir/bin"
  cat >"$dir/bin/stat" <<'STAT'
#!/usr/bin/env bash
if [[ "${1:-}" == -c ]]; then exit 1; fi
printf '1:2:3:4:600:5\n'
STAT
  chmod 755 "$dir/bin/stat"
  [[ "$(PATH="$dir/bin:/usr/bin:/bin" bash -c 'source "$1"; stat_identity_runtime "$2"' _ "$SCRIPT" "$file")" == 1:2:3:4:600:5 ]] || { rm -rf -- "$dir"; return 1; }
  rm -rf -- "$dir"
}
test_stat_identity_rejects_partial_without_secret_leak() {
  local dir file canonical output status
  dir="$(mktemp -d)"; file="$dir/secret.env"; printf 'POSTGRES_PASSWORD=do-not-print\n' >"$file"; chmod 600 "$file"
  canonical="$(cd -P "$dir" && pwd -P)/secret.env"
  mkdir "$dir/bin"
  cat >"$dir/bin/stat" <<'STAT'
#!/usr/bin/env bash
case "${2:-}" in
  *%u*) printf '0\n' ;;
  *%a*) printf '600\n' ;;
  *) printf '1:2:3\n' ;;
esac
STAT
  chmod 755 "$dir/bin/stat"
  output="$(PATH="$dir/bin:/usr/bin:/bin" bash -c 'source "$1"; ENV_FILE="$2"; is_root(){ :; }; snapshot_env_file' _ "$SCRIPT" "$canonical" 2>&1)" && status=0 || status=$?
  rm -rf -- "$dir"
  [[ "$status" -ne 0 && "$output" == *'cannot inspect env-file identity'* && "$output" != *'do-not-print'* ]]
}
test_stat_helpers_use_real_platform_metadata() {
  local dir file expected_owner_group
  dir="$(mktemp -d)"; file="$dir/file"; printf 'metadata\n' >"$file"; chmod 600 "$file"
  expected_owner_group="$(id -u):$(id -g)"
  [[ "$(bash -c 'source "$1"; stat_owner_group "$2"' _ "$SCRIPT" "$file")" == "$expected_owner_group" ]] || { rm -rf -- "$dir"; return 1; }
  [[ "$(bash -c 'source "$1"; stat_device_inode "$2"' _ "$SCRIPT" "$file")" =~ ^[0-9]+:[0-9]+$ ]] || { rm -rf -- "$dir"; return 1; }
  [[ "$(bash -c 'source "$1"; stat_identity_runtime "$2"' _ "$SCRIPT" "$file")" =~ ^[0-9]+(:[0-9]+){5}$ ]] || { rm -rf -- "$dir"; return 1; }
  [[ "$(bash -c 'source "$1"; stat_owner "$2"' _ "$SCRIPT" "$file")" == "$(id -u)" ]] || { rm -rf -- "$dir"; return 1; }
  [[ "$(bash -c 'source "$1"; stat_mode "$2"' _ "$SCRIPT" "$file")" == 600 ]] || { rm -rf -- "$dir"; return 1; }
  rm -rf -- "$dir"
}
test_stat_value_requires_explicit_pattern() {
  if bash -c 'source "$1"; stat_value "%u" "%u" "$2"' _ "$SCRIPT" /etc/passwd >/dev/null 2>&1; then return 1; fi
}
test_ubuntu24_real_metadata_path() {
  local output before after real_path
  [[ "$(id -u)" == 0 ]] || return 0
  [[ -r /etc/os-release ]] || return 0
  # This is a real-metadata integration check on its target platform; other
  # hosts retain the isolated tests above without requiring Ubuntu fixtures.
  . /etc/os-release
  [[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || return 0
  new_fixture
  mv "$FIXTURE/bin/docker" "$FIXTURE/docker.pending"
  real_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  before="$(env PATH="$real_path" bash -c 'source "$1"; stat_identity_runtime "$2"' _ "$SCRIPT" "$FIXTURE/env")" || return 1
  env TMPDIR="$FIXTURE/tmp" PATH="$real_path" DEPLOYLITE_INSTALL_DIR="$FIXTURE/install" bash -c 'source "$1"; is_root(){ :; }; parse_args --env-file "$2"; validate_source; before=$(stat_identity_runtime "$2"); snapshot_env_file; after=$(stat_identity_runtime "$2"); [[ "$before" == "$after" ]]; scan_keys' _ "$SCRIPT" "$(cd -P "$(dirname "$FIXTURE/env")" && pwd -P)/env" >/dev/null 2>&1 || return 1
  after="$(env PATH="$real_path" bash -c 'source "$1"; stat_identity_runtime "$2"' _ "$SCRIPT" "$FIXTURE/env")" || return 1
  [[ "$before" == "$after" ]] || return 1
  mv "$FIXTURE/docker.pending" "$FIXTURE/bin/docker"; chmod 755 "$FIXTURE/bin/docker"
  output="$(env TMPDIR="$FIXTURE/tmp" "PATH=$FIXTURE/bin:$real_path" FAKE_DOCKER_LOG="$FIXTURE/docker.log" FAKE_ROLLBACK_LOG="$FIXTURE/rollback.log" FAKE_ORIGINAL="$FIXTURE/env" FAKE_RESOURCE_MARK="$FIXTURE/resource.mark" DEPLOYLITE_INSTALL_DIR="$FIXTURE/install" bash -c 'source "$1"; is_root(){ :; }; main --env-file "$2"' _ "$SCRIPT" "$(cd -P "$(dirname "$FIXTURE/env")" && pwd -P)/env" 2>&1)" || return 1
  [[ "$output" == *'https://app.example.com/'* && "$output" != *'failed:'* ]]
}
for test in test_success_order_and_redaction test_rejects_duplicate_and_bad_permissions test_rejects_unknown_missing_malformed_crlf_and_symlink test_rejects_foreign_owner_and_cleans_snapshot test_xtrace_and_docker_errors_are_redacted test_failure_preserves_resources_and_exit_code test_initial_ps_error_fails_closed test_initial_network_error_fails_closed test_missing_source_fails_before_docker test_rejects_unsafe_versioned_source_layouts test_empty_baseline_removes_only_new_labeled test_post_failure_discovery_error_preserves_resources test_err_exit_rollback_runs_once_and_preserves_code test_success_commits_and_preserves_created_resources test_preexisting_resources_disable_destructive_rollback test_signal_rolls_back_once test_root_gate test_stat_identity_uses_exact_numeric_tuple test_stat_identity_rejects_partial_without_secret_leak test_stat_helpers_use_real_platform_metadata test_stat_value_requires_explicit_pattern test_ubuntu24_real_metadata_path; do if "$test"; then ok "$test"; else bad "$test"; fi; done
printf '%s passed, %s failed\n' "$PASS" "$FAIL"; [[ "$FAIL" -eq 0 ]]
