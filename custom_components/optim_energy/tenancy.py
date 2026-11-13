"""Tenant model and portal commands for Optim Energy.

The integration intentionally keeps the tenant model outside Lovelace.  A
Lovelace dashboard is editable data, not an authorization boundary.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import logging
import re
import time
import uuid
from collections.abc import Iterable
from typing import Any

import probatio
from homeassistant.auth.models import Group, User
from homeassistant.auth.permissions.const import POLICY_CONTROL, POLICY_EDIT, POLICY_READ
from homeassistant.components import websocket_api
from homeassistant.components.websocket_api import ActiveConnection
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import (
    area_registry as ar,
    device_registry as dr,
    entity_registry as er,
    floor_registry as fr,
    label_registry as lr,
)
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.storage import Store

from .const import DOMAIN
from .dashboards import default_device_tree
from .quota import BillReadLimitExceeded, BillReadQuota

_LOGGER = logging.getLogger(__name__)

STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}.tenancy"
# The store as it was just before the move to "floor = client, area = location".
MODEL = "areas"  # a client is a floor, a location is an area; the only model there is
MANAGED_GROUP_PREFIX = f"{DOMAIN}_"
DEFAULT_CLIENT = "default"
MAX_TREE_BYTES = 2 * 1024 * 1024
_NAME_TAKEN = 'Home Assistant already has an area called "{}". Choose another name.'
ROLE_CLIENT_ADMIN = "client_admin"
ROLE_USER = "user"
ROLE_ADMIN = "admin"

_TREE_KEYS = (
    "main",
    "mains",
    "parents",
    "virtual",
    "known",
    "places",
    "placed",
    "automations",
    "alarms",
    "kept",
    "kinds",
    "notify",
    "sums",
    "prices",
)


def _slug(value: str) -> str:
    """Return a stable, URL-friendly client id."""
    value = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return value or "client"


def _managed_group_id(kind: str, key: str) -> str:
    """Return a deterministic id for a group managed by this integration."""
    digest = hashlib.sha1(f"{kind}:{key}".encode(), usedforsecurity=False).hexdigest()[:14]
    return f"{MANAGED_GROUP_PREFIX}{kind}_{digest}"


def _copy_tree(tree: dict[str, Any] | None, site_name: str) -> dict[str, Any]:
    """Return a complete tree without sharing caller-owned data."""
    base = default_device_tree(site_name)
    if isinstance(tree, dict):
        base.update(copy.deepcopy(tree))
    return base


def _tree_places(tree: dict[str, Any]) -> list[dict[str, Any]]:
    places = tree.get("places")
    return [p for p in places if isinstance(p, dict)] if isinstance(places, list) else []


def _is_location_place(place: dict[str, Any]) -> bool:
    return place.get("kind") == "location"


def _place_descendants(tree: dict[str, Any], root: str) -> set[str]:
    """Return root and all places below it."""
    places = _tree_places(tree)
    out = {root}
    changed = True
    while changed:
        changed = False
        for place in places:
            pid = place.get("id")
            parent = place.get("parent")
            if pid and parent in out and pid not in out:
                out.add(pid)
                changed = True
    return out


def _location_of_place(tree: dict[str, Any], place_id: str | None) -> str | None:
    """Return the location a place sits in, or None if it is not in this tree."""
    places = {str(p.get("id")): p for p in _tree_places(tree)}
    seen: set[str] = set()
    while place_id and place_id not in seen:
        seen.add(place_id)
        place = places.get(place_id)
        if place is None:
            return None
        if _is_location_place(place):
            return place_id
        place_id = place.get("parent")
    return None


def _place_locations(tree: dict[str, Any]) -> list[dict[str, Any]]:
    return [p for p in _tree_places(tree) if _is_location_place(p) and p.get("id")]


def _place_name(tree: dict[str, Any], place_id: str) -> str:
    for place in _tree_places(tree):
        if place.get("id") == place_id:
            return str(place.get("name") or place_id)
    return place_id


def _record_locations(record: dict[str, Any] | None) -> list[str]:
    """Return all assigned locations, accepting the legacy single value."""
    if not isinstance(record, dict):
        return []
    raw = record.get("locations")
    if isinstance(raw, list):
        return list(dict.fromkeys(str(x) for x in raw if str(x)))
    location = record.get("location")
    return [str(location)] if location else []


def _filter_tree_for_location(tree: dict[str, Any], location: str) -> dict[str, Any]:
    """Return only the location a client user is allowed to see."""
    scoped = _copy_tree({}, _place_name(tree, location))
    allowed_places = _place_descendants(tree, location)
    places = [copy.deepcopy(p) for p in _tree_places(tree) if p.get("id") in allowed_places]
    if not any(p.get("id") == location for p in places):
        places.insert(0, {"id": location, "name": location, "kind": "location", "parent": None})
    allowed_devices = {
        str(device_id)
        for device_id, place in (tree.get("placed") or {}).items()
        if isinstance(place, str) and place in allowed_places
    }
    # Keep a virtual parent if one of its children is visible. The tree model
    # uses parent links as a second ownership relationship.
    parents = {
        str(k): str(v)
        for k, v in (tree.get("parents") or {}).items()
        if str(k) in allowed_devices or str(v) in allowed_devices
    }
    allowed_devices.update(parents)
    allowed_devices.update(parents.values())
    virtual = [
        copy.deepcopy(v)
        for v in tree.get("virtual") or []
        if isinstance(v, dict) and str(v.get("id")) in allowed_devices
    ]
    known = tree.get("known")
    scoped.update(
        {
            "places": places,
            "placed": {
                str(k): str(v)
                for k, v in (tree.get("placed") or {}).items()
                if str(k) in allowed_devices and v in allowed_places
            },
            "parents": parents,
            "virtual": virtual,
            "known": [x for x in known if str(x) in allowed_devices] if isinstance(known, list) else None,
            "mains": {location: tree.get("mains", {}).get(location)} if tree.get("mains", {}).get(location) else {},
            "main": tree.get("mains", {}).get(location),
            "prices": {location: copy.deepcopy(tree["prices"][location])} if location in (tree.get("prices") or {}) else {},
            "automations": [
                copy.deepcopy(x)
                for x in tree.get("automations") or []
                if isinstance(x, dict) and x.get("place") in allowed_places
            ],
            "alarms": [
                copy.deepcopy(x)
                for x in tree.get("alarms") or []
                if isinstance(x, dict) and (not x.get("place") or x.get("place") in allowed_places)
            ],
            "kinds": {
                str(k): v for k, v in (tree.get("kinds") or {}).items() if str(k) in allowed_devices
            },
            "kept": [x for x in tree.get("kept") or [] if str(x) in allowed_devices] if isinstance(tree.get("kept"), list) else tree.get("kept"),
            "notify": {
                str(k): v for k, v in (tree.get("notify") or {}).items() if str(k) in allowed_devices
            },
            "sums": {
                str(k): copy.deepcopy(v)
                for k, v in (tree.get("sums") or {}).items()
                if str(k) in allowed_devices
            },
        }
    )
    return scoped


def _filter_tree_for_locations(tree: dict[str, Any], locations: list[str]) -> dict[str, Any]:
    """Return the union of all locations assigned to a client user."""
    locations = list(dict.fromkeys(str(loc) for loc in locations if loc))
    if not locations:
        return _copy_tree({}, "No location assigned")
    if len(locations) == 1:
        return _filter_tree_for_location(tree, locations[0])

    scoped = _copy_tree({}, "Optim Energy")
    parts = [_filter_tree_for_location(tree, loc) for loc in locations]

    def merge_list(key: str, identity: str) -> list[Any]:
        out: list[Any] = []
        seen: set[str] = set()
        for part in parts:
            for item in part.get(key) or []:
                if not isinstance(item, dict):
                    continue
                marker = str(item.get(identity) or item.get("id") or item.get("entity") or "")
                if marker and marker in seen:
                    continue
                if marker:
                    seen.add(marker)
                out.append(copy.deepcopy(item))
        return out

    for key in ("placed", "parents", "mains", "prices", "kinds", "notify", "sums"):
        merged: dict[str, Any] = {}
        for part in parts:
            value = part.get(key)
            if isinstance(value, dict):
                merged.update(copy.deepcopy(value))
        scoped[key] = merged
    scoped.update(
        {
            "places": merge_list("places", "id"),
            "virtual": merge_list("virtual", "id"),
            "known": [x for part in parts for x in (part.get("known") or [])],
            "kept": [x for part in parts for x in (part.get("kept") or [])],
            "automations": merge_list("automations", "entity"),
            "alarms": merge_list("alarms", "id"),
            "main": None,
        }
    )
    for key in ("known", "kept"):
        scoped[key] = list(dict.fromkeys(str(x) for x in scoped[key])) if scoped[key] else scoped[key]
    return scoped


def _guard_tree(tree: dict[str, Any]) -> dict[str, Any]:
    """Validate the portable shape of a tree before it reaches storage."""
    if not isinstance(tree, dict):
        raise HomeAssistantError("Dashboard settings must be an object")
    clean = {key: copy.deepcopy(tree.get(key)) for key in _TREE_KEYS if key in tree}
    if "places" in clean and not isinstance(clean["places"], list):
        raise HomeAssistantError("Places must be a list")
    if "placed" in clean and not isinstance(clean["placed"], dict):
        raise HomeAssistantError("Placed devices must be an object")
    if "parents" in clean and not isinstance(clean["parents"], dict):
        raise HomeAssistantError("Device wiring must be an object")
    if len(repr(clean)) > MAX_TREE_BYTES:
        raise HomeAssistantError("Dashboard settings are too large")
    return clean


# The only tree key a client administrator may write. Everything else in the
# tree decides permissions or ownership, so it is written by root or by the
# checked server commands, never taken from a tenant browser.
_ENTITY_ID_RE = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")
_MAX_PRICE_DEPTH = 4


def _plain_json(value: Any, depth: int = 0) -> bool:
    """Return whether value is small, plain JSON data."""
    if value is None or isinstance(value, (bool, int, float)):
        return True
    if isinstance(value, str):
        return len(value) <= 300
    if depth >= _MAX_PRICE_DEPTH:
        return False
    if isinstance(value, list):
        return len(value) <= 200 and all(_plain_json(x, depth + 1) for x in value)
    if isinstance(value, dict):
        return len(value) <= 40 and all(
            isinstance(k, str) and len(k) <= 60 and _plain_json(v, depth + 1)
            for k, v in value.items()
        )
    return False


def _guard_prices(prices: Any, locations: set[str]) -> dict[str, Any]:
    """Validate the price settings a client administrator sends."""
    if not isinstance(prices, dict):
        raise HomeAssistantError("Prices must be an object")
    clean: dict[str, Any] = {}
    for location, price in prices.items():
        if location not in locations:
            raise HomeAssistantError("A price is set for a location outside this tenant")
        if not isinstance(price, dict) or not _plain_json(price):
            raise HomeAssistantError("Price settings are not valid")
        sensor = price.get("sensor")
        # The sensor is only ever read by the browser with the caller's own
        # permissions, so its shape is all that needs checking here.
        if sensor is not None and not (isinstance(sensor, str) and _ENTITY_ID_RE.match(sensor)):
            raise HomeAssistantError("The price sensor is not valid")
        clean[str(location)] = copy.deepcopy(price)
    return clean


def _client_tree_update(
    stored: dict[str, Any], incoming: Any, locations: set[str]
) -> dict[str, Any]:
    """Apply what a client administrator may change to the stored tree."""
    if not isinstance(incoming, dict):
        raise HomeAssistantError("Dashboard settings must be an object")
    clean = copy.deepcopy(stored)
    if "prices" in incoming:
        clean["prices"] = _guard_prices(incoming["prices"], locations)
    return clean


_POWER_UNITS = {"W", "kW", "mW", "MW"}
_ENERGY_UNITS = {"Wh", "kWh", "MWh"}


def device_kind(entities: Iterable[dict[str, Any]]) -> tuple[str | None, str]:
    """Say what a device is for the portal, and which entity gave it away.

    It works on what the entities are (their domain, device class and unit),
    not on which integration made them or how they are named, so a device
    from any provider is recognised the same way. Diagnostic and
    configuration entities are ignored: a device is not a relay because it
    has a "restart" switch.
    """
    main = [
        e for e in entities
        if not e.get("entity_category") and not e.get("disabled_by") and not e.get("hidden_by")
    ]
    by_domain: dict[str, list[dict[str, Any]]] = {}
    for entity in main:
        by_domain.setdefault(str(entity["entity_id"]).partition(".")[0], []).append(entity)
    if by_domain.get("climate"):
        return "ac", f"climate entity {by_domain['climate'][0]['entity_id']}"
    if by_domain.get("light"):
        return "light", f"light entity {by_domain['light'][0]['entity_id']}"
    if by_domain.get("switch"):
        switch = by_domain["switch"][0]
        kind = "socket" if switch.get("device_class") == "outlet" else "relay"
        return kind, f"switch entity {switch['entity_id']}"
    for sensor in by_domain.get("sensor", []):
        measure = sensor.get("device_class")
        unit = sensor.get("unit")
        if measure in ("power", "energy") or unit in _POWER_UNITS or unit in _ENERGY_UNITS:
            what = measure or ("power" if unit in _POWER_UNITS else "energy")
            return "meter", f"{what} sensor {sensor['entity_id']}"
    return None, ""


def shown_with_parent(
    child_maker: str | None,
    parent_maker: str | None,
    parent_kind: str | None,
    child_place: Any,
    parent_place: Any,
) -> bool:
    """Whether a device is a channel of its parent rather than a device of its own.

    A three-phase meter reports each phase as a child device; those belong
    with the meter. A Zigbee plug is also a child, of its bridge, but it is
    its own device. The difference used here: a channel is made by the same
    manufacturer as its parent and sits where its parent sits.

    ponytail: a bridge whose own lamps share its brand would be folded if the
    bridge itself looked like a portal device; none does today. If one turns
    up, key this on the integration instead.
    """
    return bool(
        parent_kind
        and child_maker
        and child_maker == parent_maker
        and (child_place is None or child_place == parent_place)
    )


class TenancyManager:
    """Own the shared tenant store and keep it synchronized with HA auth."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.store: Store[dict[str, Any]] = Store(
            hass, STORAGE_VERSION, STORAGE_KEY, private=True, atomic_writes=True
        )
        self.data: dict[str, Any] = {}
        self._sync_lock = asyncio.Lock()
        self._sync_cancel = None
        self._unsubscribers: list[Any] = []

    def location_area(self, tree: dict[str, Any], location: str | None) -> str | None:
        """Return the Home Assistant area that is this location."""
        for place in _place_locations(tree):
            if place.get("id") == location:
                return place.get("area_id") or None
        return None

    def _area_index(self) -> dict[str, tuple[str, str]]:
        """Map every location area to its (client, location)."""
        return {
            str(place["area_id"]): (client_id, str(place["id"]))
            for client_id, tree in self.data.get("trees", {}).items()
            if isinstance(tree, dict)
            for place in _place_locations(tree)
            if place.get("area_id")
        }

    def _live_placed(self, tree: dict[str, Any]) -> dict[str, str]:
        """Where each device is: its area gives the location, the store its group.

        A stored group that belongs to another location is ignored, so a
        device moved in Home Assistant itself simply lands in its new
        location with no group.
        """
        device_ids = {device.id for device in dr.async_get(self.hass).devices}
        stored = {str(k): str(v) for k, v in (tree.get("placed") or {}).items()}
        area_loc = {
            str(place["area_id"]): str(place["id"])
            for place in _place_locations(tree)
            if place.get("area_id")
        }
        out = {k: v for k, v in stored.items() if k not in device_ids}
        for device in dr.async_get(self.hass).devices:
            location = area_loc.get(str(device.area_id)) if device.area_id else None
            if not location:
                continue
            group = stored.get(device.id)
            out[device.id] = group if group and _location_of_place(tree, group) == location else location
        return out

    @property
    def site_name(self) -> str:
        client = self.data.get("clients", {}).get(DEFAULT_CLIENT, {})
        return str(client.get("name") or "Optim Energy")

    async def async_initialize(self, site_name: str) -> None:
        """Load the store and create auth groups."""
        loaded = await self.store.async_load()
        changed = False
        if not isinstance(loaded, dict) or not loaded.get("clients"):
            self.data = {
                "version": STORAGE_VERSION,
                "clients": {
                    DEFAULT_CLIENT: {
                        "id": DEFAULT_CLIENT,
                        "name": site_name,
                        "slug": DEFAULT_CLIENT,
                        "created_at": time.time(),
                    }
                },
                "locations": {},
                "users": {},
                "trees": {DEFAULT_CLIENT: {**_copy_tree(None, site_name), "places": []}},
                "groups": {},
                "owned": {},
                "model": MODEL,
            }
            self.data["clients"][DEFAULT_CLIENT]["floor_id"] = self._create_floor(site_name)
            changed = True
        else:
            if loaded.get("model") != MODEL:
                # Raising here leaves the guards closed to every client account.
                raise HomeAssistantError(
                    "This installation still places devices by label. Install Optim Energy 0.11.1, "
                    "run the location migration under Administration, then upgrade again."
                )
            self.data = loaded
            changed = self._migrate()
            changed = self._sync_location_names() or changed
        self._refresh_location_index()
        if changed:
            await self.async_save()
        await self.async_sync_groups()
        self._install_registry_watchers()
        _LOGGER.info(
            "Optim Energy tenancy loaded: %d clients, %d assigned users",
            len(self.data.get("clients", {})),
            len(self.data.get("users", {})),
        )

    def _migrate(self) -> bool:
        """Bring an older local store up to the current schema."""
        changed = False
        if self.data.get("version") != STORAGE_VERSION:
            self.data["version"] = STORAGE_VERSION
            changed = True
        self.data.setdefault("clients", {})
        self.data.setdefault("locations", {})
        self.data.setdefault("users", {})
        self.data.setdefault("trees", {})
        self.data.setdefault("groups", {})
        if not isinstance(self.data.get("owned"), dict):
            self.data["owned"] = self._seed_owned()
            changed = True
        for client_id, client in list(self.data["clients"].items()):
            if not isinstance(client, dict):
                client = {"id": client_id, "name": str(client), "slug": client_id}
                self.data["clients"][client_id] = client
                changed = True
            client.setdefault("id", client_id)
            client.setdefault("slug", client_id)
            client.setdefault("name", client_id)
            if client.pop("labels", None) is not None:  # left over from the label model
                changed = True
            if not isinstance(self.data["trees"].get(client_id), dict):
                self.data["trees"][client_id] = _copy_tree(None, str(client["name"]))
                changed = True
        return changed

    def _seed_owned(self) -> dict[str, dict[str, list[str]]]:
        """Record the helpers and automations each client already has.

        ponytail: one-time trust of trees written before ownership moved to the
        server. From here on only the checked commands add to this map.
        """
        registry = er.async_get(self.hass)
        owned: dict[str, dict[str, list[str]]] = {}
        for client_id in self.data.get("clients", {}):
            tree = self.data.get("trees", {}).get(client_id)
            if not isinstance(tree, dict):
                continue
            visible = self._tree_visible_entities(client_id)
            entries: set[str] = set()
            automations: set[str] = set()
            for entity_id in visible:
                entry = registry.async_get(entity_id)
                if entry is not None and entry.platform == "threshold" and entry.config_entry_id:
                    entries.add(str(entry.config_entry_id))
            for item in tree.get("automations") or []:
                entry = registry.async_get(str(item.get("entity"))) if isinstance(item, dict) else None
                if entry is not None and entry.domain == "automation" and entry.unique_id:
                    automations.add(str(entry.unique_id))
            for entry in registry.entities.values():
                unique_id = str(entry.unique_id or "")
                if (
                    entry.domain == "automation"
                    and unique_id.startswith("portal_alert_")
                    and f"binary_sensor.{unique_id[13:]}" in visible
                ):
                    automations.add(unique_id)
            owned[client_id] = {"entries": sorted(entries), "automations": sorted(automations)}
        return owned

    def owns(self, client_id: str, kind: str, value: str) -> bool:
        """Return whether a helper entry or automation id belongs to a client."""
        return bool(value) and value in self.data.get("owned", {}).get(client_id, {}).get(kind, [])

    async def async_set_owned(self, client_id: str, kind: str, value: str, present: bool) -> None:
        """Add or drop one owned helper entry or automation id, and persist it."""
        record = self.data.setdefault("owned", {}).setdefault(
            client_id, {"entries": [], "automations": []}
        )
        values = set(record.setdefault(kind, []))
        if present:
            values.add(value)
        else:
            values.discard(value)
        record[kind] = sorted(values)
        await self.async_save()

    def _refresh_location_index(self) -> None:
        """Rebuild the UI index of locations from the client trees."""
        self.data["locations"] = {
            str(place["id"]): {
                "id": str(place["id"]),
                "name": str(place.get("name") or place["id"]),
                "client": client_id,
                "area_id": place.get("area_id"),
            }
            for client_id, tree in self.data.get("trees", {}).items()
            if isinstance(tree, dict)
            for place in _place_locations(tree)
        }

    async def async_save(self) -> None:
        """Persist the tenant store now."""
        self._refresh_location_index()
        await self.store.async_save(self.data)

    def is_root(self, user: User) -> bool:
        """Return whether the user is a real Home Assistant administrator."""
        return bool(user.is_admin or user.is_owner)

    def user_record(self, user: User) -> dict[str, Any] | None:
        """Return the assignment for a human user."""
        record = self.data.get("users", {}).get(user.id)
        return record if isinstance(record, dict) else None

    def role(self, user: User) -> str | None:
        """Return the portal role for a user."""
        if self.is_root(user):
            return ROLE_ADMIN
        record = self.user_record(user)
        if not record:
            return None
        role = record.get("role")
        return role if role in (ROLE_CLIENT_ADMIN, ROLE_USER) else None

    def context(self, user: User, requested_client: str | None = None) -> dict[str, Any]:
        """Return the effective security context for a user."""
        root = self.is_root(user)
        record = self.user_record(user) or {}
        role = self.role(user)
        client_id = requested_client if root and requested_client else record.get("client")
        if root and not client_id:
            client_id = next(iter(self.data.get("clients", {})), DEFAULT_CLIENT)
        client = self.data.get("clients", {}).get(client_id, {}) if client_id else {}
        assigned_locations = [] if root else _record_locations(record)
        return {
            "user_id": user.id,
            "user_name": user.name,
            "is_root": root,
            "role": role,
            "client": client_id,
            "client_name": client.get("name"),
            "location": assigned_locations[0] if assigned_locations else None,
            "locations": assigned_locations,
        }

    def require_client(self, connection: ActiveConnection, requested: str | None = None) -> tuple[str, dict[str, Any]]:
        """Resolve and authorize the client for a command."""
        ctx = self.context(connection.user, requested)
        if not ctx["client"]:
            raise HomeAssistantError("This account is not assigned to a tenant")
        if ctx["client"] not in self.data.get("clients", {}):
            raise HomeAssistantError("Tenant not found")
        return ctx["client"], ctx

    def can_manage_tree(self, ctx: dict[str, Any]) -> bool:
        return bool(ctx.get("is_root") or ctx.get("role") == ROLE_CLIENT_ADMIN)

    async def async_sync_sidebar(self, user: User) -> None:
        """Apply the account's landing page and sidebar before its next load."""
        if user.system_generated:
            return
        ctx = self.context(user)
        from .sidebar import (
            async_sync_admin_sidebar,
            async_sync_default_panel,
            async_sync_user_sidebar,
        )

        try:
            # A per-account default is required because Home Assistant always
            # keeps the default panel in the sidebar. Administrators therefore
            # land on Administration without a client Home tab being pinned.
            await async_sync_default_panel(
                self.hass,
                user.id,
                "energy-admin" if ctx["is_root"] else "energy-start",
            )
            if ctx["is_root"]:
                await async_sync_admin_sidebar(self.hass, user.id)
                return
            await async_sync_user_sidebar(
                self.hass,
                user.id,
                ctx.get("role"),
                ctx.get("locations") or [],
                manage_tree=self.can_manage_tree(ctx),
            )
        except Exception:
            # Presentation must never break account creation, role changes or
            # integration startup.
            _LOGGER.warning(
                "Could not update Optim Energy frontend preferences for %s",
                user.id,
                exc_info=True,
            )

    async def async_sync_all_sidebars(self) -> None:
        """Refresh sidebar preferences for every non-admin account."""
        for user in await self.hass.auth.async_get_users():
            await self.async_sync_sidebar(user)

    def tree_for(self, user: User, requested_client: str | None = None) -> dict[str, Any]:
        """Return the tree visible to one connection user."""
        client_id, ctx = self.require_client_value(user, requested_client)
        tree = copy.deepcopy(self.data.get("trees", {}).get(client_id, _copy_tree(None, "Optim Energy")))
        tree["placed"] = self._live_placed(tree)
        payload = {
            "client": client_id,
            "client_name": ctx["client_name"],
            "role": ctx["role"],
            "model": MODEL,  # ponytail: only for a browser tab still running pre-0.12 code; drop later
        }
        if ctx["is_root"] or ctx["role"] == ROLE_CLIENT_ADMIN:
            return {**payload, "tree": copy.deepcopy(tree)}
        locations = ctx.get("locations") or []
        if not locations:
            return {**payload, "tree": _copy_tree({}, "No location assigned")}
        return {**payload, "tree": _filter_tree_for_locations(tree, locations)}

    def require_client_value(self, user: User, requested: str | None = None) -> tuple[str, dict[str, Any]]:
        """Resolve a client without a websocket connection."""
        ctx = self.context(user, requested)
        if not ctx["client"] or ctx["client"] not in self.data.get("clients", {}):
            raise HomeAssistantError("This account is not assigned to a tenant")
        return str(ctx["client"]), ctx

    async def async_save_tree(self, user: User, requested_client: str | None, tree: dict[str, Any]) -> dict[str, Any]:
        """Save a client tree after checking the caller's portal role."""
        client_id, ctx = self.require_client_value(user, requested_client)
        if not self.can_manage_tree(ctx):
            raise HomeAssistantError("Only a tenant admin can change the dashboard")
        if ctx["is_root"]:
            clean = _guard_tree(tree)
            # Locations and groups change only through their own commands,
            # so a stale browser tab cannot drop a location's area.
            clean["places"] = copy.deepcopy(self.data["trees"].get(client_id, {}).get("places") or [])
        else:
            locations = {
                str(location_id)
                for location_id, entry in self.data.get("locations", {}).items()
                if entry.get("client") == client_id
            }
            stored = self.data["trees"].get(client_id) or _copy_tree(None, str(ctx["client_name"] or client_id))
            clean = _client_tree_update(stored, tree, locations)
        return await self.async_store_tree(client_id, clean)

    async def async_store_tree(self, client_id: str, tree: dict[str, Any]) -> dict[str, Any]:
        """Store a tree built by root or by a checked server command."""
        if client_id not in self.data.get("clients", {}):
            raise HomeAssistantError("Tenant not found")
        self.data["trees"][client_id] = _guard_tree(tree)
        self._refresh_location_index()
        await self.async_save()
        self._schedule_group_sync()
        return {"client": client_id, "saved": True}

    # ---- floor = client, area = location ------------------------------------

    def _create_floor(self, name: str) -> str:
        registry = fr.async_get(self.hass)
        for candidate in (name, f"{name} (client)", f"{name} (client {uuid.uuid4().hex[:4]})"):
            try:
                return registry.async_create(candidate).floor_id
            except ValueError:
                continue
        raise HomeAssistantError("Could not create a floor for the tenant")

    def _create_area(self, name: str, floor_id: str | None) -> str:
        # A location has one name, its area's. Home Assistant wants every area name to be different.
        try:
            return ar.async_get(self.hass).async_create(name, floor_id=floor_id).id
        except ValueError as err:
            raise HomeAssistantError(_NAME_TAKEN.format(name)) from err

    def _sync_location_names(self) -> bool:
        """Give every location the name its area has in Home Assistant. True when one changed."""
        registry = ar.async_get(self.hass)
        changed = False
        for tree in self.data.get("trees", {}).values():
            for place in _place_locations(tree) if isinstance(tree, dict) else []:
                area = registry.async_get_area(place["area_id"]) if place.get("area_id") else None
                if area is not None and place.get("name") != area.name:
                    place["name"] = area.name
                    changed = True
        return changed

    @callback
    def _area_changed(self, _event: Any = None) -> None:
        # An area renamed in Home Assistant renames its location.
        if self._sync_location_names():
            self._refresh_location_index()
            self.hass.async_create_task(self.async_save())

    def _manager_client(self, user: User, client: str | None) -> tuple[str, dict[str, Any], dict[str, Any]]:
        """Resolve the stored tree a root or client administrator may change."""
        client_id, ctx = self.require_client_value(user, client)
        if not self.can_manage_tree(ctx):
            raise HomeAssistantError("Only a tenant admin can change this")
        return client_id, ctx, self.data["trees"][client_id]

    async def _async_saved(self) -> None:
        self._refresh_location_index()
        await self.async_save()
        await self.async_sync_groups()

    async def async_save_location(
        self, user: User, client: str | None, location_id: str | None, name: str
    ) -> dict[str, Any]:
        """Create or rename a location. Root only: a location decides who sees what."""
        if not self.is_root(user):
            raise HomeAssistantError("Only a Home Assistant administrator can change locations")
        client_id, _, tree = self._manager_client(user, client)
        name = name.strip()
        if not name or len(name) > 80:
            raise HomeAssistantError("Enter a location name of up to 80 characters")
        record = self.data["clients"][client_id]
        if location_id:
            place = next((p for p in _place_locations(tree) if p.get("id") == location_id), None)
            if place is None:
                raise HomeAssistantError("Location not found for this tenant")
            try:
                ar.async_get(self.hass).async_update(place["area_id"], name=name)
            except ValueError as err:
                raise HomeAssistantError(_NAME_TAKEN.format(name)) from err
            place["name"] = name
        else:
            if not record.get("floor_id"):
                record["floor_id"] = self._create_floor(str(record.get("name") or client_id))
            area_id = self._create_area(name, record["floor_id"])
            location_id = f"loc:{area_id}"
            tree.setdefault("places", []).append(
                {"id": location_id, "name": name, "kind": "location", "parent": None, "area_id": area_id}
            )
        await self._async_saved()
        await self.async_sync_all_sidebars()
        return {"client": client_id, "id": location_id, "name": name}

    async def async_delete_location(self, user: User, client: str | None, location_id: str) -> None:
        """Delete an empty location and its area."""
        if not self.is_root(user):
            raise HomeAssistantError("Only a Home Assistant administrator can change locations")
        client_id, _, tree = self._manager_client(user, client)
        area_id = self.location_area(tree, location_id)
        if not area_id:
            raise HomeAssistantError("Location not found for this tenant")
        if any(d.area_id == area_id for d in dr.async_get(self.hass).devices):
            raise HomeAssistantError("Move this location's devices somewhere else first")
        if any(
            record.get("client") == client_id and location_id in _record_locations(record)
            for record in self.data.get("users", {}).values()
        ):
            raise HomeAssistantError("Remove this location from its users first")
        inside = {str(p["id"]) for p in _tree_places(tree) if _location_of_place(tree, str(p.get("id"))) == location_id}
        tree["places"] = [p for p in _tree_places(tree) if str(p.get("id")) not in inside]
        tree["placed"] = {k: v for k, v in (tree.get("placed") or {}).items() if v not in inside}
        for key in ("prices", "mains"):
            if isinstance(tree.get(key), dict):
                tree[key].pop(location_id, None)
        ar.async_get(self.hass).async_delete(area_id)
        await self._async_saved()
        await self.async_sync_all_sidebars()

    async def async_move_location(
        self, user: User, client: str | None, location_id: str, target: str
    ) -> dict[str, Any]:
        """Hand a whole location, with its groups, devices and settings, to another client."""
        if not self.is_root(user):
            raise HomeAssistantError("Only a Home Assistant administrator can move locations")
        client_id, _, tree = self._manager_client(user, client)
        if target not in self.data.get("clients", {}) or target == client_id:
            raise HomeAssistantError("Choose another tenant to move the location to")
        area_id = self.location_area(tree, location_id)
        if not area_id:
            raise HomeAssistantError("Location not found for this tenant")
        if any(
            record.get("client") == client_id and location_id in _record_locations(record)
            for record in self.data.get("users", {}).values()
        ):
            raise HomeAssistantError("Remove this location from its users first; they belong to the old tenant")
        places = {str(p["id"]) for p in _tree_places(tree) if _location_of_place(tree, str(p.get("id"))) == location_id}
        placed = {str(k): str(v) for k, v in (tree.get("placed") or {}).items()}
        device_ids = {d.id for d in dr.async_get(self.hass).devices if d.area_id == area_id}
        moving = device_ids | {k for k, v in placed.items() if v in places}  # devices and virtual devices
        entity_ids = {e.entity_id for e in er.async_get(self.hass).entities.values() if e.device_id in device_ids}
        # Anything that ties the location to the rest of its client has to be undone first.
        parents = {str(k): str(v) for k, v in (tree.get("parents") or {}).items()}
        if any((k in moving) != (v in moving) for k, v in parents.items()):
            raise HomeAssistantError("Its wiring links devices in other locations; undo those links first")
        sums = tree.get("sums") or {}
        for virtual_id, kinds in sums.items():
            members = {m for part in (kinds or {}).values() if isinstance(part, dict) for m in part.get("members") or []}
            inside = str(virtual_id) in moving
            if (inside and not members <= entity_ids) or (not inside and members & entity_ids):
                raise HomeAssistantError("A virtual device adds up devices across locations; change it first")

        other = self.data["trees"][target]
        def take(key: str, keep: Any) -> None:
            source = tree.get(key)
            if isinstance(source, dict):
                moved = {k: v for k, v in source.items() if keep(k, v)}
                tree[key] = {k: v for k, v in source.items() if k not in moved}
                other[key] = {**(other.get(key) or {}), **moved}
            elif isinstance(source, list):
                moved = [x for x in source if isinstance(x, dict) and keep(x, None)]
                tree[key] = [x for x in source if x not in moved]
                other[key] = [*(other.get(key) or []), *moved]

        take("places", lambda place, _: str(place.get("id")) in places)
        take("placed", lambda k, v: v in places)
        take("parents", lambda k, v: k in moving)
        take("virtual", lambda item, _: str(item.get("id")) in moving)
        take("sums", lambda k, v: str(k) in moving)
        take("mains", lambda k, v: k == location_id)
        take("prices", lambda k, v: k == location_id)
        take("automations", lambda item, _: str(item.get("place")) in places)
        # Ownership of alert rules and schedules follows the devices they act on.
        owned = self.data.setdefault("owned", {})
        mine = owned.setdefault(client_id, {"entries": [], "automations": []})
        theirs = owned.setdefault(target, {"entries": [], "automations": []})
        registry = er.async_get(self.hass)
        gone = {str(item.get("entity")) for item in other.get("automations") or [] if isinstance(item, dict)}
        for key, belongs in (
            ("entries", lambda x: (getattr(self.hass.config_entries.async_get_entry(x), "options", None) or {}).get("entity_id") in entity_ids),
            ("automations", lambda x: any(e.unique_id == x and e.entity_id in gone for e in registry.entities.values())),
        ):
            moved = [x for x in mine.get(key, []) if belongs(x)]
            mine[key] = [x for x in mine.get(key, []) if x not in moved]
            theirs[key] = sorted({*theirs.get(key, []), *moved})
        record = self.data["clients"][target]
        if not record.get("floor_id"):
            record["floor_id"] = self._create_floor(str(record.get("name") or target))
        ar.async_get(self.hass).async_update(area_id, floor_id=record["floor_id"])
        await self._async_saved()
        await self.async_sync_all_sidebars()
        return {"location": location_id, "client": target, "devices": len(device_ids)}

    async def async_save_group(
        self, user: User, client: str | None, group_id: str | None, name: str, parent: str | None
    ) -> dict[str, Any]:
        """Create, rename or move a group. Moving it to another location takes its devices along."""
        client_id, _, tree = self._manager_client(user, client)
        name = name.strip()
        if not name or len(name) > 80:
            raise HomeAssistantError("Enter a group name of up to 80 characters")
        places = {str(p.get("id")): p for p in _tree_places(tree)}
        if group_id:
            group = places.get(group_id)
            if group is None or _is_location_place(group):
                raise HomeAssistantError("Group not found for this tenant")
            group["name"] = name
            parent = parent or group.get("parent")
        else:
            group_id = f"grp:{uuid.uuid4().hex[:10]}"
            group = {"id": group_id, "name": name, "kind": "group", "parent": None}
            tree.setdefault("places", []).append(group)
        location = _location_of_place(tree, parent)
        if not location:
            raise HomeAssistantError("Choose a location or group of this tenant to put it in")
        # A group cannot sit inside itself, and it stays in its own location.
        walk, seen = parent, set()
        while walk and walk not in seen:
            if walk == group_id:
                raise HomeAssistantError("A group cannot be placed inside itself")
            seen.add(walk)
            walk = places.get(walk, {}).get("parent")
        current = _location_of_place({"places": [*places.values()]}, group.get("parent"))
        if group.get("parent") and current and current != location:
            # The group goes to another location of the tenant, with its sub-groups and its devices.
            area_id = self.location_area(tree, location)
            if not area_id:
                raise HomeAssistantError("This location has no area yet")
            inside = _place_descendants(tree, group_id)
            moved = {str(k) for k, v in (tree.get("placed") or {}).items() if v in inside}
            mains = tree.get("mains") or {}
            if mains.get(current) in moved:
                mains.pop(current, None)
            registry = dr.async_get(self.hass)
            for device in list(registry.devices):
                if (device.id in moved or device.via_device_id in moved) and device.area_id != area_id:
                    registry.async_update_device(device.id, area_id=area_id)
        group["parent"] = parent
        await self._async_saved()
        return {"client": client_id, "id": group_id, "name": name, "parent": parent}

    async def async_delete_group(self, user: User, client: str | None, group_id: str) -> None:
        """Delete a group; its devices and sub-groups move up one level."""
        client_id, _, tree = self._manager_client(user, client)
        group = next((p for p in _tree_places(tree) if p.get("id") == group_id), None)
        if group is None or _is_location_place(group):
            raise HomeAssistantError("Group not found for this tenant")
        parent = group.get("parent")
        tree["places"] = [p for p in _tree_places(tree) if p.get("id") != group_id]
        for place in tree["places"]:
            if place.get("parent") == group_id:
                place["parent"] = parent
        tree["placed"] = {k: (parent if v == group_id else v) for k, v in (tree.get("placed") or {}).items()}
        for item in tree.get("automations") or []:
            if isinstance(item, dict) and item.get("place") == group_id:
                item["place"] = parent
        await self._async_saved()

    async def async_assign_device(
        self, user: User, client: str | None, device_id: str, place: str | None
    ) -> dict[str, Any]:
        """Put a device in a location or group, or (root) take it out of every client.

        Root may move a device anywhere. A client administrator may only move
        a device that is already in its client, to a place of its client.
        """
        client_id, ctx, tree = self._manager_client(user, client)
        registry = dr.async_get(self.hass)
        device = registry.async_get(device_id)
        if device is None:
            raise HomeAssistantError("Device not found")
        owner = self._area_index().get(str(device.area_id)) if device.area_id else None
        if not ctx["is_root"]:
            if owner is None or owner[0] != client_id:
                raise HomeAssistantError("Device belongs to another tenant")
            if not place:
                raise HomeAssistantError("Choose a location or group")
        location = _location_of_place(tree, place) if place else None
        if place and not location:
            raise HomeAssistantError("Choose a location or group of this tenant")
        area_id = self.location_area(tree, location) if location else None
        if place and not area_id:
            raise HomeAssistantError("This location has no area yet")
        leaving = bool(owner) and (owner[0] != client_id or not place)
        if leaving:
            blockers = self._leaving_blockers(owner[0], device_id)
            if blockers:
                raise HomeAssistantError(
                    "This device is still used by its tenant. First remove it from "
                    + "; ".join(blockers)
                )
        if owner and not leaving and owner[1] != location:
            # Changing location inside a client: it cannot stay the old location's main device.
            mains = tree.get("mains") or {}
            if mains.get(owner[1]) == device_id:
                mains.pop(owner[1], None)
        if leaving:
            # Leaving a client: drop what that client's settings said about it.
            old = self.data["trees"].get(owner[0], {})
            old["placed"] = {k: v for k, v in (old.get("placed") or {}).items() if k != device_id}
            old["parents"] = {
                k: v for k, v in (old.get("parents") or {}).items() if device_id not in (k, v)
            }
            old["mains"] = {k: v for k, v in (old.get("mains") or {}).items() if v != device_id}
            if old.get("main") == device_id:
                old["main"] = None
        placed = dict(tree.get("placed") or {})
        if place and place != location:
            placed[device_id] = place
        else:
            placed.pop(device_id, None)
        tree["placed"] = placed
        # Channels and other child devices follow their parent.
        for item in [device, *[d for d in registry.devices if d.via_device_id == device_id]]:
            if item.area_id != area_id:
                registry.async_update_device(item.id, area_id=area_id)
        await self._async_saved()
        return {"device_id": device_id, "client": client_id if place else None, "place": place}

    def _device_family(self, device_id: str) -> tuple[set[str], set[str]]:
        """Return a device with its channel devices, and all their entities."""
        device_ids = {device_id} | {
            d.id for d in dr.async_get(self.hass).devices if d.via_device_id == device_id
        }
        entity_ids = {
            e.entity_id for e in er.async_get(self.hass).entities.values() if e.device_id in device_ids
        }
        return device_ids, entity_ids

    def _leaving_blockers(self, client_id: str, device_id: str) -> list[str]:
        """Name what in a client still depends on a device that is about to leave it.

        A sum, schedule or alert that kept a device of another client would
        go on reading or switching it, so the move waits until they let go.
        """
        tree = self.data.get("trees", {}).get(client_id, {})
        _, entity_ids = self._device_family(device_id)
        out: list[str] = []
        names = {str(v.get("id")): str(v.get("name") or v.get("id")) for v in tree.get("virtual") or [] if isinstance(v, dict)}
        for virtual_id, kinds in (tree.get("sums") or {}).items():
            parts = kinds.values() if isinstance(kinds, dict) else []
            if any(isinstance(p, dict) and entity_ids.intersection(p.get("members") or []) for p in parts):
                out.append(f'the virtual device "{names.get(str(virtual_id), virtual_id)}"')
        owned = self.data.get("owned", {}).get(client_id, {})
        for entry_id in owned.get("entries", []):
            entry = self.hass.config_entries.async_get_entry(entry_id)
            if entry is not None and (entry.options or {}).get("entity_id") in entity_ids:
                out.append(f'the alert rule "{entry.title}"')
        mine = set(owned.get("automations", []))
        if mine:
            from homeassistant.components.automation import automations_with_entity

            registry = er.async_get(self.hass)
            seen: set[str] = set()
            for entity_id in entity_ids:
                for automation_id in automations_with_entity(self.hass, entity_id):
                    entry = registry.async_get(automation_id)
                    if entry is None or entry.unique_id not in mine or automation_id in seen:
                        continue
                    seen.add(automation_id)
                    state = self.hass.states.get(automation_id)
                    out.append(f'the schedule "{state.name if state else automation_id}"')
        return out

    def _device_integrations(self, device: Any) -> list[str]:
        """Name the integration a device comes from."""
        # Newer Home Assistant gives a device one config entry; older gave a set.
        entry_ids = [getattr(device, "config_entry_id", None)] if hasattr(device, "config_entry_id") else list(device.config_entries)
        entries = (self.hass.config_entries.async_get_entry(x) for x in entry_ids if x)
        return sorted({entry.domain for entry in entries if entry is not None})

    def device_inbox(self, user: User) -> list[dict[str, Any]]:
        """Every Home Assistant device with where it is and what it looks like. Root only."""
        if not self.is_root(user):
            raise HomeAssistantError("Only a Home Assistant administrator can list all devices")
        index = self._area_index()
        trees = self.data.get("trees", {})
        clients = self.data.get("clients", {})
        ignored = set(self.data.get("ignored", []))
        by_device: dict[str, list[dict[str, Any]]] = {}
        for entity in er.async_get(self.hass).entities.values():
            if not entity.device_id:
                continue
            state = self.hass.states.get(entity.entity_id)
            by_device.setdefault(entity.device_id, []).append(
                {
                    "entity_id": entity.entity_id,
                    "device_class": entity.device_class or entity.original_device_class,
                    "unit": state.attributes.get("unit_of_measurement") if state else None,
                    "entity_category": entity.entity_category,
                    "disabled_by": entity.disabled_by,
                    "hidden_by": entity.hidden_by,
                }
            )
        devices = list(dr.async_get(self.hass).devices)
        by_id = {d.id: d for d in devices}
        label_names = {x.label_id: x.name for x in lr.async_get(self.hass).async_list_labels()}
        kinds = {d.id: device_kind(by_device.get(d.id, [])) for d in devices}
        owner_of = {d.id: index.get(str(d.area_id)) if d.area_id else None for d in devices}
        out: list[dict[str, Any]] = []
        for device in devices:
            kind, why = kinds[device.id]
            owner = owner_of[device.id]
            parent = by_id.get(device.via_device_id) if device.via_device_id else None
            if parent is not None and shown_with_parent(
                device.manufacturer, parent.manufacturer, kinds[parent.id][0], owner, owner_of[parent.id]
            ):
                continue
            item: dict[str, Any] = {
                "id": device.id,
                "name": device.name_by_user or device.name or device.id,
                "model": " ".join(str(x) for x in (device.manufacturer, device.model) if x),
                "integrations": self._device_integrations(device),
                "kind": kind,
                "why": why,
                "entities": len(by_device.get(device.id, [])),
                "labels": sorted(str(label_names.get(x, x)) for x in (device.labels or ())),
                "client": None,
                "location": None,
                "group": None,
            }
            if owner:
                tree = trees.get(owner[0], {})
                place = (tree.get("placed") or {}).get(device.id)
                group = place if place and place != owner[1] and _location_of_place(tree, place) == owner[1] else None
                item.update(
                    status="assigned",
                    client=owner[0],
                    client_name=str(clients.get(owner[0], {}).get("name") or owner[0]),
                    location=owner[1],
                    location_name=_place_name(tree, owner[1]),
                    group=group,
                    group_name=_place_name(tree, group) if group else None,
                )
            elif device.id in ignored:
                item["status"] = "ignored"
            elif kind and not device.disabled_by and str(device.entry_type or "") != "service":
                item["status"] = "unassigned"
            else:
                item["status"] = "other"
            out.append(item)
        return sorted(out, key=lambda x: (x["status"] != "unassigned", str(x["name"]).casefold()))

    async def async_ignore_device(self, user: User, device_id: str, ignored: bool) -> dict[str, Any]:
        """Mark a device as not for clients (a bridge, a coordinator), or undo that."""
        if not self.is_root(user):
            raise HomeAssistantError("Only a Home Assistant administrator can ignore devices")
        device = dr.async_get(self.hass).async_get(device_id)
        if device is None:
            raise HomeAssistantError("Device not found")
        if ignored and device.area_id and str(device.area_id) in self._area_index():
            raise HomeAssistantError("Remove the device from its tenant first")
        current = set(self.data.get("ignored", []))
        (current.add if ignored else current.discard)(device_id)
        self.data["ignored"] = sorted(current)
        await self.async_save()
        return {"device_id": device_id, "ignored": ignored}

    def client_list(self, user: User) -> list[dict[str, Any]]:
        """Return clients visible to the caller."""
        if self.is_root(user):
            return [
                {
                    "id": cid,
                    "name": c.get("name", cid),
                    "slug": c.get("slug", cid),
                }
                for cid, c in self.data.get("clients", {}).items()
            ]
        record = self.user_record(user)
        client_id = record.get("client") if record else None
        client = self.data.get("clients", {}).get(client_id)
        return [{
            "id": client_id,
            "name": client.get("name", client_id),
            "slug": client.get("slug", client_id),
        }] if client else []

    async def async_create_client(self, user: User, name: str) -> dict[str, Any]:
        """Create a new client tree. Only the global administrator may call this."""
        if not self.is_root(user):
            raise HomeAssistantError("Only a Home Assistant administrator can create tenants")
        name = name.strip()
        if not name:
            raise HomeAssistantError("Tenant name is required")
        base = _slug(name)
        client_id = base
        number = 2
        while client_id in self.data["clients"]:
            client_id = f"{base}-{number}"
            number += 1
        self.data["clients"][client_id] = {
            "id": client_id,
            "name": name,
            "slug": client_id,
            "created_at": time.time(),
        }
        tree = {**_copy_tree(None, name), "places": []}
        self.data["clients"][client_id]["floor_id"] = self._create_floor(name)
        self.data["trees"][client_id] = tree
        self._refresh_location_index()
        await self.async_save()
        await self.async_sync_groups()
        return {"id": client_id, "name": name, "slug": client_id}

    async def async_update_client(self, user: User, client_id: str, name: str) -> dict[str, Any]:
        """Rename one client workspace. Only a Home Assistant administrator may call this."""
        if not self.is_root(user):
            raise HomeAssistantError("Only a Home Assistant administrator can change tenants")
        client = self.data.get("clients", {}).get(client_id)
        if client is None:
            raise HomeAssistantError("Tenant not found")
        clean = name.strip()
        if not clean or len(clean) > 80:
            raise HomeAssistantError("Enter a tenant name of up to 80 characters")
        client["name"] = clean
        if client.get("floor_id"):
            try:
                fr.async_get(self.hass).async_update(client["floor_id"], name=clean)
            except Exception:  # a name clash must not block renaming the client
                _LOGGER.warning("Optim Energy could not rename floor %s", client["floor_id"])
        await self.async_save()
        return {"id": client_id, "name": clean}

    async def async_delete_client(
        self,
        user: User,
        client_id: str,
        *,
        delete_users: bool = False,
    ) -> None:
        """Delete a client, optionally revoking and deleting all of its users."""
        if not self.is_root(user):
            raise HomeAssistantError("Only a Home Assistant administrator can delete tenants")
        if client_id not in self.data["clients"]:
            raise HomeAssistantError("Tenant not found")
        if len(self.data["clients"]) <= 1:
            raise HomeAssistantError("At least one tenant must remain")
        assigned_ids = [
            user_id
            for user_id, record in self.data["users"].items()
            if record.get("client") == client_id
        ]
        if assigned_ids and not delete_users:
            raise HomeAssistantError("Remove or reassign the tenant's users first")
        targets: list[User] = []
        if delete_users:
            for user_id in assigned_ids:
                target = await self.hass.auth.async_get_user(user_id)
                if (
                    target is None
                    or target.id == user.id
                    or target.system_generated
                    or target.is_owner
                ):
                    raise HomeAssistantError("One of the tenant's users cannot be deleted")
                targets.append(target)
        del self.data["clients"][client_id]
        self.data["trees"].pop(client_id, None)
        self.data.get("owned", {}).pop(client_id, None)
        for target in targets:
            await self.hass.auth.async_remove_user(target)
            self.data["users"].pop(target.id, None)
        self._refresh_location_index()
        await self.async_save()
        await self.async_sync_groups()

    async def async_list_users(self, user: User, requested_client: str | None = None) -> list[dict[str, Any]]:
        """List only users belonging to the caller's allowed client."""
        root = self.is_root(user)
        if root:
            if requested_client:
                client_id, _ = self.require_client_value(user, requested_client)
                wanted = {client_id}
            else:
                wanted = set(self.data["clients"])
        else:
            client_id, ctx = self.require_client_value(user)
            if ctx["role"] != ROLE_CLIENT_ADMIN:
                raise HomeAssistantError("Only a tenant admin can list users")
            wanted = {client_id}
        result: list[dict[str, Any]] = []
        for ha_user in await self.hass.auth.async_get_users():
            record = self.data.get("users", {}).get(ha_user.id)
            if not record or record.get("client") not in wanted:
                continue
            result.append(self._user_info(ha_user, record))
        return result

    def _user_info(self, ha_user: User, record: dict[str, Any]) -> dict[str, Any]:
        username = None
        for credential in ha_user.credentials:
            if credential.auth_provider_type == "homeassistant":
                username = credential.data.get("username")
                break
        return {
            "id": ha_user.id,
            "name": ha_user.name,
            "username": username,
            "is_active": ha_user.is_active,
            "role": record.get("role"),
            "client": record.get("client"),
            "location": (_record_locations(record)[0] if _record_locations(record) else None),
            "locations": _record_locations(record),
            "system_generated": ha_user.system_generated,
        }

    def _group_id_for(self, client_id: str, role: str, location: str | None) -> str:
        key = f"{client_id}:{role}:{location or '*'}"
        return _managed_group_id("user", key)

    async def async_create_user(
        self,
        actor: User,
        client_id: str,
        name: str,
        username: str,
        password: str,
        role: str,
        location: str | None = None,
        locations: list[str] | None = None,
    ) -> dict[str, Any]:
        """Create a non-admin HA user and attach it to one tenant."""
        actor_client, ctx = self.require_client_value(actor, client_id)
        if not (ctx["is_root"] or ctx["role"] == ROLE_CLIENT_ADMIN):
            raise HomeAssistantError("Only a tenant admin can create users")
        if client_id != actor_client:
            raise HomeAssistantError("Tenants cannot create users for another tenant")
        if role not in (ROLE_CLIENT_ADMIN, ROLE_USER):
            raise HomeAssistantError("Invalid portal role")
        if role == ROLE_CLIENT_ADMIN and not ctx["is_root"]:
            raise HomeAssistantError("Only the global administrator can create tenant admins")
        chosen = list(dict.fromkeys(str(x) for x in (locations or ([] if not location else [location])) if str(x)))
        if role == ROLE_USER and not chosen:
            raise HomeAssistantError("Choose at least one location for an ordinary user")
        for location_id in chosen:
            if location_id not in self.data.get("locations", {}):
                raise HomeAssistantError("Location not found")
            if self.data["locations"][location_id].get("client") != client_id:
                raise HomeAssistantError("Location belongs to another tenant")
        if role == ROLE_CLIENT_ADMIN:
            chosen = []
        name = name.strip()
        username = username.strip().casefold()
        if not name or not username or len(password) < 8:
            raise HomeAssistantError("Name, username and a password of at least 8 characters are required")
        await self.async_sync_groups()
        group_ids = [
            self._group_id_for(client_id, role, loc)
            for loc in (chosen if role == ROLE_USER else [None])
        ]
        for group_id in group_ids:
            if await self.hass.auth.async_get_group(group_id) is None:
                raise HomeAssistantError("Could not create the tenant permission group")
        provider = next((p for p in self.hass.auth.auth_providers if p.type == "homeassistant"), None)
        if provider is None:
            raise HomeAssistantError("The local Home Assistant login provider is not configured")
        credential = provider.async_create_credentials({"username": username})
        # add_auth validates duplicate usernames before the user is created.
        await provider.async_add_auth(username, password)
        try:
            ha_user = await self.hass.auth.async_create_user(name, group_ids=group_ids)
            await self.hass.auth.async_link_user(ha_user, credential)
        except Exception:
            await provider.async_remove_auth(username)
            raise
        self.data["users"][ha_user.id] = {
            "client": client_id,
            "location": chosen[0] if chosen else None,
            "locations": chosen,
            "role": role,
        }
        await self.async_save()
        await self.async_sync_groups()
        await self.async_sync_sidebar(ha_user)
        return self._user_info(ha_user, self.data["users"][ha_user.id])

    async def async_update_user(
        self,
        actor: User,
        user_id: str,
        *,
        name: str | None = None,
        is_active: bool | None = None,
        role: str | None = None,
        location: str | None = None,
        locations: list[str] | None = None,
        password: str | None = None,
    ) -> dict[str, Any]:
        """Update a user while keeping the target inside the actor's client."""
        target = await self.hass.auth.async_get_user(user_id)
        if target is None or target.system_generated or target.is_owner:
            raise HomeAssistantError("User cannot be changed")
        record = self.data.get("users", {}).get(user_id)
        if not record:
            raise HomeAssistantError("User is not assigned to Optim Energy")
        actor_client, ctx = self.require_client_value(
            actor, str(record.get("client") or "") if self.is_root(actor) else None
        )
        if not (ctx["is_root"] or ctx["role"] == ROLE_CLIENT_ADMIN):
            raise HomeAssistantError("Only a tenant admin can change users")
        if record.get("client") != actor_client:
            raise HomeAssistantError("User belongs to another tenant")
        if not ctx["is_root"] and target.is_admin:
            raise HomeAssistantError("A Home Assistant administrator cannot be changed here")
        if not ctx["is_root"] and record.get("role") == ROLE_CLIENT_ADMIN:
            raise HomeAssistantError("Only the global administrator can change a tenant admin")
        target_role = role if role is not None else record.get("role")
        if target_role not in (ROLE_CLIENT_ADMIN, ROLE_USER):
            raise HomeAssistantError("Invalid portal role")
        if target_role == ROLE_CLIENT_ADMIN and not ctx["is_root"]:
            raise HomeAssistantError("Only the global administrator can create tenant admins")
        if locations is not None:
            chosen = list(dict.fromkeys(str(x) for x in locations if str(x)))
        elif location is not None:
            chosen = [location] if location else []
        else:
            chosen = _record_locations(record)
        if target_role == ROLE_CLIENT_ADMIN:
            chosen = []
        if target_role == ROLE_USER and not chosen:
            raise HomeAssistantError("An ordinary user needs at least one location")
        for location_id in chosen:
            if location_id not in self.data.get("locations", {}) or self.data["locations"][location_id].get("client") != actor_client:
                raise HomeAssistantError("Location not found for this tenant")
        username = None
        if password is not None:
            # Checked before anything is changed, so a bad password changes nothing.
            if len(password) < 8:
                raise HomeAssistantError("A password needs at least 8 characters")
            username = next(
                (c.data.get("username") for c in target.credentials if c.auth_provider_type == "homeassistant"),
                None,
            )
            if not username:
                raise HomeAssistantError("This account has no local Home Assistant login")
        if role is not None:
            record["role"] = target_role
        if locations is not None or location is not None or role is not None:
            record["locations"] = chosen
            record["location"] = chosen[0] if chosen else None
        if name is not None and name.strip():
            await self.hass.auth.async_update_user(target, name=name.strip())
        if is_active is not None:
            await self.hass.auth.async_update_user(target, is_active=is_active)
        if username:
            provider = next((p for p in self.hass.auth.auth_providers if p.type == "homeassistant"), None)
            if provider is None:
                raise HomeAssistantError("The local Home Assistant login provider is not configured")
            await provider.async_change_password(username, password)
        await self.async_save()
        await self.async_sync_groups()
        await self.async_sync_sidebar(target)
        return self._user_info(target, record)

    async def async_delete_user(self, actor: User, user_id: str) -> None:
        """Delete a client user, never the actor or a global administrator."""
        if user_id == actor.id:
            raise HomeAssistantError("You cannot delete your own account")
        target = await self.hass.auth.async_get_user(user_id)
        record = self.data.get("users", {}).get(user_id)
        if target is None or not record or target.system_generated or target.is_owner:
            raise HomeAssistantError("User cannot be deleted")
        actor_client, ctx = self.require_client_value(
            actor, str(record.get("client") or "") if self.is_root(actor) else None
        )
        if not (ctx["is_root"] or ctx["role"] == ROLE_CLIENT_ADMIN):
            raise HomeAssistantError("Only a tenant admin can delete users")
        if record.get("client") != actor_client:
            raise HomeAssistantError("User belongs to another tenant")
        if not ctx["is_root"] and target.is_admin:
            raise HomeAssistantError("A Home Assistant administrator cannot be deleted here")
        if not ctx["is_root"] and record.get("role") == ROLE_CLIENT_ADMIN:
            raise HomeAssistantError("Only the global administrator can delete a tenant admin")
        await self.hass.auth.async_remove_user(target)
        self.data["users"].pop(user_id, None)
        await self.async_save()
        await self.async_sync_groups()

    async def async_sync_groups(self) -> None:
        """Rebuild tenant policies and membership from HA registries."""
        async with self._sync_lock:
            await self._async_sync_groups_locked()

    async def _async_sync_groups_locked(self) -> None:
        groups = self.data.setdefault("groups", {})
        auth_store = getattr(self.hass.auth, "_store", None)
        if auth_store is None or not hasattr(auth_store, "_groups"):
            raise HomeAssistantError("Home Assistant auth storage is not compatible with Optim Energy tenancy")
        all_users = await self.hass.auth.async_get_users()
        admin_ids = {u.id for u in all_users if u.is_admin or u.is_owner}

        wanted_groups: dict[str, tuple[str, dict[str, Any]]] = {}
        for client_id, client in self.data.get("clients", {}).items():
            tree = self.data.get("trees", {}).get(client_id, {})
            locations = [p for p in _place_locations(tree)]
            client_area_ids: set[str] = set()
            client_entity_ids: set[str] = set()
            for place in locations:
                loc_id = str(place["id"])
                area_ids, entity_ids = self._policy_for_location(client_id, loc_id, tree)
                group_id = self._group_id_for(client_id, ROLE_USER, loc_id)
                wanted_groups[group_id] = (
                    f"Optim Energy · {client.get('name', client_id)} · {place.get('name', loc_id)}",
                    self._policy(area_ids, entity_ids, ROLE_USER),
                )
                client_area_ids.update(area_ids)
                client_entity_ids.update(entity_ids)
            group_id = self._group_id_for(client_id, ROLE_CLIENT_ADMIN, None)
            wanted_groups[group_id] = (
                f"Optim Energy · {client.get('name', client_id)} · administrators",
                self._policy(client_area_ids, client_entity_ids, ROLE_CLIENT_ADMIN),
            )

        # A group with no entities is assigned to unmapped accounts. This is
        # deliberately fail-closed while still letting them reach the portal
        # error page instead of retaining HA's all-entity system-user group.
        unassigned_id = _managed_group_id("user", "unassigned")
        wanted_groups[unassigned_id] = (
            "Optim Energy · unassigned",
            self._policy(set(), set(), ROLE_USER),
        )

        for group_id, (name, policy) in wanted_groups.items():
            group = auth_store._groups.get(group_id)
            if group is None:
                auth_store._groups[group_id] = Group(
                    id=group_id,
                    name=name,
                    policy=policy,
                    system_generated=False,
                )
            else:
                # The Group object is immutable in current HA. Replacing it
                # also lets auth_store persist the new policy on its next save.
                auth_store._groups[group_id] = Group(
                    id=group_id,
                    name=name,
                    policy=policy,
                    system_generated=False,
                )
        if hasattr(auth_store, "_async_schedule_save"):
            auth_store._async_schedule_save(0.1)

        group_ids = set(wanted_groups)
        for ha_user in all_users:
            if ha_user.system_generated or ha_user.id in admin_ids:
                continue
            record = self.data.get("users", {}).get(ha_user.id)
            target = unassigned_id
            if record:
                role = record.get("role")
                candidate = None
                if role == ROLE_CLIENT_ADMIN:
                    candidates = [self._group_id_for(record["client"], ROLE_CLIENT_ADMIN, None)]
                elif role == ROLE_USER:
                    candidates = [
                        self._group_id_for(record["client"], ROLE_USER, loc)
                        for loc in _record_locations(record)
                    ]
                else:
                    candidates = []
                targets = [candidate for candidate in candidates if candidate in group_ids]
                if targets:
                    target = targets
            # Always reassign the group objects. Replacing a group in the
            # private auth store does not invalidate a User's cached
            # permissions until its group list changes.
            target_ids = target if isinstance(target, list) else [target]
            await self.hass.auth.async_update_user(ha_user, group_ids=target_ids)
            # Drop managed groups that no longer have a user. Keep the
            # deterministic group definitions available for future accounts.
        for group_id in list(auth_store._groups):
            if (
                group_id.startswith(MANAGED_GROUP_PREFIX)
                and group_id not in group_ids
                and not any(group_id in {g.id for g in u.groups} for u in all_users)
            ):
                del auth_store._groups[group_id]
        self.data["groups"] = {
            "unassigned": unassigned_id,
            "by_client": {
                client_id: {
                    "admin": self._group_id_for(client_id, ROLE_CLIENT_ADMIN, None),
                    "locations": {
                        str(p["id"]): self._group_id_for(client_id, ROLE_USER, str(p["id"]))
                        for p in _place_locations(self.data["trees"].get(client_id, {}))
                    },
                }
                for client_id in self.data.get("clients", {})
            },
        }
        await self.async_save()

    def _policy(self, area_ids: Iterable[str], entity_ids: Iterable[str], role: str) -> dict[str, Any]:
        perms = {POLICY_READ: True, POLICY_CONTROL: True}
        if role == ROLE_CLIENT_ADMIN:
            perms[POLICY_EDIT] = True
        entities: dict[str, Any] = {
            "area_ids": {area_id: dict(perms) for area_id in sorted(set(area_ids)) if area_id},
            "entity_ids": {entity_id: dict(perms) for entity_id in sorted(set(entity_ids)) if entity_id},
        }
        return {"entities": entities}

    def _policy_for_location(self, client_id: str, location: str, tree: dict[str, Any]) -> tuple[set[str], set[str]]:
        """Return explicit area/entity permissions for one location.

        The location is one area. Home Assistant resolves a device's entities
        through that area; entities with no device are listed.
        """
        area_id = self.location_area(tree, location)
        if not area_id:
            return set(), set()
        return {area_id}, {
            entity.entity_id
            for entity in er.async_get(self.hass).entities.values()
            if entity.device_id is None and entity.area_id == area_id
        }

    def _tree_visible_entities(self, client_id: str) -> set[str]:
        """Return the entities a client can see: those of its areas' devices and the device-less ones."""
        tree = self.data.get("trees", {}).get(client_id, {})
        allowed: set[str] = set()
        area_ids: set[str] = set()
        for place in _place_locations(tree):
            areas, entities = self._policy_for_location(client_id, str(place["id"]), tree)
            area_ids.update(areas)
            allowed.update(entities)
        # The policy names the area, not each entity, so the entities of the
        # devices in those areas are added here.
        device_ids = {d.id for d in dr.async_get(self.hass).devices if d.area_id in area_ids}
        allowed.update(
            entity.entity_id
            for entity in er.async_get(self.hass).entities.values()
            if entity.device_id in device_ids
        )
        return allowed

    def _device_ids_for_location(
        self,
        tree: dict[str, Any],
        location: str,
        area_ids: set[str],
    ) -> set[str]:
        """Return devices owned by one location, including devices without entities."""
        return {d.id for d in dr.async_get(self.hass).devices if d.area_id in area_ids}

    def _install_registry_watchers(self) -> None:
        """Debounce auth-policy updates when registries change."""
        events = (
            "area_registry_updated",
            "device_registry_updated",
            "entity_registry_updated",
            "floor_registry_updated",
        )
        for event in events:
            self._unsubscribers.append(
                self.hass.bus.async_listen(event, self._schedule_group_sync)
            )
        self._unsubscribers.append(self.hass.bus.async_listen("area_registry_updated", self._area_changed))

    def _schedule_group_sync(self, _event: Any = None) -> None:
        if self._sync_cancel is not None:
            self._sync_cancel()
        self._sync_cancel = async_call_later(self.hass, 1.5, self._run_scheduled_sync)

    async def _run_scheduled_sync(self, _now: Any) -> None:
        self._sync_cancel = None
        try:
            await self.async_sync_groups()
        except Exception:
            _LOGGER.exception("Optim Energy could not refresh tenant permissions")

    async def async_unload(self) -> None:
        if self._sync_cancel is not None:
            self._sync_cancel()
            self._sync_cancel = None
        for unsub in self._unsubscribers:
            unsub()
        self._unsubscribers.clear()


def _register_ws(hass: HomeAssistant, handler: Any) -> None:
    websocket_api.async_register_command(hass, handler)


def _error(connection: ActiveConnection, msg: dict[str, Any], message: str) -> None:
    connection.send_error(
        msg["id"], websocket_api.ERR_UNAUTHORIZED, message, translation_domain=DOMAIN
    )


def async_register_commands(hass: HomeAssistant, manager: TenancyManager) -> None:
    """Register the small, checked websocket API used by the portal."""
    hass.data[f"{DOMAIN}_tenancy"] = manager
    bill_quota = hass.data.setdefault(f"{DOMAIN}_bill_quota", BillReadQuota())

    @websocket_api.websocket_command({probatio.Required("type"): f"{DOMAIN}/whoami"})
    @websocket_api.async_response
    async def ws_whoami(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        ctx = manager.context(connection.user)
        connection.send_result(
            msg["id"],
            {
                **ctx,
                "model": MODEL,
                "clients": manager.client_list(connection.user),
                "capabilities": {
                    "manage_tree": manager.can_manage_tree(ctx),
                    # Wiring, main devices and virtual devices decide what a
                    # client can see, so only root changes them.
                    "manage_wiring": ctx["is_root"],
                    "manage_ha": ctx["is_root"],
                    "manage_users": ctx["is_root"] or ctx["role"] == ROLE_CLIENT_ADMIN,
                },
            },
        )

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/tree/get",
            probatio.Optional("client"): str,
        }
    )
    @websocket_api.async_response
    async def ws_tree_get(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            connection.send_result(msg["id"], manager.tree_for(connection.user, msg.get("client")))
        except HomeAssistantError as err:
            _error(connection, msg, str(err))

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/tree/save",
            probatio.Required("tree"): dict,
            probatio.Optional("client"): str,
        }
    )
    @websocket_api.async_response
    async def ws_tree_save(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            connection.send_result(
                msg["id"],
                await manager.async_save_tree(connection.user, msg.get("client"), msg["tree"]),
            )
        except HomeAssistantError as err:
            _error(connection, msg, str(err))

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/user/list",
            probatio.Optional("client"): str,
        }
    )
    @websocket_api.async_response
    async def ws_user_list(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            connection.send_result(msg["id"], await manager.async_list_users(connection.user, msg.get("client")))
        except HomeAssistantError as err:
            _error(connection, msg, str(err))

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/user/create",
            probatio.Required("client"): str,
            probatio.Required("name"): str,
            probatio.Required("username"): str,
            probatio.Required("password"): str,
            probatio.Required("role"): str,
            probatio.Optional("location"): str,
            probatio.Optional("locations"): [str],
        }
    )
    @websocket_api.async_response
    async def ws_user_create(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            connection.send_result(
                msg["id"],
                await manager.async_create_user(
                    connection.user,
                    msg["client"],
                    msg["name"],
                    msg["username"],
                    msg["password"],
                    msg["role"],
                    msg.get("location"),
                    msg.get("locations"),
                ),
            )
        except (HomeAssistantError, ValueError) as err:
            _error(connection, msg, str(err))

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/user/update",
            probatio.Required("user_id"): str,
            probatio.Optional("name"): str,
            probatio.Optional("is_active"): bool,
            probatio.Optional("role"): str,
            probatio.Optional("location"): str,
            probatio.Optional("locations"): [str],
            probatio.Optional("password"): str,
        }
    )
    @websocket_api.async_response
    async def ws_user_update(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            connection.send_result(
                msg["id"],
                await manager.async_update_user(
                    connection.user,
                    msg["user_id"],
                    name=msg.get("name"),
                    is_active=msg.get("is_active"),
                    role=msg.get("role"),
                    location=msg.get("location"),
                    locations=msg.get("locations"),
                    password=msg.get("password"),
                ),
            )
        except (HomeAssistantError, ValueError) as err:
            _error(connection, msg, str(err))

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/user/delete",
            probatio.Required("user_id"): str,
        }
    )
    @websocket_api.async_response
    async def ws_user_delete(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            await manager.async_delete_user(connection.user, msg["user_id"])
            connection.send_result(msg["id"], {"deleted": True})
        except (HomeAssistantError, ValueError) as err:
            _error(connection, msg, str(err))

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/client/list",
        }
    )
    @websocket_api.async_response
    async def ws_client_list(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        connection.send_result(msg["id"], manager.client_list(connection.user))

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/client/create",
            probatio.Required("name"): str,
        }
    )
    @websocket_api.async_response
    async def ws_client_create(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            connection.send_result(msg["id"], await manager.async_create_client(connection.user, msg["name"]))
        except HomeAssistantError as err:
            _error(connection, msg, str(err))

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/client/update",
            probatio.Required("client"): str,
            probatio.Required("name"): str,
        }
    )
    @websocket_api.async_response
    async def ws_client_update(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            connection.send_result(
                msg["id"],
                await manager.async_update_client(
                    connection.user, msg["client"], msg["name"]
                ),
            )
        except (HomeAssistantError, ValueError) as err:
            _error(connection, msg, str(err))

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/client/delete",
            probatio.Required("client"): str,
            probatio.Optional("delete_users"): bool,
        }
    )
    @websocket_api.async_response
    async def ws_client_delete(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            await manager.async_delete_client(
                connection.user,
                msg["client"],
                delete_users=bool(msg.get("delete_users")),
            )
            connection.send_result(msg["id"], {"deleted": True})
        except HomeAssistantError as err:
            _error(connection, msg, str(err))

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/registry/list",
            probatio.Required("kind"): str,
            probatio.Optional("client"): str,
        }
    )
    @websocket_api.async_response
    async def ws_registry_list(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            connection.send_result(msg["id"], manager.registry_list(connection.user, msg["kind"], msg.get("client")))
        except HomeAssistantError as err:
            _error(connection, msg, str(err))

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/bill/read",
            probatio.Required("body"): str,
        }
    )
    @websocket_api.async_response
    async def ws_bill_read(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            client_id, ctx = manager.require_client_value(connection.user)
            if not ctx.get("is_root") and not ctx.get("role"):
                raise HomeAssistantError("No tenant assignment")
            body = msg["body"]
            if len(body) > 300_000:
                raise HomeAssistantError("Bill payload is too large")
            bill_quota.consume(user_id=connection.user.id, client_id=client_id)
            response = await hass.services.async_call(
                "rest_command",
                "discretestack_chat",
                {"body": body},
                blocking=True,
                return_response=True,
                context=connection.context(msg),
            )
            connection.send_result(msg["id"], {"response": response})
        except BillReadLimitExceeded as err:
            _error(connection, msg, str(err))
        except (HomeAssistantError, ValueError) as err:
            _error(connection, msg, str(err))

    def _command(name: str, schema: dict[Any, Any], call: Any) -> Any:
        """Register a command whose handler is one checked manager call.

        A schema must not use the key "id": that is the websocket message id.
        """

        @websocket_api.websocket_command({probatio.Required("type"): f"{DOMAIN}/{name}", **schema})
        @websocket_api.async_response
        async def handler(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
            try:
                result = call(connection.user, msg)
                if asyncio.iscoroutine(result):
                    result = await result
                connection.send_result(msg["id"], result if result is not None else {"done": True})
            except HomeAssistantError as err:
                _error(connection, msg, str(err))

        _register_ws(hass, handler)

    client = {probatio.Optional("client"): str}
    _command(
        "location/save",
        {**client, probatio.Optional("location"): str, probatio.Required("name"): str},
        lambda user, msg: manager.async_save_location(user, msg.get("client"), msg.get("location"), msg["name"]),
    )
    _command(
        "location/delete",
        {**client, probatio.Required("location"): str},
        lambda user, msg: manager.async_delete_location(user, msg.get("client"), msg["location"]),
    )
    _command(
        "location/move",
        {**client, probatio.Required("location"): str, probatio.Required("target"): str},
        lambda user, msg: manager.async_move_location(user, msg.get("client"), msg["location"], msg["target"]),
    )
    _command(
        "group/save",
        {**client, probatio.Optional("group"): str, probatio.Required("name"): str, probatio.Optional("parent"): str},
        lambda user, msg: manager.async_save_group(user, msg.get("client"), msg.get("group"), msg["name"], msg.get("parent")),
    )
    _command(
        "group/delete",
        {**client, probatio.Required("group"): str},
        lambda user, msg: manager.async_delete_group(user, msg.get("client"), msg["group"]),
    )
    _command(
        "device/assign",
        {**client, probatio.Required("device_id"): str, probatio.Optional("place"): str},
        # No place, or an empty one, takes the device out of every client.
        lambda user, msg: manager.async_assign_device(user, msg.get("client"), msg["device_id"], msg.get("place") or None),
    )
    _command("device/inbox", {}, lambda user, msg: manager.device_inbox(user))
    _command(
        "device/ignore",
        {probatio.Required("device_id"): str, probatio.Required("ignored"): bool},
        lambda user, msg: manager.async_ignore_device(user, msg["device_id"], msg["ignored"]),
    )

    for handler in (
        ws_whoami,
        ws_tree_get,
        ws_tree_save,
        ws_user_list,
        ws_user_create,
        ws_user_update,
        ws_user_delete,
        ws_client_list,
        ws_client_create,
        ws_client_update,
        ws_client_delete,
        ws_registry_list,
        ws_bill_read,
    ):
        _register_ws(hass, handler)


def _entity_is_allowed(manager: TenancyManager, user: User, entity_id: str) -> bool:
    """Ask HA's compiled entity policy, including disabled/unavailable entities."""
    if manager.is_root(user):
        return True
    return bool(user.permissions.check_entity(entity_id, POLICY_READ))


def _registry_entry_dict(entry: Any) -> dict[str, Any]:
    if isinstance(entry, dict):
        return dict(entry)
    if hasattr(entry, "extended_dict"):
        return dict(entry.extended_dict)
    if hasattr(entry, "as_partial_dict"):
        return dict(entry.as_partial_dict)
    result: dict[str, Any] = {}
    for key in (
        "area_id",
        "categories",
        "config_entry_id",
        "configuration_url",
        "description",
        "device_id",
        "disabled_by",
        "entity_id",
        "floor_id",
        "hidden_by",
        "icon",
        "id",
        "label_id",
        "labels",
        "level",
        "manufacturer",
        "model",
        "model_id",
        "name",
        "name_by_user",
        "original_name",
        "platform",
        "unique_id",
        "via_device_id",
    ):
        if hasattr(entry, key):
            value = getattr(entry, key)
            result[key] = list(value) if isinstance(value, set) else str(value) if hasattr(value, "value") else value
    return result


def _registry_list(self: TenancyManager, user: User, kind: str, requested_client: str | None) -> list[dict[str, Any]]:
    """Return a tenant-filtered registry list without using admin-only commands."""
    client_id, ctx = self.require_client_value(user, requested_client)
    ar_reg = ar.async_get(self.hass)
    dr_reg = {entry.id: entry for entry in dr.async_get(self.hass).devices}
    er_reg = er.async_get(self.hass)
    lr_reg = lr.async_get(self.hass)
    root = self.is_root(user)
    scoped_root = root and bool(requested_client)
    all_areas = list(ar_reg.async_list_areas())
    entities = list(er_reg.entities.values())
    if root and not scoped_root:
        allowed_entities = entities if root else [
            x for x in entities if _entity_is_allowed(self, user, x.entity_id)
        ]
        allowed_device_ids = set(dr_reg)
        allowed_area_ids = {area.id for area in all_areas}
    else:
        tree = self.data.get("trees", {}).get(client_id, {})
        record = self.user_record(user) or {}
        client_admin = ctx.get("role") == ROLE_CLIENT_ADMIN or record.get("role") == ROLE_CLIENT_ADMIN
        if root or client_admin:
            locations = _place_locations(tree)
        else:
            assigned = set(ctx.get("locations") or _record_locations(record))
            locations = [
                place for place in _place_locations(tree) if place.get("id") in assigned
            ]
        tree_device_ids: set[str] = set()
        allowed_area_ids: set[str] = set()
        for place in locations:
            area_ids, _ = self._policy_for_location(
                client_id, str(place["id"]), tree
            )
            allowed_area_ids.update(area_ids)
            tree_device_ids.update(
                self._device_ids_for_location(tree, str(place["id"]), area_ids)
            )
        if scoped_root:
            visible_entities = self._tree_visible_entities(client_id)
            allowed_entities = [
                entity for entity in entities if entity.entity_id in visible_entities
            ]
        else:
            allowed_entities = [
                entity
                for entity in entities
                if _entity_is_allowed(self, user, entity.entity_id)
            ]
        allowed_device_ids = tree_device_ids | {
            entity.device_id for entity in allowed_entities if entity.device_id
        }
        allowed_area_ids.update(
            entity.area_id for entity in allowed_entities if entity.area_id
        )
        allowed_area_ids.update(
            dr_reg[device_id].area_id
            for device_id in allowed_device_ids
            if device_id in dr_reg and dr_reg[device_id].area_id
        )
    area_items = all_areas
    allowed_labels = {
        label
        for x in allowed_entities
        for label in (getattr(x, "labels", ()) or ())
    } | {
        label
        for device_id in allowed_device_ids
        if device_id in dr_reg
        for label in (getattr(dr_reg[device_id], "labels", ()) or ())
    } | {
        label
        for area in area_items
        if area.id in allowed_area_ids
        for label in (getattr(area, "labels", ()) or ())
    }
    if not (root and not scoped_root):
        area_items = [x for x in area_items if x.id in allowed_area_ids]
    floor_ids = {x.floor_id for x in area_items if x.floor_id}
    floor_items = list(fr.async_get(self.hass).async_list_floors())
    if not (root and not scoped_root):
        floor_items = [x for x in floor_items if x.floor_id in floor_ids]
    label_items = list(lr_reg.async_list_labels())
    if not (root and not scoped_root):
        label_items = [x for x in label_items if x.label_id in allowed_labels]
    device_items = list(dr_reg.values())
    if not (root and not scoped_root):
        device_items = [x for x in device_items if x.id in allowed_device_ids]
    if kind == "label":
        return [_registry_entry_dict(x) for x in label_items]
    if kind == "area":
        result = []
        for entry in area_items:
            value = _registry_entry_dict(entry)
            value["area_id"] = str(getattr(entry, "id", value.get("area_id")))
            result.append(value)
        return result
    if kind == "floor":
        return [_registry_entry_dict(x) for x in floor_items]
    if kind == "device":
        return [_registry_entry_dict(x) for x in device_items]
    if kind == "entity":
        return [_registry_entry_dict(x) for x in allowed_entities]
    raise HomeAssistantError("Unknown registry kind")


def registry_list(self: TenancyManager, user: User, kind: str, requested_client: str | None = None) -> list[dict[str, Any]]:
    """Public wrapper used by the websocket command."""
    return _registry_list(self, user, kind, requested_client)


TenancyManager.registry_list = registry_list  # type: ignore[attr-defined]
