#!/usr/bin/env bash

# Shared, side-effect-free safety checks for the VPS preview operator.

vps_fail() { printf 'BLOCKED: %s\n' "$*" >&2; return 3; }

vps_valid_id() {
  [[ "${1:-}" =~ ^[a-z0-9][a-z0-9-]{2,31}$ ]] && [[ "$1" != *preview* || "$1" == preview-* ]]
}

vps_require_safe_id() {
  local id="$1"
  vps_valid_id "$id" || vps_fail 'preview ID must be 3-32 lowercase letters, digits, or hyphens.'
  [[ "$id" != *..* && "$id" != *canonical* && "$id" != *production* ]] || vps_fail 'preview ID contains a forbidden resource name.'
}

vps_require_isolated_resources() {
  local value label
  for value in "$@"; do
    label="${value%%=*}"
    value="${value#*=}"
    [[ "$value" != deploylite && "$value" != deploylite_* && "$value" != *:80 && "$value" != *:443 ]] ||
      vps_fail "$label targets a canonical resource or privileged port."
    [[ "$value" != *traefik* && "$value" != *deploylite-network* && "$value" != *deploylite_ ]] ||
      vps_fail "$label targets a canonical network or router."
  done
}

vps_require_loopback_ports() {
  local ports="$1" entry host port canonical previous
  local -a entries seen
  IFS=',' read -r -a entries <<< "$ports"
  if [[ "${#entries[@]}" -ne 3 ]]; then vps_fail 'VPS_LOOPBACK_PORTS must contain exactly three PostgreSQL, web, and API mappings.'; return 3; fi
  for entry in "${entries[@]}"; do
    if [[ ! "$entry" =~ ^127\.0\.0\.1:[0-9]{1,5}$ ]]; then vps_fail 'VPS_LOOPBACK_PORTS must use exact 127.0.0.1 decimal mappings.'; return 3; fi
    host="${entry%%:*}"; port="${entry#*:}"
    canonical="$port"
    while [[ "${#canonical}" -gt 1 && "${canonical#0}" != "$canonical" ]]; do canonical="${canonical#0}"; done
    if [[ "$host" != 127.0.0.1 ]]; then vps_fail 'VPS_LOOPBACK_PORTS must use exact 127.0.0.1 decimal mappings.'; return 3; fi
    if ((10#$canonical < 1024 || 10#$canonical > 65535)); then vps_fail 'VPS_LOOPBACK_PORTS ports must be decimal values from 1024 through 65535.'; return 3; fi
    if [[ "$canonical" == 80 || "$canonical" == 443 ]]; then vps_fail 'VPS_LOOPBACK_PORTS must not use ports 80 or 443.'; return 3; fi
    for previous in "${seen[@]:-}"; do
      if [[ "$canonical" == "$previous" ]]; then vps_fail 'VPS_LOOPBACK_PORTS ports must be numerically unique.'; return 3; fi
    done
    seen+=("$canonical")
  done
}

vps_redact() {
  # Keep output bounded and redact both values and common assignment/URL forms.
  local input secret name
  input="$(LC_ALL=C head -c "${VPS_MAX_EVIDENCE_BYTES:-65536}")"
  for name in SSHPASS VPS_DB_PASSWORD VPS_API_TOKEN VPS_AUTHORIZATION DATABASE_URL; do
    secret="${!name:-}"
    [[ -n "$secret" ]] && input="${input//"$secret"/[REDACTED]}"
  done
  input="$(printf '%s' "$input" | LC_ALL=C sed -E \
    -e 's/(Authorization:[[:space:]]*(Bearer|Basic)[[:space:]]+)[^[:space:]]+/\1[REDACTED]/Ig' \
    -e 's/((PASSWORD|TOKEN|SECRET|API_KEY|DATABASE_URL)[[:space:]]*=[[:space:]]*)[^[:space:]]+/\1[REDACTED]/Ig' \
    -e 's#(postgres(ql)?://[^:/@]+:)[^@[:space:]]+@#\1[REDACTED]@#Ig')"
  [[ -n "$input" ]] && printf '%s\n' "$input"
}

vps_source_provenance() {
  local source="$1" expected_commit="$2" expected_tree="$3" status commit tree source_url
  [[ -d "$source/.git" ]] || { vps_fail 'source must be a Git checkout.'; return 3; }
  status="$(git -C "$source" status --porcelain)"
  [[ -z "$status" ]] || { vps_fail 'source checkout must be clean.'; return 3; }
  commit="$(git -C "$source" rev-parse HEAD)" || { vps_fail 'cannot resolve source commit.'; return 3; }
  tree="$(git -C "$source" rev-parse 'HEAD^{tree}')" || { vps_fail 'cannot resolve source tree.'; return 3; }
  [[ "$commit" == "$expected_commit" ]] || { vps_fail 'source commit does not match the requested commit.'; return 3; }
  [[ "$tree" == "$expected_tree" ]] || { vps_fail 'source tree does not match the requested tree.'; return 3; }
  source_url="${VPS_SOURCE_URL:-$(git -C "$source" remote get-url origin 2>/dev/null || true)}"
  vps_valid_source_url "$source_url" || { vps_fail 'source URL must be an explicit safe HTTPS URL or the checkout origin.'; return 3; }
  printf '%s %s %s\n' "$commit" "$tree" "$source_url"
}

vps_valid_source_url() {
  local source_url="${1:-}"
  [[ "$source_url" =~ ^https://[^/@[:space:]]+(/[^[:space:]]*)?$ ]] || return 1
  [[ "$source_url" != *\\* && "$source_url" != *..* && "$source_url" != *#* ]] || return 1
}
