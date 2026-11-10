# Optim Energy

Optim Energy is our Home Assistant portal package for commercial energy monitoring, controls, alerts and reports.

This repository is the **0.1.0 internal preview**. It packages the existing Optim Energy portal as one Home Assistant integration and creates its dashboards automatically on a clean installation.

## What it installs

- The Optim Energy building, controls, alerts and report cards.
- Eight Home Assistant dashboards:
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

Existing dashboards with the same URL paths are never overwritten.

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

The integration creates the dashboards and serves the portal assets.

## Updates

Marketplace creates an update entity for Optim Energy. An update replaces the integration files and requires a Home Assistant restart. Client settings and dashboards are stored separately and are not replaced by the package update.

## Development checks

```bash
make test
```

## Scope

The integration currently packages and installs the portal. It does not yet migrate existing client settings out of the dashboard `device_tree` or bundle the bill-reading provider configuration.

This is not an official Home Assistant integration.
