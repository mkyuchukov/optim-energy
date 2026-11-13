#!/usr/bin/env bash
# Validate the private Home Assistant boundaries on a real development VM.
set -euo pipefail

: "${HA_DIRECT_URL:?Set HA_DIRECT_URL to the VM internal address}"
: "${TENANT_TOKEN:?Set TENANT_TOKEN to a client administrator or user token}"

EXPECTED_HA_VERSION=${EXPECTED_HA_VERSION:-2026.11.1}
ROOT_TOKEN=${ROOT_TOKEN:-}
HA_PUBLIC_URL=${HA_PUBLIC_URL:-}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

status() {
  local method=$1
  local url=$2
  local expected=$3
  local auth=${4:-}
  local body=${5:-}
  local args=(-sS -o /dev/null -w '%{http_code}' -X "$method" "$url")
  if [ -n "$auth" ]; then
    args+=(-H "Authorization: Bearer $auth")
  fi
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data "$body")
  fi
  local actual
  actual=$(curl "${args[@]}")
  if [ "$actual" != "$expected" ]; then
    fail "$method $url returned $actual, expected $expected"
  fi
  printf '%s %s -> %s\n' "$method" "$url" "$actual"
}

printf 'Checking HA %s through the direct VM address...\n' "$EXPECTED_HA_VERSION"
status GET "$HA_DIRECT_URL/api/" 200 "$TENANT_TOKEN"
status GET "$HA_DIRECT_URL/api/config" 200 "$TENANT_TOKEN"
actual_version=$(curl -sS "$HA_DIRECT_URL/api/config" -H "Authorization: Bearer $TENANT_TOKEN" | jq -r .version)
if [ "$actual_version" != "$EXPECTED_HA_VERSION" ]; then
  fail "HA version is $actual_version, expected $EXPECTED_HA_VERSION"
fi

status GET "$HA_DIRECT_URL/api/states" 403 "$TENANT_TOKEN"
status GET "$HA_DIRECT_URL/api/history/period/2026-11-11T00:00:00+00:00" 403 "$TENANT_TOKEN"
status GET "$HA_DIRECT_URL/api/logbook/2026-11-11T00:00:00+00:00" 403 "$TENANT_TOKEN"
status GET "$HA_DIRECT_URL/api/services" 403 "$TENANT_TOKEN"
status GET "$HA_DIRECT_URL/api/config/config_entries/entry" 403 "$TENANT_TOKEN"
status GET "$HA_DIRECT_URL/api/error_log" 403 "$TENANT_TOKEN"
status POST "$HA_DIRECT_URL/api/template" 403 "$TENANT_TOKEN" '{"template":"1"}'

status POST "$HA_DIRECT_URL/api/webhook/acceptance-does-not-exist" 403 '' '{}'
status POST "$HA_DIRECT_URL/api/webhook/acceptance-does-not-exist" 403 "$TENANT_TOKEN" '{}'
status GET "$HA_DIRECT_URL/api/hassio_ingress/acceptance-does-not-exist" 403 ''
status GET "$HA_DIRECT_URL/api/hassio_ingress/acceptance-does-not-exist" 403 "$TENANT_TOKEN"

status GET "$HA_DIRECT_URL/api/states" 401 ''
status GET "$HA_DIRECT_URL/api/states" 401 'invalid-token-for-acceptance'
status GET "$HA_DIRECT_URL/api/states?access_token=$TENANT_TOKEN" 401
status GET "$HA_DIRECT_URL/%61pi/states" 403 "$TENANT_TOKEN"
status GET "$HA_DIRECT_URL/api%2Fstates" 403 "$TENANT_TOKEN"

if [ -n "$ROOT_TOKEN" ]; then
  status GET "$HA_DIRECT_URL/api/" 200 "$ROOT_TOKEN"
  status GET "$HA_DIRECT_URL/api/config" 200 "$ROOT_TOKEN"
  status GET "$HA_DIRECT_URL/api/states" 200 "$ROOT_TOKEN"
fi

if [ -n "$HA_PUBLIC_URL" ]; then
  status GET "$HA_PUBLIC_URL/api/config" 200 "$TENANT_TOKEN"
  status GET "$HA_PUBLIC_URL/api/states" 404 "$TENANT_TOKEN"
  status GET "$HA_PUBLIC_URL/api/services" 404 "$TENANT_TOKEN"
  status GET "$HA_PUBLIC_URL/api/hassio_ingress/fake" 404 "$TENANT_TOKEN"
fi

printf 'PASS: HA %s direct REST, webhook and ingress isolation\n' "$EXPECTED_HA_VERSION"
