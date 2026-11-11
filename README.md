# Optim Energy

Optim Energy is a Home Assistant portal package for commercial energy monitoring, controls, alerts and reports.

## What it installs

- The Optim Energy building, controls, alerts and report cards.
- Eight replacement Home Assistant dashboards:
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

- A Home Assistant owner or administrator is the global root.
- A client administrator is a portal role. It is never added to Home Assistant's global `Administrators` group.
- An ordinary client user is assigned to one location.
- Authentication groups are generated from the client's areas and entities for Home Assistant's native state, history and entity-service filtering.
- A websocket firewall allows only the portal command surface and checks history, statistics and logbook requests against the tenant.
- Raw REST API access, templates, Assist, arbitrary services and native configuration commands remain outside the client surface.
- Webhook IDs and Supervisor ingress routes do not carry tenant identity. They are blocked unless the request presents a valid Home Assistant root bearer token.
- Client portal settings live in `.storage/optim_energy.tenancy`, not in a dashboard document.

Create users under **Setup → People**. A client administrator can create, disable, move and delete ordinary users inside its own client. Only the Home Assistant administrator can create clients or client administrators.

The following remain shared: the recorder database, backups, logs, `/local` files, restarts and Home Assistant updates. Do not use this as a hostile-tenant boundary or expose secrets in shared files. For strict isolation, use one Home Assistant instance per client. Do not enable generic or companion-app webhooks, and do not expose add-on ingress, on a shared instance unless every caller is trusted to use the global root identity.

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
8. Open **Setup → People** to add client administrators and users.

The integration replaces the known Optim Energy dashboards with the bundled layouts, repairs legacy dashboard resources, migrates the old `device_tree` into the tenant store, serves the portal assets and sets Locations as the first page.

## Updates

Marketplace creates an update entity for Optim Energy. An update replaces the integration files and requires a Home Assistant restart. Client settings live in the tenancy store and are not replaced by a package update.

Back up `.storage/optim_energy.tenancy`, `.storage/auth` and `.storage/lovelace*` before changing versions. Keep a VM snapshot for testing private Home Assistant hooks.

## Development checks

```bash
make test
```

The tests cover the package, frontend helpers, tenant tree filtering and websocket policy decisions. The private auth-store and websocket interfaces must also be exercised on the pinned Home Assistant test VM for every supported release.

This is not an official Home Assistant integration.
