# Changelog

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
