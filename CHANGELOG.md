# Changelog

## 0.8.1

- Device inbox: devices behind a bridge (Zigbee2MQTT and similar) are listed on their own again. In 0.8.0 they were shown as part of the bridge whenever the bridge itself looked like a portal device, which hid them. Only channels of a multi-channel device (same manufacturer, same place as their parent) are shown with their parent.
- Stop using `DeviceEntry.config_entries`, which Home Assistant has deprecated.

## 0.8.0

Device inbox for Home Assistant administrators. Needs the floor and area model (0.7.0 migration).

- Administration → Devices lists every Home Assistant device from any integration: its model and integration, what it looks like (energy meter, relay, socket, light, AC) and the entity that shows it, and its client, location and group or "Not assigned yet".
- Filter by status with counts and search by name, model, integration or client.
- One assign dialog (client, location, group) for a single device or several selected at once; "Remove from client"; "Ignore" for bridges, coordinators and other devices that never go to a client.
- The previous table for parent wiring, main devices and virtual devices is kept under "Wiring and main devices", and now also offers devices from other integrations.
- Devices are recognised by what their entities are, not by integration or entity names. Diagnostic and configuration entities do not count.
- The client portal reads power, energy and on/off for devices of other integrations by device class. Zigbee2MQTT and Shelly devices are read as before. A device still needs both a power and an energy sensor to appear in the portal.
- "Connection dropped" from the Zigbee bridge now applies only to Zigbee devices.
- A device cannot leave a client while one of that client's sums, schedules or alert rules still uses it; the refusal names what to change first. Moving a device to another location clears it as the old location's main device.
- People search in Administration keeps the cursor in the box while typing.

## 0.7.1

- Fix the entity list a Home Assistant administrator gets when viewing one client after the switch to floors and areas: it held only the entities that have no device, so Administration and client previews were missing device readings. Client accounts were not affected.

## 0.7.0

Adds a new placement model, switched on once by a Home Assistant administrator. Installing this version changes nothing until then.

- New model: a client is a Home Assistant floor, a location is one area on that floor, and groups live in the portal. A device's location is its area, so giving a device that area in Home Assistant's own add-device flow assigns it, for any integration.
- `optim_energy/migration/plan` reports what the switch would change; `optim_energy/migration/apply` performs it once. Location ids do not change, so people, prices, main devices and schedules keep their locations. Old labels and areas are kept, and the previous store is saved as `optim_energy.tenancy_before_areas`.
- After the switch each location's permission group covers exactly its area. Sum sensors are visible only in the location of their virtual device; before, every location of a client could see all of that client's sums.
- New commands for the new model: `location/save`, `location/delete`, `group/save`, `group/delete`, `device/assign`. A Home Assistant administrator can move any device anywhere or remove it from a client; a client administrator can only move its own devices within its own client and manage its own groups.
- Administration uses these commands once switched: a Groups panel per location and "Remove from client" on devices. "Move location to another client" is not available in the new model yet.
- Administration no longer loses what was typed into an open form when a background refresh arrives.
- `tools/migration_dry_run.py` runs the same plan offline against a configuration folder.

## 0.6.0

Security release for shared instances. Install it before adding a second client.

- A client administrator's settings save now changes prices only, for its own locations. Places, device placement, wiring, main devices, virtual devices, sums and automations are written only by a Home Assistant administrator or by the server's own checked commands. Previously a client administrator could submit another client's device, area or entity and gain access to it.
- Alert-rule helpers and automations are recorded per client when the portal creates them, and only the client that created one can change or delete it. Existing schedules are assigned to their client on first start.
- Deleting a helper needs a client-administrator role, and deleting a sum can only remove a group helper. Previously the stored settings could name any integration for removal.
- The alert notification template no longer accepts free text.
- The websocket and REST guards are installed before tenant data loads, so a failed start leaves client accounts denied.
- Client administrators can no longer change or delete Home Assistant administrators. A Home Assistant administrator can edit people of any client.
- Wiring, main-device and virtual-device controls are shown to Home Assistant administrators only (use Administration → Devices).
- Administration: delete buttons show "Confirm delete" on the row being deleted, deleting a virtual device asks for confirmation, and editing a client administrator keeps the role.
- Device names and models are escaped in the device drawer.
- `docs/CAPABILITIES.md` lists which role may call each command.

## 0.5.8

- Apply administrator sidebar cleanup server-side, so stale client Home and Locations panels are removed for every HA administrator before login.

## 0.5.7

- Set the default dashboard per account: Home Assistant administrators land on Administration and no longer see the client Home tab, while tenant accounts keep their Home landing page.

## 0.5.6

- Fix Administration location device counts for real MQTT meters that sit below a bridge; only Shelly meter channels are folded into their parent device.

## 0.5.5

- Split device placement in Administration into separate Location and Group columns; the previous Location column incorrectly showed the group or area name.

## 0.5.4

- Keep bridge and radio service devices out of the unassigned-device administrator list while retaining unassigned metered devices.

## 0.5.3

- Show unassigned portal-capable devices in Administration → Devices, including an unassigned count, so new Shelly and MQTT devices can be placed before they have a Home Assistant area.

## 0.5.2

- Make Home Assistant's default landing page a neutral Home panel so the default panel cannot pin Administration or Locations in a tenant sidebar.
- Enforce Administration as an administrator-only dashboard and persist tenant sidebar preferences server-side before login.
- Keep single-location users on Overview with no Locations tab, while administrators continue to land on Administration.

## 0.5.1

- Remove the unused legacy administrator card implementation while retaining the table-first console.

## 0.5.0

- Replace the administrator card dashboard with a table-first console for clients, locations, people and devices, with create/edit/delete actions in place.
- Add client renaming and platform-level location, device, virtual-device, main-device and device-tree management.
- Support multiple locations per ordinary user; scope labels, trees and auth groups to all assigned locations.
- Hide the Locations chooser for single-location users and preselect their only location.

## 0.4.6

- Clear stale sidebar hiding state for restored native add-on panels so File editor and Zigbee2MQTT appear for administrators again.

## 0.4.5

- Allow a validated Supervisor ingress-session capability through the REST guard and restore File editor and Zigbee2MQTT to the administrator sidebar.

## 0.4.4

- Add native add-on launchers for File editor and Zigbee2MQTT on the configured local Home Assistant URL, and keep their public ingress panels out of the administrator sidebar.

## 0.4.3

- Fix the administrator Preview client view action and cover it in browser acceptance.

## 0.4.2

- Polish the Administration directory layouts: align person controls on one row and remove duplicate client/person actions.

## 0.4.1

- Make the administrator console the system default and redirect client accounts to their location picker so the client Overview cannot remain pinned in an administrator's sidebar.

## 0.4.0

- Give Home Assistant owners and administrators a separate Administration console with overview, clients, locations and people views instead of the client portal.
- Redesign People management with client context, role/location controls, search and a focused add-person flow.
- Keep client-facing dashboards and Setup for client administrators while hiding them from administrators' sidebar.

## 0.3.1

- Preserve `name_by_user`, model metadata and device relationships in the tenant-filtered registry so portal names, device types and switch detection remain correct.

## 0.3.0

- Promote shared-instance multitenancy after REST, webhook and ingress hardening.
- Add checked client-administrator operations and the awaited client-switch fix.
- Add pinned Home Assistant runtime acceptance, three-client scale/lifecycle tests and VM smoke coverage.
- Add bill-reader quotas, audit-mode controls, versioned client deletion and production operations runbooks.

## 0.3.0-rc.2

- Block webhook and Supervisor ingress routes unless the caller presents a root bearer token.
- Add direct-network REST isolation acceptance checks and the HA2 verification record.

## 0.3.0-rc.1

- Combined release candidate for shared-instance multitenancy, checked client-admin operations and the client-switch context fix.

## 0.2.18

- Combine checked client-administrator operations with the awaited client-switch context fix for release validation.

## 0.2.17

- Make client switching await the complete tenant context and discard stale user-list responses.

## 0.2.16

- Allow server-created schedule and helper entities to be placed before their new permission group refreshes.

## 0.2.15

- Add checked client-admin commands for entity/device updates and portal-owned schedules.
- Add server-owned threshold, Sum and alert automation commands.

## 0.2.14

- Allow the frontend panel, theme and translation bootstrap commands.

## 0.2.13

- Allow the frontend system-state subscription required for portal startup.

## 0.2.12

- Allow the read-only service catalog used by frontend controls.

## 0.2.11

- Allow read-only frontend theme, translation, panel and UI event commands.

## 0.2.10

- Return current user and tenant-filtered entity registry data used by frontend bootstrap.

## 0.2.9

- Allow Home Assistant's default-dashboard config command so tenant panels render.

## 0.2.8

- Allow the frontend user-data subscription used by theme and profile UI state.

## 0.2.7

- Return an empty repairs list to tenant frontends instead of leaking global repair issues or blocking startup.

## 0.2.6

- Allow the read-only recorder metadata command required by the frontend bootstrap.

## 0.2.5

- Return area ids in filtered registry responses and log denied websocket commands for tenant UI tuning.

## 0.2.4

- Iterate the Home Assistant device registry through its supported public iteration path.

## 0.2.3

- Add explicit client assignment of native location labels and fix the floor registry API.
- Move dashboard template loading off the event loop.

## 0.2.2

- Correctly map the server root identity into the portal frontend.

## 0.2.1

- Install the REST guard into Home Assistant's already-frozen aiohttp middleware chain.

## 0.2.0

- Add a persistent multi-client tenant store and migrate `device_tree` out of Lovelace.
- Generate fail-closed Home Assistant auth groups from client ownership.
- Add the checked websocket API, tenant websocket firewall and REST guard.
- Add portal roles for root, client administrator and location-scoped user.
- Add Setup → People for tenant user administration and root client creation.
- Add client switching for the Home Assistant administrator.
- Route bill reading through a checked server command instead of exposing `rest_command` to tenants.
- Add tenant tree filtering and security-policy unit tests.

## 0.1.0

- Initial internal preview package with bundled dashboards and frontend assets.
