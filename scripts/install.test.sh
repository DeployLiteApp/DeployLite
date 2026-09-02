#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2030,SC2031
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DEPLOYLITE_INSTALL_TESTING=1
# shellcheck source=scripts/install.sh
. "${ROOT_DIR}/scripts/install.sh"

PASS=0
FAIL=0

assert_contains() {
  local haystack="$1" needle="$2"
  [[ "$haystack" == *"$needle"* ]] || { printf 'expected output to contain %s\nactual: %s\n' "$needle" "$haystack"; return 1; }
}

assert_not_contains() {
  local haystack="$1" needle="$2"
  [[ "$haystack" != *"$needle"* ]] || { printf 'expected output not to contain %s\nactual: %s\n' "$needle" "$haystack"; return 1; }
}

run_test() {
  local name="$1"
  shift
  if "$@"; then
    PASS=$((PASS + 1))
    printf 'ok - %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf 'not ok - %s\n' "$name"
  fi
}

test_redaction_masks_database_url_and_secret_assignments() {
  local output
  output="$(redact 'DATABASE_URL=postgres://deploylite:super-secret@postgres:5432/deploylite POSTGRES_PASSWORD=hunter2 TOKEN_VALUE=abc')"
  assert_contains "$output" 'DATABASE_URL=[REDACTED]' || return 1
  assert_contains "$output" 'POSTGRES_PASSWORD=[REDACTED]' || return 1
  assert_contains "$output" 'TOKEN_VALUE=[REDACTED]' || return 1
  assert_not_contains "$output" 'super-secret' || return 1
  assert_not_contains "$output" 'hunter2' || return 1
}

test_unsupported_host_fails_without_mutation() {
  local tmp output status
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/opt"
  detect_os() { fail 'Unsupported host: expected Ubuntu 20.04/22.04/24.04 or Debian 11/12.' 2; }
  detect_arch() { :; }
  port_available() { :; }
  command_exists() { [[ "$1" == "sudo" || "$1" == "timeout" ]]; }
  output="$(preflight 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 2 ]]
  assert_contains "$output" 'Unsupported host'
  [[ ! -e "$INSTALL_DIR" ]]
  rm -rf "$tmp"
}

test_occupied_port_fails_actionably() {
  local output status
  detect_os() { :; }
  detect_arch() { :; }
  command_exists() { [[ "$1" == "sudo" || "$1" == "timeout" ]]; }
  port_available() { [[ "$1" != "80" ]]; }
  output="$(preflight 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 2 ]]
  assert_contains "$output" 'Port 80 is already in use'
}

test_existing_deploylite_traefik_allows_bootstrap_repair() {
  local output status
  INSTALL_DIR='/opt/deploylite'
  detect_os() { :; }
  detect_arch() { :; }
  command_exists() { [[ "$1" == 'sudo' || "$1" == 'timeout' || "$1" == 'docker' ]]; }
  port_available() { return 1; }
  as_root() {
    case "$*" in
      *'docker ps --quiet'* ) printf 'traefik-container\n' ;;
      *'docker inspect'* ) printf 'deploylite|traefik|/opt/deploylite\n' ;;
      *'docker port traefik-container 80/tcp'* ) printf '0.0.0.0:80\n' ;;
      *'docker port traefik-container 443/tcp'* ) printf '0.0.0.0:443\n' ;;
      *) return 1 ;;
    esac
  }
  output="$(preflight 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 0 ]] || return 1
  assert_contains "$output" 'Running preflight checks.'
}

test_unverified_port_owner_fails_preflight() {
  local output status
  INSTALL_DIR='/opt/deploylite'
  detect_os() { :; }
  detect_arch() { :; }
  command_exists() { [[ "$1" == 'sudo' || "$1" == 'timeout' || "$1" == 'docker' ]]; }
  port_available() { return 1; }
  as_root() {
    case "$*" in
      *'docker ps --quiet'* ) printf 'foreign-container\n' ;;
      *'docker inspect'* ) printf 'other-project|traefik|/opt/other\n' ;;
      *) return 1 ;;
    esac
  }
  output="$(preflight 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 2 ]] || return 1
  assert_contains "$output" "other than this install's DeployLite Traefik container"
}

test_install_docker_uses_docker_apt_repo_when_missing() {
  local calls=() docker_ready=0
  command_exists() {
    case "$1" in
      apt-get|curl|gpg|timeout) return 0 ;;
      docker) [[ "$docker_ready" == "1" ]] ;;
      *) return 1 ;;
    esac
  }
  install_docker_apt_repository() { calls+=("install_docker_apt_repository"); }
  as_root() { calls+=("$*"); [[ "$*" == *apt-get*install* ]] && docker_ready=1; return 0; }
  install_docker
  [[ " ${calls[*]} " == *" install_docker_apt_repository "* ]]
  [[ " ${calls[*]} " == *" apt-get -o DPkg::Lock::Timeout=180 -o Acquire::http::Timeout=180 -o Acquire::https::Timeout=180 update "* ]]
  [[ " ${calls[*]} " == *" apt-get -o DPkg::Lock::Timeout=180 -o Acquire::http::Timeout=180 -o Acquire::https::Timeout=180 install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin "* ]]
}

test_install_curl_is_separate_from_docker_detection() {
  local calls=() curl_ready=0
  command_exists() { [[ "$1" == "apt-get" || "$1" == "timeout" || ("$1" == "curl" && "$curl_ready" == "1") ]]; }
  as_root() { calls+=("$*"); [[ "$*" == *apt-get*install*curl* ]] && curl_ready=1; return 0; }
  install_curl
  [[ " ${calls[*]} " == *" apt-get -o DPkg::Lock::Timeout=180 -o Acquire::http::Timeout=180 -o Acquire::https::Timeout=180 update "* ]] || return 1
  [[ " ${calls[*]} " == *" apt-get -o DPkg::Lock::Timeout=180 -o Acquire::http::Timeout=180 -o Acquire::https::Timeout=180 install -y ca-certificates curl "* ]] || return 1
}

test_prepare_install_dir_copies_tls_overlay() {
  local tmp rendered
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/install"
  COMPOSE_FILE="${INSTALL_DIR}/compose.yml"
  TLS_COMPOSE_FILE="${INSTALL_DIR}/compose.tls.yml"
  STATE_DIR="${INSTALL_DIR}/.state"
  mkdir -p "$INSTALL_DIR"
  as_root() { "$@"; }
  prepare_install_dir >/dev/null
  rendered="$(cat "$COMPOSE_FILE" "$TLS_COMPOSE_FILE")"
  assert_contains "$rendered" 'traefik-acme'
  [[ -f "$TLS_COMPOSE_FILE" ]]
  rm -rf "$tmp"
}

test_installed_compose_uses_source_tree_build_context() {
  local tmp rendered
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/install"
  COMPOSE_FILE="${INSTALL_DIR}/compose.yml"
  TLS_COMPOSE_FILE="${INSTALL_DIR}/compose.tls.yml"
  mkdir -p "$INSTALL_DIR"
  REPO_ROOT="${ROOT_DIR}"
  as_root() { "$@"; }
  install_compose_file
  rendered="$(cat "$COMPOSE_FILE" "$TLS_COMPOSE_FILE")"
  assert_contains "$rendered" "context: ${ROOT_DIR}" || return 1
  assert_not_contains "$rendered" 'context: ../..' || return 1
  assert_contains "$rendered" 'traefik:v3.6.7' || return 1
  assert_contains "$rendered" '--providers.docker=true' || return 1
  assert_contains "$rendered" '/var/run/docker.sock:/var/run/docker.sock:ro' || return 1
  rm -rf "$tmp"
}

test_prompt_value_returns_default_in_noninteractive_mode() {
  local result
  INTERACTIVE=0
  result="$(prompt_value 'label' 'default-value')"
  [[ "$result" == "default-value" ]] || { printf 'expected default-value, got: %s\n' "$result"; return 1; }
}

test_parse_args_supports_explicit_noninteractive_mode() {
  INTERACTIVE=1
  parse_args --non-interactive
  [[ "$INTERACTIVE" == "0" ]]
}

test_prompt_value_returns_piped_value_in_interactive_no_tty_mode() {
  local result
  INTERACTIVE=1
  # No tty (heredoc), so the function falls through to the non-tty
  # stdin branch and reads the next line. The default is still
  # reported as a fallback if the piped line is empty.
  result="$(prompt_value 'label' 'default-value' <<<'piped-value')"
  [[ "$result" == "piped-value" ]] || { printf 'expected piped-value, got: %s\n' "$result"; return 1; }
}

test_prompt_value_returns_default_when_piped_empty_in_interactive_no_tty_mode() {
  local result
  INTERACTIVE=1
  result="$(prompt_value 'label' 'default-value' <<<'')"
  [[ "$result" == "default-value" ]] || { printf 'expected default-value, got: %s\n' "$result"; return 1; }
}

test_redact_stream_removes_postgres_passwords_and_key_value_secrets() {
  local output
  # The stream-level filter applies the same two-pass rewrite as the
  # value-based redact(): the postgres URL pass redacts the password
  # segment, then the KEY=VALUE pass redacts the entire DATABASE_URL
  # value. The end state must have [REDACTED] markers and no raw
  # secrets. The exact replacement shape matches the value-based
  # redact() so a single redaction contract covers both call sites.
  output="$(printf 'DATABASE_URL=postgres://deploylite:top-secret@postgres:5432/deploylite\nPOSTGRES_PASSWORD=hunter2\nTOKEN_VALUE=xyz\nplain line\n' | redact_stream)"
  assert_contains "$output" 'DATABASE_URL=[REDACTED]' || { printf 'missing redacted DB URL: %s\n' "$output"; return 1; }
  assert_contains "$output" 'POSTGRES_PASSWORD=[REDACTED]' || { printf 'missing redacted POSTGRES_PASSWORD: %s\n' "$output"; return 1; }
  assert_contains "$output" 'TOKEN_VALUE=[REDACTED]' || { printf 'missing redacted TOKEN_VALUE: %s\n' "$output"; return 1; }
  assert_not_contains "$output" 'top-secret' || { printf 'raw postgres password leaked: %s\n' "$output"; return 1; }
  assert_not_contains "$output" 'hunter2' || { printf 'raw POSTGRES_PASSWORD leaked: %s\n' "$output"; return 1; }
  assert_contains "$output" 'plain line' || { printf 'plain line lost in stream: %s\n' "$output"; return 1; }
}

test_validate_compose_uses_base_and_tls_overlay_without_profiles() {
  local compose_calls=""
  compose() { compose_calls="$*"; }
  validate_compose >/dev/null
  assert_contains "$compose_calls" 'config' || return 1
  assert_contains "$compose_calls" '--no-interpolate' || return 1
  assert_not_contains "$compose_calls" '--profile' || return 1
}

test_runtime_generation_and_orchestration_are_not_callable() {
  if declare -F prepare_runtime_env >/dev/null; then return 1; fi
  if declare -F generate_secret >/dev/null; then return 1; fi
  if declare -F start_bootstrap >/dev/null; then return 1; fi
  if declare -F verify_local_reachability >/dev/null; then return 1; fi
}

test_main_hands_off_without_secrets_or_runtime_commands() (
  local tmp output calls_file
  tmp="$(mktemp -d)"
  calls_file="$tmp/compose-calls"
  state_test_setup "$tmp"
  release_state_lock
  install_log_setup() { :; }
  preflight() { :; }
  install_curl() { :; }
  install_docker() { :; }
  prepare_install_dir() { :; }
  compose() { printf '%s\n' "$*" >>"$calls_file"; }
  output="$(main --non-interactive)"
  [[ ! -e "$tmp/install/.env" ]] || return 1
  assert_contains "$(<"$calls_file")" 'config --no-interpolate' || return 1
  for forbidden in pull build up down run migrate health; do
    assert_not_contains "$(<"$calls_file")" "$forbidden" || return 1
  done
  assert_contains "$output" 'P0 prerequisite setup complete' || return 1
  assert_contains "$output" 'No runtime secrets were generated or persisted' || return 1
  assert_contains "$output" 'P0 prerequisite setup is complete' || return 1
  assert_contains "$output" 'runtime setup was not executed' || return 1
  assert_contains "$output" 'tracked P1 work #233' || return 1
  rm -rf "$tmp"
)

check_test_platform() {
  local tmp="$1"
  printf 'ID=ubuntu\nVERSION_ID="22.04"\n' >"$tmp"
  DEPLOYLITE_OS_RELEASE_FILE="$tmp"
  uname_machine() { printf 'x86_64\n'; }
}

check_test_commands() {
  command_exists() {
    [[ "$1" == "docker" || "$1" == "timeout" || "$1" == "ss" ]]
  }
  run() {
    printf '%s\n' "$*" >>"$CHECK_TEST_CALL_LOG"
    case "$*" in
      *'docker --version'*) printf 'Docker version 29.0.0\n' ;;
      *'docker compose version'*) printf 'Docker Compose version v2.40.0\n' ;;
      *) return 0 ;;
    esac
  }
  port_available() { return 0; }
}

test_check_mode_succeeds_with_read_only_probes() {
  local tmp output status
  tmp="$(mktemp)"
  CHECK_TEST_CALL_LOG="$(mktemp)"
  check_test_platform "$tmp"
  check_test_commands
  output="$(main --check 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 0 ]] || return 1
  assert_contains "$output" 'Prerequisite check passed' || return 1
  assert_contains "$output" '[PASS] Docker Compose plugin' || return 1
  assert_not_contains "$(<"$CHECK_TEST_CALL_LOG")" 'apt-get' || return 1
  assert_not_contains "$(<"$CHECK_TEST_CALL_LOG")" 'install' || return 1
  assert_not_contains "$(<"$CHECK_TEST_CALL_LOG")" 'compose up' || return 1
  rm -f "$tmp" "$CHECK_TEST_CALL_LOG"
}

test_check_mode_reports_missing_prerequisite_deterministically() {
  local tmp output status
  tmp="$(mktemp)"
  check_test_platform "$tmp"
  command_exists() { [[ "$1" == "timeout" || "$1" == "ss" ]]; }
  run() { return 0; }
  port_available() { return 0; }
  output="$(main --check 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 2 ]] || return 1
  assert_contains "$output" '[FAIL] required command: docker' || return 1
  assert_contains "$output" 'Prerequisite check failed: 2 check(s) failed.' || return 1
  rm -f "$tmp"
}

test_check_mode_reports_unsupported_platform() {
  local tmp output status
  tmp="$(mktemp)"
  printf 'ID=alpine\nVERSION_ID="3.20"\n' >"$tmp"
  DEPLOYLITE_OS_RELEASE_FILE="$tmp"
  uname_machine() { printf 'x86_64\n'; }
  check_test_commands
  output="$(main --check 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 2 ]] || return 1
  assert_contains "$output" '[FAIL] supported OS' || return 1
  rm -f "$tmp"
}

test_check_mode_reports_occupied_port() {
  local tmp output status
  tmp="$(mktemp)"
  check_test_platform "$tmp"
  check_test_commands
  port_available() { [[ "$1" != "80" ]]; }
  output="$(main --check 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 2 ]] || return 1
  assert_contains "$output" '[FAIL] port 80/tcp readiness' || return 1
  rm -f "$tmp"
}

test_check_mode_is_distinct_from_noop() {
  local output status
  output="$(main --check --noop 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 2 ]] || return 1
  assert_contains "$output" '--check cannot be combined with --noop' || return 1
}

state_test_setup() {
  local tmp="$1"
  printf 'ID=ubuntu\nVERSION_ID="22.04"\n' >"${tmp}/os-release"
  DEPLOYLITE_OS_RELEASE_FILE="${tmp}/os-release"
  unset DEPLOYLITE_PUBLIC_HOST
  INSTALL_DIR="${tmp}/install"
  STATE_DIR="${INSTALL_DIR}/.state"
  STATE_FILE="${STATE_DIR}/install-state"
  LOCK_DIR="${STATE_DIR}/install.lock"
  mkdir -p "$INSTALL_DIR"
  command_exists() { command -v "$1" >/dev/null 2>&1; }
  as_root() { "$@"; }
  state_prepare_dir
  acquire_state_lock
  trap release_state_lock EXIT
  state_load
}

test_state_first_run_markers_and_repeat_noop() (
  local tmp attempts=0
  tmp="$(mktemp -d)"
  state_test_setup "$tmp"
  state_step() { attempts=$((attempts + 1)); }
  run_durable_step install-curl state_step
  run_durable_step install-curl state_step
  [[ "$attempts" -eq 1 ]] || return 1
  [[ "${COMPLETED_STEPS[*]}" == "install-curl" ]] || return 1
  [[ "$(awk -F= '$1 == "schema_version" {print $2}' "$STATE_FILE")" == "1" ]] || return 1
  rm -rf "$tmp"
)

test_state_failure_then_resume() (
  local tmp status attempts=0 durable=()
  tmp="$(mktemp -d)"; state_test_setup "$tmp"; release_state_lock; set +e
  install_log_setup() { :; }; preflight() { :; }; install_curl() { durable+=(curl); }
  install_docker() { durable+=(docker); attempts=$((attempts + 1)); [[ "$attempts" -gt 1 ]]; }
  prepare_install_dir() { durable+=(dir); }; validate_compose() { :; }
  main --non-interactive >/dev/null 2>&1; status=$?; [[ "$status" -ne 0 ]] || return 1; release_state_lock
  main --non-interactive >/dev/null 2>&1; status=$?; set -e
  [[ "$status" -eq 0 && "${durable[*]}" == "curl docker docker dir" ]] || return 1; rm -rf "$tmp"
)

test_state_interrupted_step_is_not_marked() (
  local tmp status
  tmp="$(mktemp -d)"
  state_test_setup "$tmp"
  COMPLETED_STEPS=(install-curl)
  state_write
  state_step() { return 143; }
  run_durable_step install-docker state_step >/dev/null 2>&1 && status=0 || status=$?
  [[ "$status" -eq 143 ]] || return 1
  [[ "$(<"$STATE_FILE")" != *install-docker* ]] || return 1
  rm -rf "$tmp"
)

test_state_context_mismatch_resets_completed_steps() (
  local tmp
  tmp="$(mktemp -d)"
  state_test_setup "$tmp"
  state_step() { :; }
  run_durable_step install-curl state_step
  DEPLOYLITE_PUBLIC_HOST="changed.example.test"
  state_load
  [[ "${#COMPLETED_STEPS[@]}" -eq 0 && -e "$STATE_FILE" ]] || return 1
  rm -rf "$tmp"
)

test_state_rejects_malformed_unknown_and_symlink_state() (
  local tmp target invalid sentinel message
  tmp="$(mktemp -d)"; state_test_setup "$tmp"; sentinel="$STATE_DIR/install-state.invalid.sentinel"; printf sentinel >"$sentinel"
  printf 'schema_version=1\nunknown=value\ncompleted_steps=install-curl\n' >"$STATE_FILE"
  for invalid in unknown install-docker install-curl,prepare-install-dir install-curl,install-curl; do
    if [[ "$invalid" == unknown ]]; then printf 'schema_version=1\nunknown=value\ncompleted_steps=install-curl\n' >"$STATE_FILE"; else printf 'schema_version=1\ncontext_fingerprint=%s\ncompleted_steps=%s\n' "$(installer_context_fingerprint)" "$invalid" >"$STATE_FILE"; fi
    chmod 600 "$STATE_FILE"
    state_load || return 1
    [[ "${#COMPLETED_STEPS[@]}" -eq 0 && -e "$STATE_FILE" ]] || return 1
  done
  printf 'schema_version=1\ncontext_fingerprint=bad\ncompleted_steps=install-curl\n' >"$STATE_FILE"
  chmod 600 "$STATE_FILE"
  state_load || return 1
  [[ "${#COMPLETED_STEPS[@]}" -eq 0 && -e "$STATE_FILE" ]] || return 1
  [[ "$(<"$sentinel")" == sentinel ]] || return 1
  printf 'schema_version=1\ncontext_fingerprint=%s\ncompleted_steps=install-curl\n' "$(installer_context_fingerprint)" >"$STATE_FILE"
  chmod 644 "$STATE_FILE"
  state_load >/dev/null 2>&1 && return 1 || :
  [[ -e "$STATE_FILE" ]] || return 1
  chmod 600 "$STATE_FILE"
  target="$tmp/target"
  printf 'schema_version=1\ncontext_fingerprint=%s\ncompleted_steps=install-curl\n' "$(installer_context_fingerprint)" >"$target"
  rm -f "$STATE_FILE"
  ln -s "$target" "$STATE_FILE"
  message="$(state_load 2>&1)" && return 1 || :
  [[ -L "$STATE_FILE" ]] || return 1
  assert_contains "$message" 'Manual recovery' || return 1
  [[ "$(<"$sentinel")" == sentinel ]] || return 1
  rm -rf "$tmp"
)

test_state_fingerprint_dimensions_reset_without_secrets() (
  local tmp dimension baseline arch=x86_64 source_hash=baseline
  tmp="$(mktemp -d)"; state_test_setup "$tmp"; # shellcheck disable=SC2034
  DEPLOYLITE_EXPECTED_PUBLIC_IP=SECRET_SENTINEL
  sha256_file() { printf '%s\n' "$source_hash"; }; uname_machine() { printf '%s\n' "$arch"; }
  for dimension in os arch path input source; do
    STATE_CONTEXT_FINGERPRINT="$(installer_context_fingerprint)"; COMPLETED_STEPS=(install-curl); state_write; baseline="$STATE_CONTEXT_FINGERPRINT"
    case "$dimension" in
      os) printf 'ID=debian\nVERSION_ID="12"\n' >"$tmp/os-release" ;;
      arch) arch=arm64 ;;
      path) mkdir "$tmp/other"; INSTALL_DIR="$tmp/other" ;;
      input) DEPLOYLITE_PUBLIC_HOST=changed.example.test ;;
      source) source_hash=changed ;;
    esac
    [[ "$(installer_context_fingerprint)" != "$baseline" ]] || return 1; state_load; [[ "${#COMPLETED_STEPS[@]}" -eq 0 ]] || return 1
  done
  [[ "$(<"$STATE_FILE")" != *SECRET_SENTINEL* ]] || return 1; rm -rf "$tmp"
)

test_main_flow_replays_only_transient_work() (
  local tmp calls=() durable=() transient=()
  tmp="$(mktemp -d)"; state_test_setup "$tmp"; release_state_lock
  install_log_setup() { :; }; preflight() { transient+=(preflight); }; install_curl() { durable+=(curl); }
  install_docker() { durable+=(docker); }; prepare_install_dir() { durable+=(dir); }
  validate_compose() { transient+=(compose); }
  main --non-interactive; release_state_lock; main --non-interactive
  [[ "${durable[*]}" == "curl docker dir" ]] || return 1
  [[ "${transient[*]}" == "preflight compose preflight compose" ]] || return 1
  rm -rf "$tmp"
)

test_main_flow_blocks_concurrent_run() (
  local tmp first second
  tmp="$(mktemp -d)"; printf 'ID=ubuntu\nVERSION_ID="22.04"\n' >"$tmp/os-release"
  bash -c 'source "$1"; TEST_TMP="$2"; INSTALL_DIR="$TEST_TMP/install"; STATE_DIR="$INSTALL_DIR/.state"; STATE_FILE="$STATE_DIR/install-state"; LOCK_DIR="$STATE_DIR/install.lock"; DEPLOYLITE_OS_RELEASE_FILE="$TEST_TMP/os-release"; as_root(){ "$@"; }; install_log_setup(){ :; }; preflight(){ :; }; install_curl(){ : >"$TEST_TMP/ready"; while [[ ! -e "$TEST_TMP/release" ]]; do sleep 0.01; done; }; install_docker(){ :; }; prepare_install_dir(){ :; }; validate_compose(){ :; }; main --non-interactive' _ "$ROOT_DIR/scripts/install.sh" "$tmp" >/dev/null 2>&1 & first=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do [[ -e "$tmp/ready" ]] && break; sleep 0.01; done; [[ -e "$tmp/ready" ]] || return 1
  set +e; bash -c 'source "$1"; TEST_TMP="$2"; INSTALL_DIR="$TEST_TMP/install"; STATE_DIR="$INSTALL_DIR/.state"; STATE_FILE="$STATE_DIR/install-state"; LOCK_DIR="$STATE_DIR/install.lock"; DEPLOYLITE_OS_RELEASE_FILE="$TEST_TMP/os-release"; as_root(){ "$@"; }; install_log_setup(){ :; }; preflight(){ : >"$TEST_TMP/second-preflight"; }; install_curl(){ :; }; install_docker(){ :; }; prepare_install_dir(){ :; }; validate_compose(){ :; }; main --non-interactive' _ "$ROOT_DIR/scripts/install.sh" "$tmp" >/dev/null 2>&1; second=$?; set -e
  [[ "$second" -ne 0 && ! -e "$tmp/second-preflight" ]] || return 1; : >"$tmp/release"; wait "$first"; [[ ! -e "$tmp/install/.state/install.lock" ]] || return 1; rm -rf "$tmp"
)

test_main_flow_signal_does_not_mark_active_step() {
  local signal="$1" tmp status
  tmp="$(mktemp -d)"; printf 'ID=ubuntu\nVERSION_ID="22.04"\n' >"$tmp/os-release"
  set +e; bash -c 'source "$1"; SIGNAL="$3"; INSTALL_DIR="$2/install"; STATE_DIR="$INSTALL_DIR/.state"; STATE_FILE="$STATE_DIR/install-state"; LOCK_DIR="$STATE_DIR/install.lock"; DEPLOYLITE_OS_RELEASE_FILE="$2/os-release"; mkdir -p "$INSTALL_DIR"; as_root(){ "$@"; }; install_log_setup(){ :; }; preflight(){ :; }; install_curl(){ :; }; install_docker(){ kill -s "$SIGNAL" "$$"; }; prepare_install_dir(){ :; }; validate_compose(){ :; }; main --non-interactive' _ "$ROOT_DIR/scripts/install.sh" "$tmp" "$signal" >/dev/null 2>&1; status=$?; set -e
  [[ "$status" -eq 130 || "$status" -eq 143 ]] || return 1
  [[ "$(<"$tmp/install/.state/install-state")" != *install-docker* && ! -e "$tmp/install/.state/install.lock" ]] || return 1; rm -rf "$tmp"
}

test_main_flow_signal_int() { test_main_flow_signal_does_not_mark_active_step INT; }
test_main_flow_signal_term() { test_main_flow_signal_does_not_mark_active_step TERM; }

test_state_uses_root_model_for_nonroot_operations() (
  local tmp mode sudo_log
  tmp="$(mktemp -d)"; state_test_setup "$tmp"; release_state_lock
  sudo_log="$tmp/sudo.log"; as_root() { printf 'sudo %s\n' "$*" >>"$sudo_log"; "$@"; }; acquire_state_lock; COMPLETED_STEPS=(install-curl); state_write; release_state_lock
  mode="$(stat -f '%Lp' "$STATE_FILE" 2>/dev/null || stat -c '%a' "$STATE_FILE")"
  [[ "$mode" == 600 && "$(<"$sudo_log")" == *'sudo mktemp'* && "$(<"$sudo_log")" == *'sudo sync -f'* && "$(<"$sudo_log")" == *'sudo mv'* ]] || return 1
  rm -rf "$tmp"
)

run_test 'redaction masks secrets' test_redaction_masks_database_url_and_secret_assignments
run_test 'unsupported host fails before mutation' test_unsupported_host_fails_without_mutation
run_test 'occupied port fails actionably' test_occupied_port_fails_actionably
run_test 'existing DeployLite Traefik permits bootstrap repair' test_existing_deploylite_traefik_allows_bootstrap_repair
run_test 'unverified port owner fails preflight' test_unverified_port_owner_fails_preflight
run_test 'missing Docker triggers Docker apt repository install path' test_install_docker_uses_docker_apt_repo_when_missing
run_test 'curl installation is independent of Docker detection' test_install_curl_is_separate_from_docker_detection
run_test 'copies TLS Compose overlay' test_prepare_install_dir_copies_tls_overlay
run_test 'installed compose keeps valid build context' test_installed_compose_uses_source_tree_build_context
run_test 'prompt_value returns default in noninteractive mode' test_prompt_value_returns_default_in_noninteractive_mode
run_test 'explicit noninteractive mode disables TUI' test_parse_args_supports_explicit_noninteractive_mode
run_test 'prompt_value returns piped value in interactive no-tty mode' test_prompt_value_returns_piped_value_in_interactive_no_tty_mode
run_test 'prompt_value returns default when piped empty in interactive no-tty mode' test_prompt_value_returns_default_when_piped_empty_in_interactive_no_tty_mode
run_test 'redact_stream removes postgres passwords and key=value secrets' test_redact_stream_removes_postgres_passwords_and_key_value_secrets
run_test 'validates base and TLS Compose without a runtime profile' test_validate_compose_uses_base_and_tls_overlay_without_profiles
run_test 'retires runtime generation and orchestration functions' test_runtime_generation_and_orchestration_are_not_callable
run_test 'hands off after prerequisites without secrets or runtime commands' test_main_hands_off_without_secrets_or_runtime_commands
run_test 'check mode succeeds using read-only probes' test_check_mode_succeeds_with_read_only_probes
run_test 'check mode reports missing prerequisites deterministically' test_check_mode_reports_missing_prerequisite_deterministically
run_test 'check mode reports unsupported platforms' test_check_mode_reports_unsupported_platform
run_test 'check mode reports occupied ports' test_check_mode_reports_occupied_port
run_test 'check mode remains distinct from noop mode' test_check_mode_is_distinct_from_noop
run_test 'state records first-run markers and repeats durable steps as no-ops' test_state_first_run_markers_and_repeat_noop
run_test 'state resumes after a failed durable step' test_state_failure_then_resume
run_test 'interrupted durable steps are not marked complete' test_state_interrupted_step_is_not_marked
run_test 'context mismatch resets completed state' test_state_context_mismatch_resets_completed_steps
run_test 'state rejects malformed, unknown, and symlink inputs' test_state_rejects_malformed_unknown_and_symlink_state
run_test 'fingerprint dimensions reset state without secrets' test_state_fingerprint_dimensions_reset_without_secrets
run_test 'main flow skips only durable prerequisite side effects' test_main_flow_replays_only_transient_work
run_test 'main flow blocks concurrent runs before side effects' test_main_flow_blocks_concurrent_run
run_test 'INT preserves prior state and does not mark active step' test_main_flow_signal_int
run_test 'TERM preserves prior state and does not mark active step' test_main_flow_signal_term
run_test 'state uses root model for non-root operations' test_state_uses_root_model_for_nonroot_operations

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
