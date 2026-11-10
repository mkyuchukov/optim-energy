# Optim Energy

Optim Energy is our Home Assistant portal package for commercial energy monitoring, controls, alerts and reports.

This repository is the **0.1.0 internal preview**. It packages the existing Optim Energy portal as one Home Assistant integration and creates its dashboards automatically on a clean installation.

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
  - Setup
- A first-run form asking for the client or site name.
- A local static asset route for the bundled JavaScript and bill-reader settings.

The known Optim Energy dashboards are replaced with the bundled package layout. Their existing `device_tree` is carried over so locations, groups, main meters and prices are not lost. Old manually installed Optim Energy dashboard resources are removed. Client accounts see only the Optim Energy panels; the default Home Assistant dashboard and other panels are hidden for those accounts. Administrator accounts keep the normal Home Assistant tools.

## Requirements

- Home Assistant OS or Supervised
- Home Assistant 2026.11 or newer
- Home Assistant Marketplace enabled

## Install from a custom repository

Once this repository is published:

1. Open **Settings → Marketplace**.
2. Open the menu and select **Add from link**.
3. Add the repository URL.
4. Install **Optim Energy**.
5. Open **Settings → Devices & services → Add integration → Optim Energy**.
6. Enter the client or site name.
7. Create a non-admin account for the client.

The integration replaces the known Optim Energy dashboards with the bundled layouts, removes legacy portal resources, serves the portal assets and sets Locations as the first page. Non-admin accounts see only the Optim Energy panels; administrator accounts keep Home Assistant maintenance tools.

## Updates

Marketplace creates an update entity for Optim Energy. An update replaces the integration files and requires a Home Assistant restart. Client settings and dashboards are stored separately and are not replaced by the package update.

## Development checks

```bash
make test
```

## Scope

The integration currently packages and installs the portal. It does not yet migrate existing client settings out of the dashboard `device_tree` or bundle the bill-reading provider configuration.

This is not an official Home Assistant integration.
