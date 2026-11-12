# Changelog

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
