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
