# Optim Energy

Optim Energy is a Home Assistant portal package for commercial energy monitoring, controls, alerts and reports.

## What it installs

- The Optim Energy building, controls, alerts and report cards.
- Ten replacement Home Assistant dashboards:
  - Administration — table-first clients, locations, people and devices for Home Assistant administrators
  - Locations
  - Overview and Help
  - Groups
  - Controls
  - Devices
  - Reports
  - Alerts
  - Setup, including People
- A first-run form asking for the first client or site name.
- A local static asset route for the bundled JavaScript and bill-reader settings.
- A shared-instance tenant model: clients, portal user roles, locations and per-client dashboard trees.

## Client separation

Optim Energy runs multiple clients in one Home Assistant instance, but it does **not** make Home Assistant a hard multi-tenant system.

- A Home Assistant owner or administrator is the global root and uses the separate **Administration** console rather than the client portal.
- A client administrator is a portal role. It is never added to Home Assistant's global `Administrators` group.
- An ordinary client user is assigned to one or more locations.
- Each location has an authentication group that covers exactly its area, for Home Assistant's native state, history and entity-service filtering.
- A websocket firewall allows only the portal command surface and checks history, statistics and logbook requests against the tenant.
- Raw REST API access, templates, Assist, arbitrary services and native configuration commands remain outside the client surface.
- Webhook IDs and Supervisor ingress routes do not carry tenant identity. They are blocked unless the request presents a valid Home Assistant root bearer token.
- Client portal settings live in `.storage/optim_energy.tenancy`, not in a dashboard document.

Home Assistant administrators use the table-first **Administration** console to create and edit clients, locations, people and devices, including virtual devices and the device tree. A client administrator can use **Setup → People** to manage ordinary users inside its own client. Only a Home Assistant administrator can create clients or client administrators.

The following remain shared: the recorder database, backups, logs, `/local` files, restarts and Home Assistant updates. Do not use this as a hostile-tenant boundary or expose secrets in shared files. For strict isolation, use one Home Assistant instance per client. Do not enable generic or companion-app webhooks, and do not expose add-on ingress, on a shared instance unless every caller is trusted to use the global root identity.

## Clients, locations, groups and devices

- A **client** is a floor in Home Assistant. A **location** is one area on that floor. **Groups** live in the portal and only organise devices.
- A device belongs to the location whose area it has. Giving a device that area in Home Assistant's own add-device flow assigns it, for any integration.
- **Administration → Devices** lists every Home Assistant device with what it looks like and where it is. A Home Assistant administrator assigns, moves, removes or ignores devices there.
- A client administrator renames devices, moves them between its own locations and groups, manages its groups and its people, and edits its own prices, alerts and schedules. It cannot create locations or take devices from another client.
- An installation that still places devices by label (created before 0.7.0 and never switched) must install 0.11.1 and switch under Administration before upgrading to 0.12.0 or later. Until then the integration refuses to load and client accounts stay closed. See `docs/CAPABILITIES.md` for who may call what.

## Requirements

- Home Assistant OS or Supervised
- Home Assistant 2026.11 or newer
- Home Assistant Marketplace enabled
- Recorder enabled, which is the normal Home Assistant setup

## Install from a custom repository

1. Open **Settings → Marketplace**.
2. Open the menu and select **Add from link**.
3. Add the repository URL.
4. Install **Optim Energy**.
5. Restart Home Assistant when prompted.
6. Open **Settings → Devices & services → Add integration → Optim Energy**.
7. Enter the first client or site name.
8. Open **Administration → People** to add client administrators and users. Client administrators use **Setup → People** for their own client.

The integration replaces the known Optim Energy dashboards with the bundled layouts, repairs legacy dashboard resources, serves the portal assets and gives Home Assistant administrators an Administration console. Client accounts still land on their location picker.

## Updates

Marketplace creates an update entity for Optim Energy. An update replaces the integration files and requires a Home Assistant restart. Client settings live in the tenancy store and are not replaced by a package update.

Back up `.storage/optim_energy.tenancy`, `.storage/auth` and `.storage/lovelace*` before changing versions. Keep a VM snapshot for testing private Home Assistant hooks.

## Development checks

```bash
make test
make test-runtime
make test-scale
make test-browser
```

`make test` runs the dependency-free Python and JavaScript checks. `make
test-runtime` starts an isolated official Home Assistant container using the
exact image tag in `tests/runtime/HA_VERSION`, configures the integration and
tests the real auth store, registries, REST middleware and websocket dispatch.
`make test-scale` runs the three-client, 360-entity lifecycle profile.
`make test-browser` uses Playwright against a disposable runtime for the
client-switch, client-administrator and checked tree-price UI flows.
Update that version file when the supported Home Assistant release changes.

The private auth-store and websocket interfaces must also be exercised on the
pinned Home Assistant test VM for every supported release with
`tools/vm_smoke.sh`.

Production backup, restore, deletion, retention, quota, upgrade and emergency
recovery procedures are in
[docs/PRODUCTION_OPERATIONS.md](docs/PRODUCTION_OPERATIONS.md).

This is not an official Home Assistant integration.

## License

Copyright 2026 Optimal Industries.

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the
full license text.
