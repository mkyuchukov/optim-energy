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

## Day-to-day administration

All of this is in **Administration**, as a Home Assistant administrator.

| Task | Where |
| --- | --- |
| Add a client | Clients → New client. A floor with the client's name is created in Home Assistant |
| Add a location | Locations → choose the client → New location. An area is created on the client's floor |
| Add a person | People → New person. Tick the locations an ordinary user may see; a client administrator sees all of them |
| Add a device | Pair or add it in Home Assistant as usual. It appears under Devices → "Not assigned yet". Assign → client, location, group. Picking the location's area in Home Assistant's own add-device dialog does the same thing |
| Move a device | Devices → Move. A move to another client is refused while a virtual device, schedule or alert rule of the old client still uses the device; the message names it |
| Bridges and coordinators | Devices → Ignore. They leave the "Not assigned yet" list |
| Groups | Locations → a location → Groups, or the client administrator's Setup → Locations |
| Wiring, main device, virtual devices | Devices → "Wiring and main devices" |

A device with no power or energy sensor, no switch, light or climate entity is listed under "Not portal devices"; there is nothing to show a client.

Deleting a client leaves its floor and areas in Home Assistant; remove them under Settings → Areas if they are no longer wanted.

## Client deletion and data retention

**Administration → Clients → Delete** removes the client tree, portal user
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
- [x] `v0.7.0` moves production to floor = client, area = location; migration applied and verified
- [x] `v0.8.0`–`v0.10.0`: device inbox, client-administrator screens, cleanup, unmetered devices and location move; production verified
- [ ] Off-VM backup location configured
- [ ] A client-account login verified on production

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

### 2026-11-12 v0.7.0 and the move to floors and areas

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-12, approximately 22:25–22:35 |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.6.0 / 0.7.0, installed through the Marketplace update entity; then `optim_energy/migration/apply` at 22:31 |
| Backup/snapshot | Manual `before-optim-energy-v0.7.0-2026-11-12` before the install; manual `before-optim-energy-areas-migration-2026-11-12` before the migration, copied off the VM. Both configuration only |
| Runtime suites | Unit, HA runtime (migration, isolation, device moves, client-administrator refusals, restart), three-client scale, browser on both models, hassfest and HACS: PASS |
| VM smoke result | N/A; migration and rollback rehearsed on an isolated HA 2026.11.0 copy of the configuration. Apply matched the dry run; restoring the backup onto 0.6.0 brought the label model back |
| Client verification | 63 changes as planned: 1 floor, 2 areas, 46 devices and 14 device-less entities moved, nothing deleted. One client with two locations (43 and 3 devices, 758 and 57 entities), nine groups, one portal user, prices, main devices, wiring, sums and schedules unchanged. A second apply is refused. No client-account login was performed |
| Rollback checkpoint | Stop Home Assistant and restore `before-optim-energy-areas-migration-2026-11-12`; the pre-migration store is also kept as `optim_energy.tenancy_before_areas` |
| Incidents / follow-up | After the migration the entity list an administrator gets for one client held only the 14 device-less entities. Client accounts were not affected. Fixed in 0.7.1 |

### 2026-11-12 v0.7.1 and v0.8.0

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-12, 22:40 (0.7.1) and 23:02 (0.8.0) |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.7.0 / 0.7.1 / 0.8.0, each installed through the Marketplace update entity |
| Backup/snapshot | Manual `after-areas-migration-before-v0.7.1-2026-11-12` and `before-optim-energy-v0.8.0-2026-11-12`, configuration only, on the VM |
| Runtime suites | Unit, HA runtime, three-client scale, browser on both models, hassfest and HACS: PASS for each release |
| VM smoke result | N/A; the device inbox was tried on an isolated HA 2026.11.0 copy of the configuration before 0.8.0 |
| Client verification | After 0.7.1 an administrator's view of the client lists all 815 entities (14 before). After 0.8.0 the inbox lists 79 devices: 42 assigned, 2 not assigned yet, 35 not portal devices. Client, locations, groups, people and settings unchanged. No client-account login was performed |
| Rollback checkpoint | Reinstall the previous tag from the Marketplace; the backups above hold the migrated configuration |
| Incidents / follow-up | 0.8.0 hides devices behind the Zigbee2MQTT bridge in the inbox (display only); fixed in 0.8.1, which was published but not installed on its own. After the 23:02 restart the ENTSO-e integration failed its fetches for about twenty minutes and one Shelly device ("OSV row 8 NE") did not reconnect. Six restarts in two hours; later releases are batched |

### 2026-11-12 v0.9.0 client-administrator screens

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-12, approximately 23:27–23:32 |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.8.0 / 0.9.0 (includes the 0.8.1 inbox fix), installed through the Marketplace update entity |
| Backup/snapshot | Manual `before-optim-energy-v0.9.0-2026-11-12`, configuration only, on the VM |
| Runtime suites | Unit, HA runtime, three-client scale, browser on both models, hassfest and HACS: PASS |
| VM smoke result | N/A |
| Client verification | Inbox lists 82 devices: 45 assigned (42 Shelly in one location, 3 Zigbee meters in the other), 2 not assigned yet, 35 not portal devices. Client, groups, people and settings unchanged. The client-administrator screens were not exercised on production: it has no client administrator account |
| Rollback checkpoint | Reinstall `v0.8.0` from the Marketplace |
| Incidents / follow-up | The ENTSO-e integration again failed its fetches after the restart; "OSV row 8 NE" was already offline before it |

### 2026-11-12 v0.9.1 cleanup

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-12, approximately 23:44–23:48 |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.9.0 / 0.9.1, installed through the Marketplace update entity |
| Backup/snapshot | Manual `before-optim-energy-v0.9.1-2026-11-12`, configuration only, on the VM |
| Runtime suites | Unit, HA runtime, three-client scale, browser on both models, hassfest and HACS: PASS |
| VM smoke result | N/A |
| Client verification | Client, groups, people and settings unchanged; inbox 82 devices with 45 assigned; Administration loads. No client-account login was performed |
| Rollback checkpoint | Reinstall `v0.9.0` from the Marketplace |
| Incidents / follow-up | Installed while the ENTSO-e integration was still retrying from the previous restart; prices returned straight after this one. Seven restarts on 2026-11-12 in total |

### 2026-11-13 v0.10.0, trial client and backup cleanup

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-13, approximately 09:40–10:05 |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.9.1 / 0.10.0, installed through the Marketplace update entity at 09:59 |
| Backup/snapshot | Manual `before-optim-energy-v0.10.0-2026-11-13`, configuration only, on the VM |
| Runtime suites | Unit, HA runtime with the fresh-installation profile, three-client scale, browser on both models, hassfest and HACS: PASS |
| VM smoke result | N/A |
| Client verification | The existing client unchanged (one person, nine groups, 815 entities, 45 devices in both the Clients table and the device list). All integrations loaded and market prices present after the restart. No client-account login was performed |
| Rollback checkpoint | Reinstall `v0.9.1` from the Marketplace |
| Incidents / follow-up | None |

Other changes on 2026-11-13, all through Administration commands and none needing a restart:

- A trial client "Demo Client" was created with one location and one group, and no devices or people, to rehearse onboarding. It was deleted again the same day, together with the floor and area it had made in Home Assistant.
- Three manual backups from the first rollouts (`before-optim-energy-v0.3.0`, `-v0.3.1` and `-v0.4.0`, all dated 2026-11-12) were deleted from the VM, freeing about 3.4 GB.
- The Zigbee coordinator ("Dongle-M_C3A0") and the Zigbee2MQTT bridge were marked Ignore in the device inbox.

Open operational items: every backup is stored on the VM itself, so an off-VM backup location still has to be added; and the labels and areas kept by the 0.7.0 migration were still in place as its rollback path (removed later the same day, see below).

### 2026-11-13 v0.11.0 and the split into two clients

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-13, 11:06 (install) and approximately 11:20–11:25 (split) |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.10.0 / 0.11.0, installed through the Marketplace update entity |
| Backup/snapshot | Manual `before-optim-energy-v0.11.0-2026-11-13` before the install and `before-two-clients-split-2026-11-13` before the split, configuration only, on the VM |
| Runtime suites | Unit, browser on both models, hassfest and HACS: PASS. Runtime and scale ran in CI |
| VM smoke result | N/A |
| Client verification | After the install: client data unchanged, Devices opens on 45 assigned devices. After the split: see below. No client-account login was performed |
| Rollback checkpoint | Reinstall `v0.10.0` from the Marketplace; for the split, restore `before-two-clients-split-2026-11-13` with Home Assistant stopped |
| Incidents / follow-up | The ENTSO-e integration again retried its fetch after the restart |

The split, done with Administration commands and no restart. The single client "Sofia" held two locations that are in fact two companies:

- A new client "Optimal Industries" was created, and the location "Sofia Optimal" was moved to it with `location/move`: 3 devices, 57 entities, 4 groups, 1 virtual device with its sum, its main device and its bill price. Nothing linked it to the other location.
- The remaining client was renamed "Cleverpine": 43 devices, 758 entities, 5 groups, 4 virtual devices, 4 schedules, its exchange price, and the one person.
- Both locations were renamed "Sofia". Their Home Assistant areas are "Sofia (Cleverpine)" and "Sofia (Optimal Industries)", each on its client's floor, because Home Assistant does not allow two areas with one name.
- Totals did not change: 134 devices, 1,486 entities, 45 assigned in the device list.

### 2026-11-13 old areas removed, v0.11.1

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-13, afternoon |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.11.0 / 0.11.1, installed through the Marketplace update entity |
| Backup/snapshot | Manual `before-old-areas-cleanup-2026-11-13` before the cleanup and `before-0.11.1-2026-11-13` before the install, configuration only, on the VM |
| Runtime suites | All CI jobs on the merge commit: PASS |
| VM smoke result | N/A |
| Client verification | After both steps: 758 and 57 entities, 5 and 4 groups, 47 and 4 placements, 45 assigned / 2 ignored / 35 not portal devices, one person. No client-account login was performed |
| Rollback checkpoint | Reinstall `v0.11.0` from the Marketplace; for the cleanup, restore `before-old-areas-cleanup-2026-11-13` with Home Assistant stopped |
| Incidents / follow-up | The cleanup script stopped on a result-handling error after its deletions; the state was re-read and the one remaining label deleted by hand |

The cleanup removed what the 0.7.0 migration had kept as its rollback path: eight empty Home Assistant areas (the old rooms, which are now plugin groups) and the two old location labels. Home Assistant now has exactly two areas, one per client, and no "Other areas".

### 2026-11-13 v0.12.0, label model removed

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-13, evening |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.11.1 / 0.12.0, installed through the Marketplace update entity |
| Backup/snapshot | Manual `before-0.12.0-2026-11-13`, configuration only, on the VM |
| Runtime suites | All CI jobs on the merge commit: PASS |
| VM smoke result | N/A |
| Client verification | Unchanged after the restart: 758 and 57 entities, 5 and 4 groups, 47 and 4 placements, 4 schedules, both prices, 45 assigned / 2 ignored / 35 not portal devices, one person. Administration opens. No client-account login was performed |
| Rollback checkpoint | Reinstall `v0.11.1` from the Marketplace; the store format did not change |
| Incidents / follow-up | None |

From this version the integration only loads a store on floors and areas. The migration commands are gone, so an installation still on labels has to pass through 0.11.1.

### 2026-11-13 v0.12.1, one name per location

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-13, evening |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.12.0 / 0.12.1, installed through the Marketplace update entity |
| Backup/snapshot | Manual `before-0.12.1-2026-11-13`, configuration only, on the VM |
| Runtime suites | All CI jobs on the merge commit: PASS |
| VM smoke result | N/A |
| Client verification | Unchanged after the restart: 758 and 57 entities, 5 and 4 groups, 47 and 4 placements, 4 schedules, both prices, 45 assigned / 2 ignored / 35 not portal devices, one person. No client-account login was performed |
| Rollback checkpoint | Reinstall `v0.12.0` from the Marketplace; location names then stay as they are now |
| Incidents / follow-up | None |

On load both locations took their area's name, so the portal now shows "Sofia (Cleverpine)" and "Sofia 1(Optimal Industries)", the same as Home Assistant. Location ids, prices and people's assignments are keyed by id and did not change.

### 2026-11-13 v0.13.0, Administration context and wording

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-13, evening |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.12.1 / 0.13.0, installed through the Marketplace update entity |
| Backup/snapshot | Manual `before-0.13.0-2026-11-13`, configuration only, on the VM |
| Runtime suites | All CI jobs on the merge commit: PASS |
| VM smoke result | N/A |
| Client verification | Administration → Devices after the restart: Tenant and Location selectors present; switching tenant with the dropdown focused changed the list from 4 to 46 rows without Refresh; Unassigned shows 0 waiting and 2 ignored. Device list totals unchanged: 45 assigned, 2 ignored, 35 unlisted. No client-account login was performed |
| Rollback checkpoint | Reinstall `v0.12.1` from the Marketplace; no stored data changed |
| Incidents / follow-up | None |

The interface now says tenant for client and user for person. Commands, URLs and stored data keep their old names.

### 2026-11-13 v0.14.0, Administration dialogs

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-13, evening |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.13.0 / 0.14.0, installed through the Marketplace update entity |
| Backup/snapshot | Manual `before-0.14.0-2026-11-13`, configuration only, on the VM |
| Runtime suites | All CI jobs on the merge commit: PASS |
| VM smoke result | N/A |
| Client verification | After the restart, opened and cancelled without saving: the group dialog (location, parent group, 42 devices listed, 2 ticked for "Game Room Lights") and the device dialog (location, group, parent device, "Main device"). Locations shows "Manage groups" and groups only; Devices lists 46 rows for Cleverpine; Users offers "All tenants" with a Tenant column. No client-account login was performed |
| Rollback checkpoint | Reinstall `v0.13.0` from the Marketplace; no stored data changed |
| Incidents / follow-up | None |

From this version a group can be moved to another location of its tenant from its Edit dialog; its sub-groups and devices go with it.

### 2026-11-13 v0.14.1, channel devices and the health check

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-13, evening |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.14.0 / 0.14.1, installed through the Marketplace update entity |
| Backup/snapshot | Manual `before-0.14.1-2026-11-13`, configuration only, on the VM |
| Runtime suites | All CI jobs on the merge commit: PASS |
| VM smoke result | N/A |
| Client verification | The health check on Administration, Tenants: "All checks passed", 134 devices and 1 user checked. Groups, placements of real devices and the device list totals unchanged. No client-account login was performed |
| Rollback checkpoint | Reinstall `v0.14.0` from the Marketplace. The areas set on the channel devices stay; to undo those as well, restore `before-0.14.1-2026-11-13` with Home Assistant stopped |
| Incidents / follow-up | Found by the user: a tenant user saw one device in "Kitchen Lights" where the administrator saw two |

What the start-up changed in Home Assistant: 51 channel devices of Cleverpine's Shelly meters (the "Phase A/B/C" and "Energy Meter 0/1" parts) had no area and were given their meter's area, "Sofia (Cleverpine)". The devices in that area went from 43 to 94, and the entities a Cleverpine user can read from 758 to 1,166. The three Zigbee devices of Optimal Industries stay as they were: they sit under the Zigbee bridge but are devices of their own.

### 2026-11-13 v0.15.0, tenant preview

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-13, evening |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.14.1 / 0.15.0, installed through the Marketplace update entity |
| Backup/snapshot | Manual `before-0.15.0-2026-11-13`, configuration only, on the VM |
| Runtime suites | All CI jobs on the merge commit: PASS |
| VM smoke result | N/A |
| Client verification | Preview of Cleverpine from Administration, Tenants: a placeholder for about three seconds, then the figures, and never "No devices in this location yet". The page names "Cleverpine · Sofia (Cleverpine)" with a way back. In preview only `energy-start` is hidden from the administrator's sidebar; back in Administration all nine tenant pages are hidden again. The health check still passes. No client-account login was performed |
| Rollback checkpoint | Reinstall `v0.14.1` from the Marketplace; no stored data changed |
| Incidents / follow-up | None |

### 2026-11-13 v0.15.1, market price for tenants

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-13, evening |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.15.0 / 0.15.1, installed through the Marketplace update entity |
| Backup/snapshot | Manual `before-0.15.1-2026-11-13`, configuration only, on the VM |
| Runtime suites | All CI jobs on the merge commit: PASS |
| VM smoke result | N/A |
| Client verification | After the restart each tenant's entity list holds the nine ENTSO-e price sensors, including the one Cleverpine's price uses (1,175 and 66 entities, 9 more each). The checks box and its command are gone. No channel device is out of its meter's area. Device list totals and groups unchanged. No client-account login was performed, so the chart itself and the landing page were not seen as a tenant user |
| Rollback checkpoint | Reinstall `v0.15.0` from the Marketplace; no stored data changed |
| Incidents / follow-up | Found by the user: a tenant user had no exchange price chart on Overview |

### 2026-11-13 v0.16.0, Setup rebuilt, last known prices, real names

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-13, evening |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.15.1 / 0.16.0, installed through the Marketplace update entity |
| Backup/snapshot | Manual `before-0.16.0-2026-11-13`, configuration only, on the VM |
| Runtime suites | All CI jobs on the merge commit: PASS |
| VM smoke result | N/A |
| Client verification | Tenant pages show "OSV Kitchen" and "OSV Kitchen rooms 401 and 402 T18" in full. The price memory holds 9 sensor values and 96 quarter-hour prices and reports live; Overview shows "Live" under "Price now". Setup, Locations is the new table with "Manage groups" and "Price" and none of the administrator's location buttons; the price dialog opens on IBEX with the live marker; Setup, Devices lists 46 devices. Dialogs were opened and cancelled, nothing was saved. No client-account login was performed |
| Rollback checkpoint | Reinstall `v0.15.1` from the Marketplace; no stored data changed. The new file `.storage/optim_energy.prices` can stay |
| Incidents / follow-up | The ENTSO-e integration had been failing since the 15:18 restart and was still in `setup_retry` before this install; after this restart it loaded and prices are live again |

### 2026-11-13 v0.17.0, tenant wiring, four device maps, report device count

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-13, evening |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.16.0 / 0.17.0, installed through the Marketplace update entity |
| Backup/snapshot | Manual `before-0.17.0-2026-11-13`, configuration only, on the VM |
| Runtime suites | All CI jobs on the merge commit: PASS |
| VM smoke result | N/A |
| Client verification | Devices, Map for Cleverpine drew all four views: Connection by group (49 nodes), Connection by device (55), Power by group (49), Power by device (26). The report model gives "Kitchen Lights" 3 meters and 2 devices, so its note now says 2. Nothing was saved. No client-account login was performed |
| Rollback checkpoint | Reinstall `v0.16.0` from the Marketplace; no stored data changed |
| Incidents / follow-up | After this restart the ENTSO-e integration was again in `setup_retry`. For the first time the portal carried on: Overview showed "Price now € 0.270" and the price chart from the 96 remembered quarter-hour prices, both marked "Not live · last read 13 Nov, 16:30" |

### 2026-11-13 v0.17.1 and v0.17.2, Connection by device

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-13, evening, two installs about half an hour apart |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.17.0 / 0.17.1, then 0.17.1 / 0.17.2, each installed through the Marketplace update entity |
| Backup/snapshot | Manual `before-0.17.1-2026-11-13` and `before-0.17.2-2026-11-13`, configuration only, on the VM |
| Runtime suites | All CI jobs on each merge commit: PASS |
| VM smoke result | N/A |
| Client verification | 0.17.2, Devices, Map, Connection by device for Cleverpine: a tree with no group nodes, 42 devices, 3 virtual devices and the main device under the location; boxes show address and signal, all 46 lines online. It opens with the deeper branches folded (26 nodes, zoom 0.6) and expands to 47 nodes over 5 levels. No client-account login was performed |
| Rollback checkpoint | Reinstall `v0.17.0` from the Marketplace; no stored data changed |
| Incidents / follow-up | 0.17.1 drew the device hierarchy as a circle. With the real five-level hierarchy it came out about 1,900 by 2,400 pixels with links up to 685 pixels, unreadable when fitted to the screen; the three-device test setup had not shown this. 0.17.2 replaced it with the tree |

### 2026-11-13 v0.17.3, Connection by device as rings

| Field | Value |
| --- | --- |
| Date/time (Europe/Sofia) | 2026-11-13, evening |
| Operator | Production root administrator session |
| HA version before/after | 2026.11.0 / 2026.11.0 |
| Optim Energy before/after | 0.17.2 / 0.17.3, installed through the Marketplace update entity |
| Backup/snapshot | Manual `before-0.17.3-2026-11-13`, configuration only, on the VM |
| Runtime suites | All CI jobs on the merge commit: PASS |
| VM smoke result | N/A |
| Client verification | Devices, Map, Connection by device for Cleverpine: drawn in the connection style (round nodes, no boxes, no group nodes), 26 nodes as it opens and 47 when expanded, 1 main and 3 virtual devices marked, every line online. Expand all, Collapse all and a single fold work. Power by device still uses the box tree. No client-account login was performed |
| Rollback checkpoint | Reinstall `v0.17.2` from the Marketplace; no stored data changed |
| Incidents / follow-up | Reported by the user: 0.17.2 drew this view with the power view's boxes, so it read as the power view. The layout was checked against the production hierarchy's shape in a local render before this release |

## Repository protection

Branch creation, updates, deletion and force pushes are restricted by the
`Owner-only branch updates` ruleset. Repository administrators are the only
bypass actors. The public default branch remains forkable for pull requests, but
only the repository owner can create or update branches in the origin
repository.
