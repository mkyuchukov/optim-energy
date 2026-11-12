# Optim Energy production operations

This runbook covers shared-instance operation. It does not make Home Assistant
a hostile-tenant boundary. Shared recorder history, backups, logs, networking and
the Home Assistant root account remain trusted global resources.

## Supported client surface

- Home Assistant owners and administrators use the separate **Administration**
  console for clients, locations and people, and do not enter the client portal
  unless they explicitly choose Preview.
- Client accounts use the bundled Optim Energy client dashboards and checked
  portal commands only. Ordinary users may be assigned to one or several
  locations; a single-location account gets its location preselected and does
  not see the location picker.
- File editor, Zigbee2MQTT and other native add-ons remain available to Home
  Assistant administrators from the normal Home Assistant sidebar. Their
  ingress requests use a short-lived Supervisor `ingress_session` capability;
  the public reverse proxy must pass `/api/hassio_ingress/` through to Home
  Assistant and preserve cookies, uploads and long-lived connections.
- Home Assistant mobile-app webhooks, generic webhooks, Supervisor ingress,
  Assist, templates, raw REST and native configuration commands are not part of
  the client surface.
- New-client creation remains root-controlled until the production-readiness epic
  and this rollout checklist are complete.
- Root users must not place client secrets, provider keys or private data in
  shared dashboards, `/local`, notes or dashboards.

## Backup before maintenance

Create a Home Assistant full backup immediately before an integration, Home
Assistant or VM change. Prefer a full VM snapshot for HAOS deployments; the
files below are the minimum selective backup set.

| Path | Contains |
| --- | --- |
| `.storage/auth` | Users, credentials, refresh tokens and managed groups |
| `.storage/optim_energy.tenancy` | Clients, user assignments, trees and group index |
| `.storage/optim_energy.migration_backup` | First legacy portal dashboard backup |
| `.storage/lovelace_dashboards` | Portal dashboard metadata |
| `.storage/lovelace.energy_*` | Bundled dashboard content |
| `.storage/core.config_entries` | Integration entries and portal helpers |
| `.storage/core.entity_registry` | Entity ownership, areas and labels |
| `.storage/core.device_registry` | Device ownership and labels |
| `.storage/core.area_registry` | Areas and labels |
| `.storage/core.label_registry` | Location and portal labels |
| `.storage/core.floor_registry` | Floors used by groups |
| `configuration.yaml`, `automations.yaml`, `secrets.yaml` | Shared HA configuration |
| `home-assistant_v2.db` and WAL files | Shared recorder history |
| `custom_components/optim_energy/` | Installed integration files |

For a consistent cold copy, use the HAOS console to stop core, archive the files,
and start core again:

```bash
ha core stop
mkdir -p /mnt/data/optim-energy-backups
tar -C /mnt/data/supervisor/homeassistant \
  -czf /mnt/data/optim-energy-backups/pre-upgrade-$(date +%Y%m%d-%H%M).tgz \
  .storage/auth .storage/optim_energy.tenancy \
  .storage/optim_energy.migration_backup .storage/lovelace_dashboards \
  .storage/lovelace.energy_* .storage/core.config_entries \
  .storage/core.entity_registry .storage/core.device_registry \
  .storage/core.area_registry .storage/core.label_registry \
  .storage/core.floor_registry configuration.yaml automations.yaml \
  secrets.yaml
ha core start
```

Do not use a live SQLite database copy while Home Assistant is writing. Use the
full backup UI, stop core, or SQLite's backup command. Test a restore on a
disposable VM before relying on it.

## Restore

1. Stop home automation and client access.
2. Prefer restoring the complete VM snapshot or a full Home Assistant backup.
3. For selective restore, stop core before replacing any `/config/.storage`
   file.
4. Restore `.storage/auth`, `.storage/optim_energy.tenancy`, Lovelace files and
   the registry files from the same backup timestamp. Mixing auth and tenancy
   files can leave users assigned to missing clients.
5. Start core and verify root login.
6. Verify a client administrator sees only its own location and cannot access
   raw REST, templates, webhooks or ingress.
7. Run `tools/vm_smoke.sh` against the VM before reopening client access.

Restoring `.storage/auth` also rewinds passwords and refresh tokens. Revoke and
recreate any account that may have been compromised after the backup timestamp.

## Client deletion and data retention

**Setup → People & clients → Delete client** removes the client tree, portal user
assignments, managed HA groups and all HA users assigned to the client. It also
revokes their active sessions. At least one client must remain.

The following are intentionally **not** deleted automatically:

- recorder history and statistics
- Home Assistant log entries
- native entities, devices, areas and labels
- Home Assistant automations and helper config entries
- integration backups and VM/HA backups

The portal cannot know whether a native entity is shared. Export the client tree
first, then remove native HA objects separately after the client signs off. A
deleted client's historical data remains in shared backups and recorder storage
until the retention policy removes it.

## User disable and deletion

- Disable a suspect account first; an inactive user cannot obtain a new access
  token and existing access tokens are rejected.
- Delete the account to revoke its refresh tokens and remove its HA identity.
- Delete or disable the user in Optim Energy Setup, not by editing `.storage/auth`
  by hand.
- For a suspected credential compromise, rotate the local password/provider
  secret and review root-only HA logs and audit-mode denials.
- Restoring an old auth store can reactivate old sessions. Treat restored auth
  data as sensitive.

## Recorder and log retention

The recorder database is shared across clients. Tenant filtering prevents clients
from reading another client's states through the portal, but it does not partition
the physical database or backups.

Set an explicit retention period in Home Assistant:

```yaml
recorder:
  purge_keep_days: 30
  commit_interval: 5
```

Record the chosen period in the service contract. Home Assistant logs are also
shared and may contain client entity names, URLs and error details. Restrict log
and backup access to root operators. Do not promise clients physical deletion
from all historical backups when a tenant is deleted.

## Export and deletion policy

- Export client trees from `.storage/optim_energy.tenancy` only to an approved
  encrypted destination.
- Do not export `.storage/auth`, passwords, refresh tokens, provider keys or
  another client's recorder rows.
- Define a written retention period for exports and delete exported copies at
  the end of that period.
- Keep a signed deletion record containing the client ID, operator, date,
  exported files and native HA objects deleted. Do not store secrets in the
  record.
- A client data-deletion request can remove portal state and native HA objects,
  but recorder rows and older backups require the retention/backup policy.

## Bill reader quota and secret rotation

The portal bill-reader path is rate limited in memory to protect the shared
provider:

- 5 requests per user per rolling hour
- 30 requests per client per rolling hour
- the quota resets on Home Assistant restart

Requests over quota fail before the provider is called. The UI limits pages and
payload size, and the server rejects bodies over 300 KB. If the provider has a
lower contractual quota, lower the constants in `optim_energy/quota.py` and run
the runtime tests before rollout.

The reader endpoint/key belong in the Home Assistant `rest_command` configuration,
not in Git or a client dashboard. Rotate a provider secret in this order:

1. Create the replacement key at the provider.
2. Update the Home Assistant `rest_command` configuration.
3. Reload/restart Home Assistant and submit one authorized test bill.
4. Revoke the old provider key.
5. Confirm quota and error logs show no repeated failures.

Bill image data is sent through the shared HA process to the configured provider.
Document that provider as a subprocessor and retain its data-processing terms.

## Home Assistant upgrade and rollback

1. Create a full backup and VM snapshot.
2. Record the current HA version, integration version and dashboard checksums.
3. Enable **Settings → Devices & services → Optim Energy → Configure → Audit mode**.
   Audit mode logs would-be denials without blocking them; use it only during a
   controlled upgrade window.
4. Upgrade Home Assistant and the integration. Update `tests/runtime/HA_VERSION`
   only after the new supported version is selected.
5. Run:
   ```bash
   make test
   make test-runtime
   make test-scale
   HA_DIRECT_URL="http://<vm>" TENANT_TOKEN="<tenant-token>" \
     EXPECTED_HA_VERSION="<ha-version>" ./tools/vm_smoke.sh
   ```
6. Verify root access, every portal dashboard and a client administrator login.
7. Turn audit mode off and run the smoke script again; the direct tenant REST,
   webhook and ingress checks must return `403`. Public denied routes must stay
   `404`.
8. Record the versions, backup timestamp, operator, results and rollback point.

If any guard, group policy or portal dashboard check fails, stop the rollout,
disable client access, restore the snapshot and reopen only after the failed
check is reproduced and fixed.

## Emergency root recovery

1. Use the HAOS console or physical/VM console, not a tenant account.
2. Create or mount a known-good backup.
3. Stop core before replacing `.storage/auth`.
4. Restore the matching `.storage/auth` and `.storage/optim_energy.tenancy` pair.
5. Start core, verify the owner account, then verify one test client.
6. Do not hand-edit managed group IDs or delete system groups.
7. Rotate any credential that was exposed during recovery.

## Rollout checklist

- [x] #5 REST/webhook/ingress isolation passed
- [x] #6 pinned HA runtime acceptance passed
- [x] #8 three-client scale/lifecycle acceptance passed
- [x] #9 backup restore rehearsal passed
- [x] Client deletion revokes users and sessions
- [x] Bill-reader quota behavior tested
- [x] Retention and export policy documented
- [x] Audit-mode controls tested through the real options flow
- [x] Emergency recovery path and production rollback checkpoint recorded
- [x] Repository licensed under Apache License 2.0
- [x] Initial zero-client production deployment completed; no maintenance window required
- [x] Stable `0.3.x` release published as `v0.3.0`
- [x] Patch `v0.3.1` restores tenant registry names and device types; production verified
- [x] Separate Administration console and People workspace implemented; production verified
- [x] `v0.6.0` closes client-administrator isolation holes and starts fail-closed; production verified

## Maintenance record template

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | |
| Operator | |
| HA version before/after | |
| Optim Energy before/after | |
| Backup/snapshot | |
| Runtime suites | |
| VM smoke result | |
| Client verification | |
| Rollback checkpoint | |
| Incidents / follow-up | |

### 2026-11-12 initial production rollout

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-12, approximately 11:42–11:46 |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | Dashboard-only package / 0.3.0 |
| Backup/snapshot | Manual `before-optim-energy-v0.3.0-2026-11-12` |
| Runtime suites | Unit, HA runtime, three-client scale, browser, hassfest and HACS: PASS |
| VM smoke result | N/A before clients; live portal and both locations verified after restart |
| Client verification | `Sofia Cleverpine` and `Sofia Optimal` preserved with live readings |
| Rollback checkpoint | Restore the manual backup above |
| Incidents / follow-up | Non-admin HA user moved to fail-closed unassigned group; assign explicitly when a client account is needed |

### 2026-11-12 v0.3.1 tenant registry patch

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-12, approximately 12:27–12:31 |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.3.0 / 0.3.1 |
| Backup/snapshot | `before-optim-energy-v0.3.1-2026-11-12` (slug `24072c5a`), plus the previous integration directory |
| Runtime suites | Unit, HA runtime, three-client scale, browser, hassfest and HACS: PASS |
| VM smoke result | N/A; live portal verified after restart |
| Client verification | `Sofia Cleverpine` and `Sofia Optimal` preserved; friendly names, Light/Relay/Energy meter types and live readings visible |
| Rollback checkpoint | Restore the backup above or copy back `/mnt/data/optim-energy-backups/optim_energy-pre-2026-11-12-v0.3.1` |
| Incidents / follow-up | Registry serializer now preserves `name_by_user`, model metadata and `via_device_id`; no HA or tenant data loss observed |

### 2026-11-12 v0.4.3 Administration console rollout

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-12, approximately 13:14–13:34 |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.3.1 / 0.4.3 |
| Backup/snapshot | `before-optim-energy-v0.4.0-2026-11-12` (slug `80428764`), plus the previous integration directory copies |
| Runtime suites | Unit, HA runtime, three-client scale, browser, hassfest and HACS: PASS |
| VM smoke result | N/A; live portal verified after each restart |
| Client verification | Administration is the system default for HA administrators; sidebar contains only Administration and normal HA tools. People, Clients and Locations views load; Preview opens the selected client; both locations retain live readings |
| Rollback checkpoint | Restore the backup above or copy back the preserved `optim_energy-pre-2026-11-12-v0.4.3` directory |
| Incidents / follow-up | Fixed the pinned client Overview and Preview action during rollout; no tenant, device or registry data loss observed |

### 2026-11-12 v0.4.4 native add-on launchers

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-12, approximately 13:45–14:00 |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.4.3 / 0.4.4 |
| Backup/snapshot | Existing `before-optim-energy-v0.4.0-2026-11-12`; previous integration directory preserved |
| Runtime suites | Unit, HA runtime, three-client scale, browser, hassfest and HACS: PASS |
| VM smoke result | N/A; live portal verified after restart |
| Client verification | Administrator sidebar no longer exposes broken public ingress panels; Administration → Apps & tools opens native File editor and Zigbee2MQTT on the internal HA URL |
| Rollback checkpoint | Copy back the preserved `optim_energy-pre-2026-11-12-v0.4.4` directory |
| Incidents / follow-up | Public `ha.int` proxy returns openresty 404 for `/api/hassio_ingress`; native add-ons require local network/VPN access |

### 2026-11-12 v0.4.5 native add-on ingress

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-12, approximately 14:00–14:15 |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.4.4 / 0.4.5 |
| Backup/snapshot | Existing `before-optim-energy-v0.4.0-2026-11-12`; previous integration directory preserved |
| Runtime suites | Unit, HA runtime, three-client scale, browser, hassfest and HACS: PASS |
| VM smoke result | Native File editor and Zigbee2MQTT panels verified through `/api/hassio_ingress` |
| Client verification | Administrator sidebar remains limited to Administration and native HA tools; tenant routes remain blocked |
| Rollback checkpoint | Copy back the preserved `optim_energy-pre-2026-11-12-v0.4.5` directory |
| Incidents / follow-up | REST guard now accepts only signed Supervisor ingress-session cookies; proxy passes ingress paths and keeps uploads/WebSocket support |

### 2026-11-12 v0.5.0 table-first administration rollout

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-12, approximately 14:20–14:45 |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.4.6 / 0.5.0 |
| Backup/snapshot | Existing `before-optim-energy-v0.4.0-2026-11-12`; previous integration directory preserved |
| Runtime suites | Unit, HA runtime, three-client scale, browser, hassfest and HACS: PASS |
| VM smoke result | N/A; live Administration table views verified |
| Client verification | Clients, Locations, People and Devices render in table form; one-location user behavior covered by browser acceptance |
| Rollback checkpoint | Copy back the preserved `optim_energy-pre-2026-11-12-v0.5.0` directory |
| Incidents / follow-up | v0.5.1 removes the unused legacy admin card implementation; no tenant or registry data loss observed |

### 2026-11-12 v0.6.0 tenant isolation fixes

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-12, approximately 21:25–21:35 |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.5.8 / 0.6.0, installed through the Marketplace update entity |
| Backup/snapshot | Manual `before-optim-energy-phase1-2026-11-12` (configuration only, no database or add-ons), copied off the VM; automatic full backup of 2026-11-12 04:49 retained |
| Runtime suites | Unit, HA runtime (including the hostile client-administrator tree scenario), three-client scale, browser, hassfest and HACS: PASS |
| VM smoke result | N/A; the backup was restored into an isolated HA 2026.11.0 container with no network and 0.6.0 started on it with no plugin errors |
| Client verification | One client with two locations, one portal user, 134 devices, 1,486 entities, 11 automations and the settings tree unchanged after restart; Administration renders. No client-account login was performed |
| Rollback checkpoint | Restore the manual backup above with Home Assistant stopped, or reinstall `v0.5.8` from the Marketplace |
| Incidents / follow-up | None. The Marketplace had recorded `v0.3.0` as installed while the files were 0.5.8; it now reads `v0.6.0`. Free disk space on the VM was 5.6 GB of 30.8 GB, which is why the backup excluded the database |

## Repository protection

Branch creation, updates, deletion and force pushes are restricted by the
`Owner-only branch updates` ruleset. Repository administrators are the only
bypass actors. The public default branch remains forkable for pull requests, but
only the repository owner can create or update branches in the origin
repository.
