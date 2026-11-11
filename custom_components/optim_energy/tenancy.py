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
from collections.abc import Iterable
from typing import Any

import probatio
from homeassistant.auth.models import Group, User
from homeassistant.auth.permissions.const import POLICY_CONTROL, POLICY_EDIT, POLICY_READ
from homeassistant.components import websocket_api
from homeassistant.components.websocket_api import ActiveConnection
from homeassistant.core import HomeAssistant
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

_LOGGER = logging.getLogger(__name__)

STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}.tenancy"
MANAGED_GROUP_PREFIX = f"{DOMAIN}_"
DEFAULT_CLIENT = "default"
MAX_TREE_BYTES = 2 * 1024 * 1024
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


def _place_locations(tree: dict[str, Any]) -> list[dict[str, Any]]:
    return [p for p in _tree_places(tree) if _is_location_place(p) and p.get("id")]


def _place_name(tree: dict[str, Any], place_id: str) -> str:
    for place in _tree_places(tree):
        if place.get("id") == place_id:
            return str(place.get("name") or place_id)
    return place_id


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
        self._group_compat: Any = None

    @property
    def site_name(self) -> str:
        client = self.data.get("clients", {}).get(DEFAULT_CLIENT, {})
        return str(client.get("name") or "Optim Energy")

    async def async_initialize(self, site_name: str, initial_tree: dict[str, Any] | None) -> None:
        """Load the store, migrate the old dashboard tree, and create auth groups."""
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
                "trees": {DEFAULT_CLIENT: _copy_tree(initial_tree, site_name)},
                "groups": {},
            }
            changed = True
        else:
            self.data = loaded
            changed = self._migrate()
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
        for client_id, client in list(self.data["clients"].items()):
            if not isinstance(client, dict):
                client = {"id": client_id, "name": str(client), "slug": client_id}
                self.data["clients"][client_id] = client
                changed = True
            client.setdefault("id", client_id)
            client.setdefault("slug", client_id)
            client.setdefault("name", client_id)
            client.setdefault("labels", [])
            if not isinstance(self.data["trees"].get(client_id), dict):
                self.data["trees"][client_id] = _copy_tree(None, str(client["name"]))
                changed = True
        return changed

    def _refresh_location_index(self) -> None:
        """Rebuild the UI index of locations from trees and assigned labels."""
        locations: dict[str, dict[str, Any]] = {}
        label_registry = lr.async_get(self.hass)
        labels = {x.label_id: x for x in label_registry.async_list_labels()}
        for client_id, tree in self.data.get("trees", {}).items():
            if not isinstance(tree, dict):
                continue
            for place in _place_locations(tree):
                location_id = str(place["id"])
                entry = {
                    "id": location_id,
                    "name": str(place.get("name") or location_id),
                    "client": client_id,
                    "label_id": location_id[4:] if location_id.startswith("loc:") else None,
                }
                existing = locations.get(location_id)
                if existing and existing.get("client") != client_id:
                    _LOGGER.warning("Location %s is present in more than one client", location_id)
                    continue
                locations[location_id] = entry
            for label_id in self.data.get("clients", {}).get(client_id, {}).get("labels", []):
                label = labels.get(label_id)
                location_id = f"loc:{label_id}"
                if location_id in locations and locations[location_id].get("client") != client_id:
                    _LOGGER.warning("Location label %s is assigned to more than one client", label_id)
                    continue
                locations[location_id] = {
                    "id": location_id,
                    "name": str(getattr(label, "name", label_id) or label_id),
                    "client": client_id,
                    "label_id": label_id,
                }
        self.data["locations"] = locations

    def _merge_native_places(self, tree: dict[str, Any], client_id: str) -> dict[str, Any]:
        """Merge native location labels and areas assigned to one client."""
        label_registry = lr.async_get(self.hass)
        area_registry = ar.async_get(self.hass)
        floor_registry = fr.async_get(self.hass)
        assigned = set(self.data.get("clients", {}).get(client_id, {}).get("labels", []))
        if not assigned:
            return tree
        labels = {x.label_id: x for x in label_registry.async_list_labels()}
        areas = list(area_registry.async_list_areas())
        floors = {x.floor_id: x for x in floor_registry.async_list_floors()}
        area_loc = {
            area.id: next((label for label in (area.labels or []) if label in assigned), None)
            for area in areas
        }
        floor_loc: dict[str, str] = {}
        for area in areas:
            if area_loc.get(area.id) and area.floor_id and area.floor_id not in floor_loc:
                floor_loc[area.floor_id] = area_loc[area.id]
        old = _tree_places(tree)
        kept = []
        for place in old:
            pid = str(place.get("id") or "")
            if pid.startswith("loc:") and pid[4:] in labels:
                continue
            if pid.startswith("area:") or pid.startswith("floor:"):
                continue
            kept.append(place)
        places = kept
        for label_id in sorted(assigned):
            label = labels.get(label_id)
            if label is None:
                continue
            places.append({"id": f"loc:{label_id}", "name": str(label.name), "kind": "location", "parent": None})
        for floor_id, label_id in floor_loc.items():
            floor = floors.get(floor_id)
            places.append({"id": f"floor:{floor_id}", "name": str(getattr(floor, "name", floor_id) or floor_id), "kind": "group", "parent": f"loc:{label_id}"})
        for area in areas:
            label_id = area_loc.get(area.id)
            if not label_id:
                continue
            parent = f"floor:{area.floor_id}" if area.floor_id and floor_loc.get(area.floor_id) == label_id else f"loc:{label_id}"
            places.append({"id": f"area:{area.id}", "name": str(area.name), "kind": "group", "parent": parent})
        result = copy.deepcopy(tree)
        result["places"] = places
        return result

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
        return {
            "user_id": user.id,
            "user_name": user.name,
            "is_root": root,
            "role": role,
            "client": client_id,
            "client_name": client.get("name"),
            "location": None if root else record.get("location"),
        }

    def require_client(self, connection: ActiveConnection, requested: str | None = None) -> tuple[str, dict[str, Any]]:
        """Resolve and authorize the client for a command."""
        ctx = self.context(connection.user, requested)
        if not ctx["client"]:
            raise HomeAssistantError("This account is not assigned to a client")
        if ctx["client"] not in self.data.get("clients", {}):
            raise HomeAssistantError("Client not found")
        return ctx["client"], ctx

    def can_manage_tree(self, ctx: dict[str, Any]) -> bool:
        return bool(ctx.get("is_root") or ctx.get("role") == ROLE_CLIENT_ADMIN)

    def tree_for(self, user: User, requested_client: str | None = None) -> dict[str, Any]:
        """Return the tree visible to one connection user."""
        client_id, ctx = self.require_client_value(user, requested_client)
        tree = self._merge_native_places(
            self.data.get("trees", {}).get(client_id, _copy_tree(None, "Optim Energy")),
            client_id,
        )
        if ctx["is_root"] or ctx["role"] == ROLE_CLIENT_ADMIN:
            return {"client": client_id, "client_name": ctx["client_name"], "role": ctx["role"], "tree": copy.deepcopy(tree)}
        location = ctx.get("location")
        if not location:
            return {"client": client_id, "client_name": ctx["client_name"], "role": ctx["role"], "tree": _copy_tree({}, "No location assigned")}
        return {"client": client_id, "client_name": ctx["client_name"], "role": ctx["role"], "tree": _filter_tree_for_location(tree, location)}

    def require_client_value(self, user: User, requested: str | None = None) -> tuple[str, dict[str, Any]]:
        """Resolve a client without a websocket connection."""
        ctx = self.context(user, requested)
        if not ctx["client"] or ctx["client"] not in self.data.get("clients", {}):
            raise HomeAssistantError("This account is not assigned to a client")
        return str(ctx["client"]), ctx

    async def async_save_tree(self, user: User, requested_client: str | None, tree: dict[str, Any]) -> dict[str, Any]:
        """Save a client tree after checking the caller's portal role."""
        client_id, ctx = self.require_client_value(user, requested_client)
        if not self.can_manage_tree(ctx):
            raise HomeAssistantError("Only a client administrator can change the dashboard")
        clean = self._merge_native_places(_guard_tree(tree), client_id)
        self.data["trees"][client_id] = clean
        self._refresh_location_index()
        await self.async_save()
        self._schedule_group_sync()
        return {"client": client_id, "saved": True}

    def client_list(self, user: User) -> list[dict[str, Any]]:
        """Return clients visible to the caller."""
        if self.is_root(user):
            return [
                {
                    "id": cid,
                    "name": c.get("name", cid),
                    "slug": c.get("slug", cid),
                    "labels": list(c.get("labels", [])),
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
            "labels": list(client.get("labels", [])),
        }] if client else []

    async def async_create_client(self, user: User, name: str) -> dict[str, Any]:
        """Create a new client tree. Only the global administrator may call this."""
        if not self.is_root(user):
            raise HomeAssistantError("Only a Home Assistant administrator can create clients")
        name = name.strip()
        if not name:
            raise HomeAssistantError("Client name is required")
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
        tree = _copy_tree(None, name)
        for place in _place_locations(tree):
            if place["id"] == "loc:default":
                place["id"] = f"loc:{client_id}"
        self.data["trees"][client_id] = tree
        self._refresh_location_index()
        await self.async_save()
        await self.async_sync_groups()
        return {"id": client_id, "name": name, "slug": client_id}

    async def async_set_client_labels(self, user: User, client_id: str, label_ids: list[str]) -> dict[str, Any]:
        """Assign native location labels to one client. Root only."""
        if not self.is_root(user):
            raise HomeAssistantError("Only a Home Assistant administrator can assign client locations")
        if client_id not in self.data.get("clients", {}):
            raise HomeAssistantError("Client not found")
        label_registry = lr.async_get(self.hass)
        known = {x.label_id for x in label_registry.async_list_labels()}
        clean = sorted({str(x) for x in label_ids if str(x) in known})
        for other_id, client in self.data["clients"].items():
            if other_id == client_id:
                continue
            other = set(client.get("labels", []))
            overlap = other.intersection(clean)
            if overlap:
                other.difference_update(overlap)
                client["labels"] = sorted(other)
                self.data["trees"][other_id] = self._merge_native_places(
                    self.data["trees"].get(other_id, _copy_tree(None, client.get("name", other_id))),
                    other_id,
                )
        self.data["clients"][client_id]["labels"] = clean
        tree = self.data["trees"].get(client_id, _copy_tree(None, self.data["clients"][client_id].get("name", client_id)))
        self.data["trees"][client_id] = self._merge_native_places(tree, client_id)
        self._refresh_location_index()
        await self.async_save()
        await self.async_sync_groups()
        return {"client": client_id, "labels": clean}

    async def async_delete_client(
        self,
        user: User,
        client_id: str,
        *,
        delete_users: bool = False,
    ) -> None:
        """Delete a client, optionally revoking and deleting all of its users."""
        if not self.is_root(user):
            raise HomeAssistantError("Only a Home Assistant administrator can delete clients")
        if client_id not in self.data["clients"]:
            raise HomeAssistantError("Client not found")
        assigned_ids = [
            user_id
            for user_id, record in self.data["users"].items()
            if record.get("client") == client_id
        ]
        if assigned_ids and not delete_users:
            raise HomeAssistantError("Remove or reassign the client's users first")
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
                    raise HomeAssistantError("One of the client's users cannot be deleted")
                targets.append(target)
        del self.data["clients"][client_id]
        self.data["trees"].pop(client_id, None)
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
                raise HomeAssistantError("Only a client administrator can list users")
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
            "location": record.get("location"),
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
        location: str | None,
    ) -> dict[str, Any]:
        """Create a non-admin HA user and attach it to one tenant."""
        actor_client, ctx = self.require_client_value(actor, client_id)
        if not (ctx["is_root"] or ctx["role"] == ROLE_CLIENT_ADMIN):
            raise HomeAssistantError("Only a client administrator can create users")
        if client_id != actor_client:
            raise HomeAssistantError("Clients cannot create users for another client")
        if role not in (ROLE_CLIENT_ADMIN, ROLE_USER):
            raise HomeAssistantError("Invalid portal role")
        if role == ROLE_CLIENT_ADMIN and not ctx["is_root"]:
            raise HomeAssistantError("Only the global administrator can create client administrators")
        if role == ROLE_USER and not location:
            raise HomeAssistantError("Choose a location for an ordinary user")
        if location and location not in self.data.get("locations", {}):
            raise HomeAssistantError("Location not found")
        if location and self.data["locations"][location].get("client") != client_id:
            raise HomeAssistantError("Location belongs to another client")
        name = name.strip()
        username = username.strip().casefold()
        if not name or not username or len(password) < 8:
            raise HomeAssistantError("Name, username and a password of at least 8 characters are required")
        await self.async_sync_groups()
        group_id = self._group_id_for(client_id, role, location)
        if await self.hass.auth.async_get_group(group_id) is None:
            raise HomeAssistantError("Could not create the tenant permission group")
        provider = next((p for p in self.hass.auth.auth_providers if p.type == "homeassistant"), None)
        if provider is None:
            raise HomeAssistantError("The local Home Assistant login provider is not configured")
        credential = provider.async_create_credentials({"username": username})
        # add_auth validates duplicate usernames before the user is created.
        await provider.async_add_auth(username, password)
        try:
            ha_user = await self.hass.auth.async_create_user(name, group_ids=[group_id])
            await self.hass.auth.async_link_user(ha_user, credential)
        except Exception:
            await provider.async_remove_auth(username)
            raise
        self.data["users"][ha_user.id] = {
            "client": client_id,
            "location": location,
            "role": role,
        }
        await self.async_save()
        await self.async_sync_groups()
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
    ) -> dict[str, Any]:
        """Update a user while keeping the target inside the actor's client."""
        target = await self.hass.auth.async_get_user(user_id)
        if target is None or target.system_generated or target.is_owner:
            raise HomeAssistantError("User cannot be changed")
        record = self.data.get("users", {}).get(user_id)
        if not record:
            raise HomeAssistantError("User is not assigned to Optim Energy")
        actor_client, ctx = self.require_client_value(actor)
        if not (ctx["is_root"] or ctx["role"] == ROLE_CLIENT_ADMIN):
            raise HomeAssistantError("Only a client administrator can change users")
        if record.get("client") != actor_client:
            raise HomeAssistantError("User belongs to another client")
        if not ctx["is_root"] and record.get("role") == ROLE_CLIENT_ADMIN:
            raise HomeAssistantError("Only the global administrator can change a client administrator")
        if role is not None:
            if role not in (ROLE_CLIENT_ADMIN, ROLE_USER):
                raise HomeAssistantError("Invalid portal role")
            if role == ROLE_CLIENT_ADMIN and not ctx["is_root"]:
                raise HomeAssistantError("Only the global administrator can create client administrators")
            if role == ROLE_USER and not (location or record.get("location")):
                raise HomeAssistantError("An ordinary user needs a location")
            record["role"] = role
        if location is not None:
            if location and (location not in self.data.get("locations", {}) or self.data["locations"][location].get("client") != actor_client):
                raise HomeAssistantError("Location not found for this client")
            if record.get("role") == ROLE_USER and not location:
                raise HomeAssistantError("An ordinary user needs a location")
            record["location"] = location or None
        if name is not None and name.strip():
            await self.hass.auth.async_update_user(target, name=name.strip())
        if is_active is not None:
            await self.hass.auth.async_update_user(target, is_active=is_active)
        await self.async_save()
        await self.async_sync_groups()
        return self._user_info(target, record)

    async def async_delete_user(self, actor: User, user_id: str) -> None:
        """Delete a client user, never the actor or a global administrator."""
        if user_id == actor.id:
            raise HomeAssistantError("You cannot delete your own account")
        target = await self.hass.auth.async_get_user(user_id)
        record = self.data.get("users", {}).get(user_id)
        if target is None or not record or target.system_generated or target.is_owner:
            raise HomeAssistantError("User cannot be deleted")
        actor_client, ctx = self.require_client_value(actor)
        if not (ctx["is_root"] or ctx["role"] == ROLE_CLIENT_ADMIN):
            raise HomeAssistantError("Only a client administrator can delete users")
        if record.get("client") != actor_client:
            raise HomeAssistantError("User belongs to another client")
        if not ctx["is_root"] and record.get("role") == ROLE_CLIENT_ADMIN:
            raise HomeAssistantError("Only the global administrator can delete a client administrator")
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
                    candidate = self._group_id_for(record["client"], ROLE_CLIENT_ADMIN, None)
                elif role == ROLE_USER and record.get("location"):
                    candidate = self._group_id_for(record["client"], ROLE_USER, record["location"])
                if candidate in group_ids:
                    target = candidate
            # Always reassign the group object. Replacing a group in the
            # private auth store does not invalidate a User's cached
            # permissions until its group list changes.
            await self.hass.auth.async_update_user(ha_user, group_ids=[target])
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

        Areas are the fast path used by HA for all entities attached to a
        device. Explicit entity ids cover entities without a device and devices
        placed by a location label but with no area.
        """
        label_id = location[4:] if location.startswith("loc:") else None
        area_registry = ar.async_get(self.hass)
        device_registry = dr.async_get(self.hass)
        entity_registry = er.async_get(self.hass)
        areas = list(area_registry.async_list_areas())
        area_ids: set[str] = set()
        if label_id:
            area_ids = {a.id for a in areas if label_id in (a.labels or [])}
        elif location:
            # The old portal model can have a location without a native label.
            # Place IDs are enough for the tree fallback; no native area is
            # assumed unless the location id is an HA area id.
            area_ids = {location} if any(a.id == location for a in areas) else set()

        allowed_entities: set[str] = set()
        allowed_devices: set[str] = set()
        # The legacy portal tree can place a device even when it has no HA
        # area or location label. Keep that path working, but only for the
        # location subtree that the tree itself declares.
        allowed_places = _place_descendants(tree, location)
        for device_id, place in (tree.get("placed") or {}).items():
            if place in allowed_places:
                allowed_devices.add(str(device_id))
        for device in device_registry.devices:
            device_labels = set(getattr(device, "labels", ()) or ())
            device_area = getattr(device, "area_id", None)
            by_area = bool(device_area and device_area in area_ids)
            by_label = bool(label_id and label_id in device_labels and not device_area)
            if by_area or by_label:
                allowed_devices.add(device.id)
        for entity in entity_registry.entities.values():
            if entity.device_id in allowed_devices:
                allowed_entities.add(entity.entity_id)
                continue
            if entity.device_id is not None:
                continue
            entity_area = getattr(entity, "area_id", None)
            entity_labels = set(getattr(entity, "labels", ()) or ())
            if (entity_area and entity_area in area_ids) or (label_id and label_id in entity_labels):
                allowed_entities.add(entity.entity_id)
        # Virtual sums live in the tree and may not have a device entry.
        for sum_info in (tree.get("sums") or {}).values():
            if not isinstance(sum_info, dict):
                continue
            for part in sum_info.values():
                if isinstance(part, dict) and part.get("entity"):
                    allowed_entities.add(str(part["entity"]))
        return area_ids, allowed_entities

    def _tree_visible_entities(self, client_id: str) -> set[str]:
        """Return entities in a client tree, including legacy placed devices."""
        tree = self.data.get("trees", {}).get(client_id, {})
        allowed: set[str] = set()
        for place in _place_locations(tree):
            _, entities = self._policy_for_location(client_id, str(place["id"]), tree)
            allowed.update(entities)
        return allowed

    def _device_ids_for_location(
        self,
        tree: dict[str, Any],
        location: str,
        area_ids: set[str],
    ) -> set[str]:
        """Return devices owned by one location, including devices without entities."""
        label_id = location[4:] if location.startswith("loc:") else None
        allowed_places = _place_descendants(tree, location)
        allowed: set[str] = {
            str(device_id)
            for device_id, place in (tree.get("placed") or {}).items()
            if place in allowed_places
        }
        for device in dr.async_get(self.hass).devices:
            device_labels = set(getattr(device, "labels", ()) or ())
            if device.area_id in area_ids or (
                label_id and label_id in device_labels and not device.area_id
            ):
                allowed.add(device.id)
        return allowed

    def _install_registry_watchers(self) -> None:
        """Debounce auth-policy updates when registries change."""
        events = (
            "area_registry_updated",
            "device_registry_updated",
            "entity_registry_updated",
            "label_registry_updated",
            "floor_registry_updated",
        )
        for event in events:
            self._unsubscribers.append(
                self.hass.bus.async_listen(event, self._schedule_group_sync)
            )

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


async def async_setup_tenancy(
    hass: HomeAssistant, site_name: str, initial_tree: dict[str, Any] | None
) -> TenancyManager:
    """Create and initialize the tenant manager."""
    manager = TenancyManager(hass)
    await manager.async_initialize(site_name, initial_tree)
    return manager


def _register_ws(hass: HomeAssistant, handler: Any) -> None:
    websocket_api.async_register_command(hass, handler)


def _error(connection: ActiveConnection, msg: dict[str, Any], message: str) -> None:
    connection.send_error(
        msg["id"], websocket_api.ERR_UNAUTHORIZED, message, translation_domain=DOMAIN
    )


def async_register_commands(hass: HomeAssistant, manager: TenancyManager) -> None:
    """Register the small, checked websocket API used by the portal."""
    hass.data[f"{DOMAIN}_tenancy"] = manager

    @websocket_api.websocket_command({probatio.Required("type"): f"{DOMAIN}/whoami"})
    @websocket_api.async_response
    async def ws_whoami(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        ctx = manager.context(connection.user)
        connection.send_result(
            msg["id"],
            {
                **ctx,
                "clients": manager.client_list(connection.user),
                "capabilities": {
                    "manage_tree": manager.can_manage_tree(ctx),
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
            probatio.Required("type"): f"{DOMAIN}/client/set_locations",
            probatio.Required("client"): str,
            probatio.Required("labels"): [str],
        }
    )
    @websocket_api.async_response
    async def ws_client_set_locations(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            connection.send_result(
                msg["id"],
                await manager.async_set_client_labels(connection.user, msg["client"], msg["labels"]),
            )
        except HomeAssistantError as err:
            _error(connection, msg, str(err))

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/location/catalog",
        }
    )
    @websocket_api.async_response
    async def ws_location_catalog(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        if not manager.is_root(connection.user):
            _error(connection, msg, "Only a Home Assistant administrator can list all location labels")
            return
        registry = lr.async_get(hass)
        labels = []
        for label in registry.async_list_labels():
            if (
                str(getattr(label, "icon", "") or "").startswith("mdi:map-marker")
                or "location" in str(getattr(label, "description", "") or "").lower()
            ):
                location_id = f"loc:{label.label_id}"
                labels.append({
                    "id": label.label_id,
                    "name": label.name,
                    "icon": label.icon,
                    "client": (manager.data.get("locations", {}).get(location_id) or {}).get("client"),
                })
        connection.send_result(msg["id"], labels)

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/bill/read",
            probatio.Required("body"): str,
        }
    )
    @websocket_api.async_response
    async def ws_bill_read(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            _, ctx = manager.require_client_value(connection.user)
            if not ctx.get("is_root") and not ctx.get("role"):
                raise HomeAssistantError("No tenant assignment")
            body = msg["body"]
            if len(body) > 300_000:
                raise HomeAssistantError("Bill payload is too large")
            response = await hass.services.async_call(
                "rest_command",
                "discretestack_chat",
                {"body": body},
                blocking=True,
                return_response=True,
                context=connection.context(msg),
            )
            connection.send_result(msg["id"], {"response": response})
        except (HomeAssistantError, ValueError) as err:
            _error(connection, msg, str(err))

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
        ws_client_delete,
        ws_client_set_locations,
        ws_location_catalog,
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
        "name",
        "platform",
        "unique_id",
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
        if root or ctx.get("role") == ROLE_CLIENT_ADMIN:
            locations = _place_locations(tree)
        else:
            locations = [
                place
                for place in _place_locations(tree)
                if place.get("id") == record.get("location")
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
    label_ids = set(self.data.get("clients", {}).get(client_id, {}).get("labels", []))
    label_items = list(lr_reg.async_list_labels())
    if not (root and not scoped_root):
        label_items = [x for x in label_items if x.label_id in allowed_labels or x.label_id in label_ids]
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
