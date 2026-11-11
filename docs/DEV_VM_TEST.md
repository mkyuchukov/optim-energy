# Clean VM acceptance test

This runbook validates the Optim Energy package on a separate Home Assistant VM.

## Safety

- Use a clean Home Assistant OS VM.
- Do not connect it to the production MQTT broker, Zigbee coordinator or live devices.
- Take a VM snapshot before installation.
- Use only test or demo entities for the first test.
- Do not copy secrets from production.

## Before installation

- Home Assistant 2026.11 or newer.
- Access to the VM as administrator.
- A test URL and certificate.
- VM snapshot.
- Optional test data from Home Assistant Demo or Template entities.

## Install

1. Open **Settings → Marketplace**.
2. Add the Optim Energy repository from its My Home Assistant link.
3. Accept the Marketplace warning.
4. Install **Optim Energy**.
5. Restart Home Assistant when prompted.
6. Open **Settings → Devices & services → Add integration → Optim Energy**.
7. Enter a test client name.
8. Create a separate non-admin test user.

## Verify

- The admin test user sees the Optim Energy dashboards plus normal HA maintenance tools.
- The non-admin client sees only Locations, Overview, Help, Groups, Controls, Devices, Reports and Alerts.
- Overview opens without browser console errors.
- Help opens and is readable.
- Setup is absent for the non-admin client.
- The default HA dashboard, Settings and other add-on panels are hidden for the non-admin client.
- The client lands on Locations after login.
- The initial location uses the test client name.
- No live production devices or automations are available.
- The known Optim Energy dashboards use the bundled layouts, with no duplicate sidebar entries.
- Legacy `/local/building-cards.js` and `/local/energy-report-card.js` resources are gone.

## Update test

1. Publish the next test version.
2. Confirm the Marketplace update entity shows it.
3. Take a backup.
4. Install the update and restart.
5. Confirm settings and dashboards are preserved.
6. Confirm the portal JavaScript URL contains the new version.
7. Restore the snapshot and repeat once to prove rollback.

## Migration test

Only after the clean install passes:

1. Restore a copy of the main VM into an isolated network.
2. Disable production MQTT, Zigbee, cloud services and automations before starting.
3. Install Optim Energy on the isolated copy.
4. Confirm the known portal dashboards are replaced with the bundled layouts.
5. Confirm the existing locations, groups, main meters and prices survive through `device_tree`.
6. Confirm old portal resources and duplicate sidebar entries are removed.
7. Load all portal pages against copied data.
8. Record any migration work needed before the main VM is upgraded.


## Tenancy acceptance test

Use the same test VM after creating A and B client trees and fixture devices.

1. Create client A and client B in Setup → People as the Home Assistant administrator.
2. Create one client administrator and one ordinary user for each client.
3. Confirm each shared client tree has at least one location and one distinct test device.
4. Sign in as A's ordinary user and inspect `hass.states`, `hass.entities`, `hass.devices` and the generated registries. No B item may appear.
5. As A, request B's entity in history, statistics, logbook, template and service calls. Every request must be refused.
6. As A, call `curl /api/history/period` and `/api/template` with A's bearer token. Both must return `403`.
7. As A's client administrator, create a user, disable it, and move an ordinary user between A locations. B users must not be listed.
8. Confirm the client administrator cannot create a client or client administrator and cannot call native Home Assistant configuration commands.
9. Restart Home Assistant with the integration files temporarily renamed. Native auth groups must still keep A's states and history free of B data.
10. Restore the integration and confirm the portal tree, users and navigation survive.

Capture `.storage/auth` and `.storage/optim_energy.tenancy` only on the isolated VM. Do not copy them to production.

## Direct-network REST, webhook and ingress acceptance

The public reverse proxy intentionally rejects most `/api/*` routes with `404`
before Home Assistant receives them. Run this check against the VM's internal
address as well; a public `404` alone does not prove that the REST guard works.

Keep tokens in shell variables or a mode-`0600` temporary file. Do not paste
tokens into shell history, CI logs or test output.

```bash
export HA_DIRECT_URL='http://192.168.66.225'
export HA_PUBLIC_URL='https://ha2.int.optim-al.app'
export TENANT_TOKEN='<client-admin-or-user-token>'
export ROOT_TOKEN='<root-user-token>'
```

Tenant bearer tokens must be rejected on direct/internal access:

```bash
for path in \
  /api/states \
  /api/history/period/2026-11-11T00:00:00+00:00 \
  /api/logbook/2026-11-11T00:00:00+00:00 \
  /api/services \
  /api/config/config_entries/entry \
  /api/error_log
do
  printf '%s ' "$path"
  curl -sS -o /dev/null -w '%{http_code}\n' \
    "$HA_DIRECT_URL$path" -H "Authorization: Bearer $TENANT_TOKEN"
done
```

Every status above must be `403`. The non-mutating template check must also
return `403`:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST "$HA_DIRECT_URL/api/template" \
  -H "Authorization: Bearer $TENANT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"template":"1"}'
```

Webhook and ingress surfaces have no tenant identity, so they require a root
bearer token. Anonymous and tenant requests must return `403` even when the
webhook ID is deliberately nonexistent:

```bash
for path in \
  /api/webhook/acceptance-does-not-exist \
  /api/hassio_ingress/acceptance-does-not-exist
do
  printf 'anonymous %s ' "$path"
  curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$HA_DIRECT_URL$path"
  printf 'tenant %s ' "$path"
  curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
    "$HA_DIRECT_URL$path" -H "Authorization: Bearer $TENANT_TOKEN"
done
```

Root REST access and the bootstrap allowlist must remain functional:

```bash
for path in /api/ /api/config /api/states; do
  printf '%s ' "$path"
  curl -sS -o /dev/null -w '%{http_code}\n' \
    "$HA_DIRECT_URL$path" -H "Authorization: Bearer $ROOT_TOKEN"
done
```

Authentication fallbacks must not create a bypass:

```bash
printf 'no token '
curl -sS -o /dev/null -w '%{http_code}\n' "$HA_DIRECT_URL/api/states"
printf 'invalid token '
curl -sS -o /dev/null -w '%{http_code}\n' \
  "$HA_DIRECT_URL/api/states" -H 'Authorization: Bearer invalid'
printf 'cookie token '
curl -sS -o /dev/null -w '%{http_code}\n' \
  "$HA_DIRECT_URL/api/states" -H "Cookie: access_token=$TENANT_TOKEN"
printf 'query token '
curl -sS -o /dev/null -w '%{http_code}\n' \
  "$HA_DIRECT_URL/api/states?access_token=$TENANT_TOKEN"
```

Expected statuses are `401, 401, 401, 401`. Finally confirm the public proxy is
still fail-closed ahead of Home Assistant:

```bash
for path in /api/states /api/services /api/hassio_ingress/fake; do
  printf '%s ' "$path"
  curl -sS -o /dev/null -w '%{http_code}\n' \
    "$HA_PUBLIC_URL$path" -H "Authorization: Bearer $TENANT_TOKEN"
done
```

Expected statuses are `404, 404, 404` while `/api/config` remains available for
frontend bootstrap. Record the exact date, Home Assistant version and observed
statuses in the release acceptance record below.

### HA2 verification record

<!-- Update this table after each supported HA upgrade. -->

| Date | Home Assistant | Route check | Result |
| --- | --- | --- | --- |
| 2026-11-11 | 2026.11.1 / Optim Energy 0.3.0-rc.2 | Direct REST/webhook/ingress matrix | PASS |

HA2 (`opt-vm-ha-02`, direct address `192.168.66.225`) passed after installing
and restarting Optim Energy 0.3.0-rc.2:

- tenant `/api/states`, history, logbook, template, services, config entries and error log: `403`
- anonymous and tenant webhook routes: `403`
- anonymous and tenant Supervisor ingress routes: `403`
- no token, invalid token, cookie token and query-string token: `401`
- encoded and dot-normalized API paths: `403`
- public `/api/states`, `/api/services`, ingress and webhook routes: proxy `404`
- public `/api/config` bootstrap route: `200`
- root browser session and the Client A administrator portal loaded after restart; Client A saw no Client B data
