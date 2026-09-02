#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034,SC2329
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
  mkdir -p "$FIXTURE/install/source/apps/api" "$FIXTURE/install/source/apps/web" "$FIXTURE/install/source/scripts"
  cp "$ROOT_DIR/apps/api/Dockerfile" "$FIXTURE/install/source/apps/api/Dockerfile"; cp "$ROOT_DIR/apps/web/Dockerfile" "$FIXTURE/install/source/apps/web/Dockerfile"
  cp "$ROOT_DIR/package.json" "$ROOT_DIR/pnpm-lock.yaml" "$ROOT_DIR/.node-version" "$FIXTURE/install/source/"
  cp "$ROOT_DIR/scripts/runtime-handoff.sh" "$FIXTURE/install/source/scripts/runtime-handoff.sh"; chmod 0755 "$FIXTURE/install/source/scripts/runtime-handoff.sh"
  digest="$(fixture_manifest_sha "$FIXTURE/install/source")"
  printf 'schema=2\nrepository=CoreFoundryTech/DeployLite\ncommit=fccff176a9cefa4e92ec9ebd23f94d85dc36c431\narchive_sha256=%064d\nmanifest_sha256=%s\n' 0 "$digest" >"$FIXTURE/install/source/.deploylite-source"; chmod 0644 "$FIXTURE/install/source/.deploylite-source"
  cat >"$FIXTURE/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
  case "$*" in *'ps -aq '*) if [[ -e "$FAKE_RESOURCE_MARK.after" ]]; then [[ "${FAKE_RESOURCES:-0}" == 1 ]] && printf 'old\nnew\n'; exit "${FAKE_PS_POST_STATUS:-0}"; fi; exit "${FAKE_PS_INITIAL_STATUS:-0}" ;; *'network ls -q '*) if [[ -e "$FAKE_RESOURCE_MARK.after" ]]; then [[ "${FAKE_RESOURCES:-0}" == 1 ]] && printf 'oldnet\nnewnet\n'; exit "${FAKE_NETWORK_POST_STATUS:-0}"; fi; exit "${FAKE_NETWORK_INITIAL_STATUS:-0}" ;; *'volume ls -q '*) exit "${FAKE_VOLUME_INITIAL_STATUS:-0}" ;; *' config --environment'*) printf 'DEPLOYLITE_PUBLIC_HOST=app.example.com\nPOSTGRES_PASSWORD=strong#=password\nDATABASE_URL=postgres://deploylite:strong#=password@postgres:5432/deploylite\nDEPLOYLITE_SECRET_KEY=0123456789abcdef\n'; : >"$FAKE_RESOURCE_MARK.after"; printf 'replaced-original\n' >"$FAKE_ORIGINAL"; exit 0 ;; *' config '*) exit "${FAKE_CONFIG_STATUS:-0}" ;; *' run '*|*' run') exit "${FAKE_RUN_STATUS:-0}" ;; *inspect*) [[ "$*" == *' old'* || "$*" == *' oldnet'* ]] && printf 'other\n' || printf 'deploylite\n'; exit 0 ;; *'rm -f'*) [[ -e "$FAKE_ROLLBACK_LOG" ]] || printf '%s\n' "$*" >"$FAKE_ROLLBACK_LOG"; printf 'removed\n' >>"$FAKE_DOCKER_LOG"; exit 0 ;; *'network rm'*) [[ -e "$FAKE_ROLLBACK_LOG" ]] || printf '%s\n' "$*" >"$FAKE_ROLLBACK_LOG"; printf 'removed\n' >>"$FAKE_DOCKER_LOG"; exit 0 ;; *) exit "${FAKE_UP_STATUS:-0}" ;; esac
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
test_empty_baseline_removes_only_new_labeled() { new_fixture; local status; FAKE_RESOURCES=1 FAKE_UP_STATUS=23 invoke >/dev/null 2>&1 && status=0 || status=$?; [[ "$status" -eq 23 && "$(<"$FIXTURE/rollback.log")" == *'new'* && "$(<"$FIXTURE/rollback.log")" != *'old'* ]]; }
test_post_failure_discovery_error_preserves_resources() { new_fixture; local status; FAKE_RESOURCES=1 FAKE_UP_STATUS=23 FAKE_PS_POST_STATUS=7 invoke >/dev/null 2>&1 && status=0 || status=$?; [[ "$status" -eq 23 && ! -s "$FIXTURE/rollback.log" ]]; }
test_err_exit_rollback_runs_once_and_preserves_code() { new_fixture; local status count; FAKE_RESOURCES=1 FAKE_UP_STATUS=23 invoke >/dev/null 2>&1 && status=0 || status=$?; count=$(wc -l <"$FIXTURE/rollback.log"); [[ "$status" -eq 23 && "$count" -eq 1 ]]; }
test_root_gate() { [[ "$(id -u)" == 0 ]] || ! env DEPLOYLITE_INSTALL_DIR=/tmp bash "$SCRIPT" --env-file /no/such/file >/dev/null 2>&1; }
for test in test_success_order_and_redaction test_rejects_duplicate_and_bad_permissions test_rejects_unknown_missing_malformed_crlf_and_symlink test_rejects_foreign_owner_and_cleans_snapshot test_xtrace_and_docker_errors_are_redacted test_failure_preserves_resources_and_exit_code test_initial_ps_error_fails_closed test_initial_network_error_fails_closed test_missing_source_fails_before_docker test_empty_baseline_removes_only_new_labeled test_post_failure_discovery_error_preserves_resources test_err_exit_rollback_runs_once_and_preserves_code test_root_gate; do if "$test"; then ok "$test"; else bad "$test"; fi; done
printf '%s passed, %s failed\n' "$PASS" "$FAIL"; [[ "$FAIL" -eq 0 ]]
