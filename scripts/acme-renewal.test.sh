#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/deploylite-acme.XXXXXX")"
RANDOM_SUFFIX="${TEST_DIR##*.}"
RANDOM_SUFFIX="${RANDOM_SUFFIX//[^[:alnum:]]/}"
RANDOM_SUFFIX="$(printf '%s' "$RANDOM_SUFFIX" | tr '[:upper:]' '[:lower:]')"
PROJECT="deploylite-acme-${RANDOM_SUFFIX}"
TRAEFIK_TLS_PORT="${TRAEFIK_TLS_PORT:-54443}"
PEBBLE_API_PORT="${PEBBLE_API_PORT:-51400}"
PEBBLE_MGMT_PORT="${PEBBLE_MGMT_PORT:-51500}"
FAIL_AT="${DEPLOYLITE_ACME_TEST_FAIL_AT:-}"
ACTIVE_PID=""
CLEANUP_ATTEMPTED=0

production_containers_before=""
production_volumes_before=""

terminate_process_tree() {
  local pid="$1"
  if command -v pkill >/dev/null 2>&1; then pkill -TERM -P "$pid" 2>/dev/null || true; fi
  kill -TERM "$pid" 2>/dev/null || true
  sleep 1
  if command -v pkill >/dev/null 2>&1; then pkill -KILL -P "$pid" 2>/dev/null || true; fi
  kill -KILL "$pid" 2>/dev/null || true
}

watchdog() {
  local child_pid="$1"
  local seconds="$2"
  local sleeper_pid=""
  local grace_pid=""
  # These callbacks are invoked indirectly by the TERM/INT/EXIT trap.
  # shellcheck disable=SC2329 # callback is invoked indirectly by trap.
  stop_sleeper() {
    # shellcheck disable=SC2317
    if [[ -n "$sleeper_pid" ]]; then kill "$sleeper_pid" 2>/dev/null || true; wait "$sleeper_pid" 2>/dev/null || true; fi
    # shellcheck disable=SC2317
    if [[ -n "$grace_pid" ]]; then kill "$grace_pid" 2>/dev/null || true; wait "$grace_pid" 2>/dev/null || true; fi
  }
  trap stop_sleeper TERM INT EXIT
  sleep "$seconds" & sleeper_pid=$!
  wait "$sleeper_pid" 2>/dev/null || exit 0
  terminate_process_tree "$child_pid"
  sleep 1 & grace_pid=$!
  wait "$grace_pid" 2>/dev/null || exit 0
  kill -KILL "$child_pid" 2>/dev/null || true
}

run_bounded() {
  local seconds="$1"
  shift
  local child_pid timer_pid result

  "$@" &
  child_pid=$!
  ACTIVE_PID="$child_pid"
  watchdog "$child_pid" "$seconds" </dev/null >/dev/null 2>&1 &
  timer_pid=$!

  if wait "$child_pid"; then result=0; else result=$?; fi
  kill -TERM "$timer_pid" 2>/dev/null || true
  wait "$timer_pid" 2>/dev/null || true
  ACTIVE_PID=""
  return "$result"
}

on_signal() {
  local signal_code="$1"
  if [[ -n "$ACTIVE_PID" ]]; then terminate_process_tree "$ACTIVE_PID"; fi
  exit "$signal_code"
}

cleanup() {
  local exit_code=$?
  if (( CLEANUP_ATTEMPTED )); then return; fi
  CLEANUP_ATTEMPTED=1
  trap - EXIT INT TERM
  set +e
  run_bounded 30 docker compose --project-name "$PROJECT" -f "$ROOT_DIR/infra/acme-test/compose.yml" down --volumes --remove-orphans >/dev/null 2>&1 || true
  local resource_deadline=$((SECONDS + 30))
  while (( SECONDS < resource_deadline )); do
    if [[ -z "$(run_bounded 10 docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)" && -z "$(run_bounded 10 docker network ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)" ]]; then break; fi
    sleep 1
  done
  if [[ -n "$(run_bounded 10 docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)" || -n "$(run_bounded 10 docker network ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)" ]]; then
    printf 'test Docker resources did not finish cleaning up\n' >&2
    exit_code=1
  fi
  if [[ "$(run_bounded 10 docker ps -aq --filter name='^deploylite-' 2>/dev/null)" != "$production_containers_before" || "$(run_bounded 10 docker volume ls -q --filter name='^deploylite_' 2>/dev/null)" != "$production_volumes_before" ]]; then
    printf 'production Docker resources changed unexpectedly\n' >&2
    exit_code=1
  fi
  rm -rf -- "$TEST_DIR"
  exit "$exit_code"
}
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap cleanup EXIT

production_guard() {
  local production
  production="$(<"$ROOT_DIR/infra/vps/compose.yml")$(<"$ROOT_DIR/infra/vps/compose.tls.yml")"
  [[ "$production" == *'traefik:v3.6.7@sha256:a9890c898f379c1905ee5b28342f6b408dc863f08db2dab20e46c267d1ff463a'* ]]
  [[ "$production" != *pebble* && "$production" != *caServer* && "$production" != *caserver* && "$production" != *PEBBLE* ]]
  [[ "$production" != *certificatesresolvers.test* && "$production" != *certificatesresolvers.pebble* ]]
}

inject_failure() {
  local point="$1"
  [[ -z "$FAIL_AT" || "$FAIL_AT" != "$point" ]] && return 0
  printf 'Injected test-only failure at %s\n' "$point" >&2
  return 97
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

expiry_epoch() {
  local value="$1"
  date -d "$value" +%s 2>/dev/null || date -j -f "%b %e %T %Y %Z" "$value" +%s
}

certificate_snapshot() {
  local details issuer="" serial="" value key
  details="$(run_bounded 10 certificate_details)" || return 1
  while IFS='=' read -r key value; do
    case "$key" in
      issuer) issuer="$value" ;;
      serial) serial="$value" ;;
      notAfter) [[ "$issuer" == *Pebble* ]] && printf '%s|%s|%s\n' "$serial" "$value" "$(expiry_epoch "$value")" ;;
    esac
  done <<<"$details"
}

certificate_details() {
  openssl s_client -connect "127.0.0.1:${TRAEFIK_TLS_PORT}" -servername acme.test </dev/null 2>/dev/null |
    openssl x509 -noout -issuer -serial -enddate
}

wait_for_certificate() {
  local deadline=$((SECONDS + 180)) snapshot
  while (( SECONDS < deadline )); do
    if snapshot="$(certificate_snapshot 2>/dev/null)" && [[ "$snapshot" == *'|'*'|'* ]]; then
      printf '%s\n' "$snapshot"
      return 0
    fi
    sleep 2
  done
  return 1
}

curl_probe() {
  local code
  if ! code="$(run_bounded 15 docker compose --project-name "$PROJECT" -f "$ROOT_DIR/infra/acme-test/compose.yml" run --rm --no-deps curl --connect-timeout 3 --max-time 10 --silent --show-error --cacert /run/test-ca/pebble.minica.pem -o /dev/null -w '%{http_code}' https://acme.test/)"; then return 1; fi
  [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]
}

case "$FAIL_AT" in
  ""|after-project|after-initial-issuance) ;;
  *) printf 'DEPLOYLITE_ACME_TEST_FAIL_AT is not an allowed test-only point\n' >&2; exit 2 ;;
esac
production_containers_before="$(run_bounded 10 docker ps -aq --filter name='^deploylite-')"
production_volumes_before="$(run_bounded 10 docker volume ls -q --filter name='^deploylite_')"
production_guard
inject_failure after-project

install -m 600 /dev/null "$TEST_DIR/acme.json"
cp "$ROOT_DIR/infra/acme-test/pebble.minica.pem" "$TEST_DIR/pebble.minica.pem"
export ACME_TEST_DIR="$TEST_DIR" TRAEFIK_TLS_PORT PEBBLE_API_PORT PEBBLE_MGMT_PORT

start_seconds=$SECONDS
run_bounded 60 docker compose --project-name "$PROJECT" -f "$ROOT_DIR/infra/acme-test/compose.yml" up -d --wait pebble >/dev/null
deadline=$((SECONDS + 30))
while ! curl --connect-timeout 3 --max-time 10 --silent --show-error --fail --insecure "https://127.0.0.1:${PEBBLE_MGMT_PORT}/roots/0" >"$TEST_DIR/pebble-generated.pem"; do
  (( SECONDS < deadline )) || { printf 'Pebble management API did not provide its generated CA\n' >&2; exit 1; }
  sleep 1
done
cat "$TEST_DIR/pebble.minica.pem" "$TEST_DIR/pebble-generated.pem" >"$TEST_DIR/pebble-ca-bundle.pem"
mv "$TEST_DIR/pebble-ca-bundle.pem" "$TEST_DIR/pebble.minica.pem"
chmod 0644 "$TEST_DIR/pebble.minica.pem"
[[ -f "$TEST_DIR/pebble.minica.pem" && -r "$TEST_DIR/pebble.minica.pem" ]]
run_bounded 10 openssl x509 -in "$TEST_DIR/pebble.minica.pem" -noout >/dev/null
run_bounded 60 docker compose --project-name "$PROJECT" -f "$ROOT_DIR/infra/acme-test/compose.yml" up -d --wait traefik >/dev/null
initial="$(wait_for_certificate)"
initial_serial="${initial%%|*}"
initial_expiry="${initial##*|}"
initial_hash="$(sha256_file "$TEST_DIR/acme.json")"
curl_probe
inject_failure after-initial-issuance

# Traefik's periodic interval is one minute for this test duration. Restarting
# invokes its normal startup renewal check deterministically; it does not
# call ACME directly or alter the certificate/storage fixtures.
run_bounded 60 docker compose --project-name "$PROJECT" -f "$ROOT_DIR/infra/acme-test/compose.yml" restart traefik >/dev/null
deadline=$((SECONDS + 180))
renewed=''
while (( SECONDS < deadline )); do
  if renewed="$(certificate_snapshot 2>/dev/null)"; then
    renewed_serial="${renewed%%|*}"
    renewed_expiry="${renewed##*|}"
    renewed_hash="$(sha256_file "$TEST_DIR/acme.json")"
    if [[ "$renewed_serial" != "$initial_serial" && "$renewed_hash" != "$initial_hash" ]] && (( renewed_expiry > initial_expiry )); then break; fi
  fi
  sleep 2
done
[[ -n "$renewed" && "$renewed_serial" != "$initial_serial" && "$renewed_hash" != "$initial_hash" ]] || { printf 'ACME renewal did not replace the stored certificate\n' >&2; exit 1; }
(( renewed_expiry > initial_expiry )) || { printf 'renewed certificate does not expire later\n' >&2; exit 1; }
curl_probe
final="$(certificate_snapshot)"
[[ "${final%%|*}" == "$renewed_serial" ]] || { printf 'served certificate is not the renewed certificate\n' >&2; exit 1; }
printf 'ACME TLS-ALPN renewal integration passed in %ss (startup renewal path; periodic ticker not exercised)\n' "$((SECONDS - start_seconds))"
