"""Checked portal operations for client administrators.

This module is the only place where a non-HA-admin portal role can mutate
Home Assistant configuration. Every command resolves the caller's client from
the tenant store and validates targets against that client's compiled entity
permissions before touching files, registries or config entries.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import os
import re
import uuid
from collections.abc import Iterable
from typing import Any

import probatio
from homeassistant.components import websocket_api
from homeassistant.components.automation import DATA_COMPONENT as AUTOMATION_DATA
from homeassistant.components.automation import DOMAIN as AUTOMATION_DOMAIN
from homeassistant.components.automation.config import async_validate_config_item
from homeassistant.components.websocket_api import ActiveConnection
from homeassistant.config import AUTOMATION_CONFIG_PATH
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import (
    area_registry as ar,
    device_registry as dr,
    entity_registry as er,
    label_registry as lr,
)
from homeassistant.util.file import write_utf8_file_atomic
from homeassistant.util.yaml import dump, load_yaml

from .const import DOMAIN
from .tenancy import ROLE_CLIENT_ADMIN, TenancyManager

_LOGGER = logging.getLogger(__name__)

_TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
_DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_SWITCH_DOMAINS = {"switch", "light", "fan", "input_boolean"}
_MAX_NAME = 80
_MAX_TARGETS = 250
# Both are pasted into an automation template, which runs with no user and so
# with every permission. Nothing outside these shapes may reach it.
_ENTITY_ID_RE = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")
_UNIT_RE = re.compile(r"^[A-Za-z%°µ/²³ ]{0,12}$")


def alert_message(severity: str, rule_entity: str, sensor: str, unit: str) -> str:
    """Build the notification template for an alert rule from checked parts."""
    if not _ENTITY_ID_RE.match(rule_entity) or not _ENTITY_ID_RE.match(sensor):
        raise HomeAssistantError("The alert rule or sensor is not a valid entity")
    if not _UNIT_RE.match(unit):
        raise HomeAssistantError("The unit is not valid")
    now = (
        f"{{{{ (states('{sensor}') | float(0) / 1000) | round(1) }}}} kW"
        if unit == "W"
        else f"{{{{ states('{sensor}') }}}} {unit}"
    )
    return (
        f"{'Critical' if severity == 'critical' else 'Warning'}: "
        f"{{{{ state_attr('{rule_entity}', 'friendly_name') }}}}. Now {now}."
    )


def build_schedule_config(
    config_id: str,
    name: str,
    how: str,
    at: str,
    days: list[str],
    switches: list[str],
) -> dict[str, Any]:
    """Build the only automation shape client admins may save."""
    if not name or len(name) > _MAX_NAME:
        raise HomeAssistantError("Enter a name of up to 80 characters")
    if how not in ("on", "off"):
        raise HomeAssistantError("The action must be on or off")
    if not _TIME_RE.match(at):
        raise HomeAssistantError("Time must use HH:MM")
    clean_days = [day for day in _DAYS if day in set(days)]
    if not clean_days:
        raise HomeAssistantError("Choose at least one day")
    clean_switches = sorted({str(value) for value in switches})
    if not clean_switches or len(clean_switches) > _MAX_TARGETS:
        raise HomeAssistantError("Choose between 1 and 250 switches")
    if any(value.partition(".")[0] not in _SWITCH_DOMAINS or "." not in value for value in clean_switches):
        raise HomeAssistantError("Only switch, light, fan and input_boolean entities are supported")
    config: dict[str, Any] = {
        "id": config_id,
        "alias": name,
        "triggers": [{"trigger": "time", "at": f"{at}:00"}],
        "conditions": [],
        "actions": [
            {
                "action": f"switch.turn_{how}",
                "target": {"entity_id": clean_switches},
            }
        ],
    }
    if len(clean_days) < len(_DAYS):
        config["conditions"] = [{"condition": "time", "weekday": clean_days}]
    return config


class PortalOperations:
    """Tenant-aware registry, automation and helper operations."""

    def __init__(self, hass: HomeAssistant, manager: TenancyManager) -> None:
        self.hass = hass
        self.manager = manager
        self._automation_lock = asyncio.Lock()
        self._helper_lock = asyncio.Lock()

    def _require_manager(
        self, user: Any, client: str | None = None
    ) -> tuple[str, dict[str, Any], dict[str, Any]]:
        """Resolve the caller's client; only root may name another one."""
        client_id, ctx = self.manager.require_client_value(user, client)
        if not (ctx.get("is_root") or ctx.get("role") == ROLE_CLIENT_ADMIN):
            raise HomeAssistantError("Only a client administrator can change portal settings")
        payload = self.manager.tree_for(user, client_id if ctx.get("is_root") else None)
        return client_id, ctx, payload["tree"]

    def _entity_allowed(self, user: Any, entity_id: str) -> bool:
        if self.manager.is_root(user):
            return True
        return bool(user.permissions.check_entity(entity_id, "read"))

    def _entity_control_allowed(self, user: Any, entity_id: str) -> bool:
        if self.manager.is_root(user):
            return True
        return bool(user.permissions.check_entity(entity_id, "control"))

    def _owns(self, user: Any, client_id: str, kind: str, value: str) -> bool:
        """Root may touch any portal object; a client only what it created."""
        return self.manager.is_root(user) or self.manager.owns(client_id, kind, value)

    async def _async_record_owned(
        self, client_id: str, kind: str, value: str, undo: Any
    ) -> None:
        """Record a new object's owner, or remove the object if that fails."""
        try:
            await self.manager.async_set_owned(client_id, kind, value, True)
        except Exception:
            await undo()
            raise

    def audit_owned(self) -> None:
        """Log ownership records and portal objects that no longer match."""
        registry = er.async_get(self.hass)
        automation_ids = {
            str(entry.unique_id)
            for entry in registry.entities.values()
            if entry.domain == AUTOMATION_DOMAIN
        }
        claimed: set[str] = set()
        for client_id, record in self.manager.data.get("owned", {}).items():
            for entry_id in record.get("entries", []):
                if self.hass.config_entries.async_get_entry(entry_id) is None:
                    _LOGGER.warning("Optim Energy: helper %s of client %s no longer exists", entry_id, client_id)
            for config_id in record.get("automations", []):
                claimed.add(config_id)
                if config_id not in automation_ids:
                    _LOGGER.warning("Optim Energy: automation %s of client %s no longer exists", config_id, client_id)
        for config_id in sorted(automation_ids - claimed):
            if config_id.startswith("portal_"):
                _LOGGER.warning("Optim Energy: portal automation %s has no owning client", config_id)

    def _entity_entry(self, entity_id: str) -> Any:
        entry = er.async_get(self.hass).async_get(entity_id)
        if entry is None:
            raise HomeAssistantError("Entity is not managed by a Home Assistant registry")
        return entry

    def _client_area_ids(self, tree: dict[str, Any]) -> set[str]:
        """Return the areas that belong to locations in this client tree."""
        out: set[str] = set()
        for place in tree.get("places", []):
            if not isinstance(place, dict) or place.get("kind") != "location":
                continue
            location = str(place.get("id") or "")
            if not location:
                continue
            area_ids, _ = self.manager._policy_for_location(  # noqa: SLF001
                "", location, tree
            )
            out.update(area_ids)
        return out

    def _client_location_labels(self, tree: dict[str, Any]) -> set[str]:
        return {
            str(place["id"])[4:]
            for place in tree.get("places", [])
            if isinstance(place, dict)
            and place.get("kind") == "location"
            and str(place.get("id", "")).startswith("loc:")
        }

    def _validate_labels(self, tree: dict[str, Any], labels: Iterable[str]) -> list[str]:
        registry = lr.async_get(self.hass)
        allowed_locations = self._client_location_labels(tree)
        clean: list[str] = []
        for label_id in sorted({str(value) for value in labels}):
            entry = registry.async_get_label(label_id)
            if entry is None:
                raise HomeAssistantError("A selected label does not exist")
            is_location = str(getattr(entry, "icon", "") or "").startswith(
                "mdi:map-marker"
            ) or "location" in str(getattr(entry, "description", "") or "").lower()
            if is_location and label_id not in allowed_locations:
                raise HomeAssistantError("A location label belongs to another client")
            clean.append(label_id)
        return clean

    def _validate_area(self, tree: dict[str, Any], area_id: str | None) -> None:
        if area_id and area_id not in self._client_area_ids(tree):
            raise HomeAssistantError("The area belongs to another client")

    def _place_location(self, tree: dict[str, Any], place_id: str | None) -> str | None:
        if not place_id:
            return None
        places = {
            str(place.get("id")): place
            for place in tree.get("places", [])
            if isinstance(place, dict) and place.get("id")
        }
        seen: set[str] = set()
        current = place_id
        while current and current not in seen:
            seen.add(current)
            if current.startswith("loc:"):
                return current
            entry = places.get(current)
            if entry is None:
                break
            current = entry.get("parent")
        raise HomeAssistantError("The selected group is not in this client")

    async def _async_update_entity_placement(
        self,
        user: Any,
        tree: dict[str, Any],
        entity_id: str,
        *,
        name: str | None = None,
        area_id: str | None = None,
        labels: list[str] | None = None,
        place: str | None = None,
        trusted: bool = False,
    ) -> Any:
        """Update a permitted entity and, optionally, place it in a portal group."""
        if not trusted and not self._entity_allowed(user, entity_id):
            raise HomeAssistantError("Entity belongs to another client")
        self._validate_area(tree, area_id)
        if place:
            location = self._place_location(tree, place)
            if location is None:
                raise HomeAssistantError("Choose a location for the entity")
            if place.startswith("area:"):
                area_id = place[5:]
                self._validate_area(tree, area_id)
            elif location.startswith("loc:"):
                requested = labels or []
                requested = [
                    value for value in requested if value not in self._client_location_labels(tree)
                ]
                labels = [*requested, location[4:]]
        if labels is not None:
            labels = self._validate_labels(tree, labels)
        changes: dict[str, Any] = {}
        if name is not None:
            changes["name"] = name
        if area_id is not None:
            changes["area_id"] = area_id
        if labels is not None:
            changes["labels"] = labels
        registry = er.async_get(self.hass)
        return registry.async_update_entity(entity_id, **changes)

    async def async_update_entity(
        self,
        user: Any,
        entity_id: str,
        *,
        name: str | None = None,
        area_id: str | None = None,
        labels: list[str] | None = None,
        place: str | None = None,
        client: str | None = None,
    ) -> dict[str, Any]:
        _, _, tree = self._require_manager(user, client)
        entry = await self._async_update_entity_placement(
            user,
            tree,
            entity_id,
            name=name,
            area_id=area_id,
            labels=labels,
            place=place,
        )
        return {"entity_id": entity_id, "entry": entry.extended_dict}

    async def async_update_device(
        self, user: Any, device_id: str, name_by_user: str
    ) -> dict[str, Any]:
        _, _, tree = self._require_manager(user)
        registry = dr.async_get(self.hass)
        device = next((item for item in registry.devices if item.id == device_id), None)
        if device is None:
            raise HomeAssistantError("Device not found")
        if not self.manager.is_root(user):
            entities = er.async_get(self.hass)
            owned = any(
                entry.device_id == device_id and self._entity_allowed(user, entry.entity_id)
                for entry in entities.entities.values()
            )
            if not owned:
                raise HomeAssistantError("Device belongs to another client")
        name = name_by_user.strip()
        if not name or len(name) > _MAX_NAME:
            raise HomeAssistantError("Enter a device name of up to 80 characters")
        registry.async_update_device(device_id, name_by_user=name)
        return {"device_id": device_id, "name": name}

    async def _async_finish_flow(
        self,
        flow_manager: Any,
        init_result: dict[str, Any],
        data: dict[str, Any],
        *,
        next_step_id: str = "sensor",
    ) -> dict[str, Any]:
        """Complete a schema config or options flow."""
        result = init_result
        needs_step = result.get("type") is FlowResultType.MENU
        if (
            result.get("type") is FlowResultType.FORM
            and result.get("step_id") == "init"
            and not result.get("data_schema")
        ):
            needs_step = True
        if needs_step:
            result = await flow_manager.async_configure(
                result["flow_id"], {"next_step_id": next_step_id}
            )
        if result.get("type") is FlowResultType.FORM:
            result = await flow_manager.async_configure(result["flow_id"], data)
        if result.get("type") is not FlowResultType.CREATE_ENTRY:
            reason = result.get("reason") or result.get("errors") or result.get("type")
            raise HomeAssistantError(f"Home Assistant rejected the helper: {reason}")
        return result

    async def _async_wait_for_entry_entity(self, entry_id: str, domain: str) -> str:
        registry = er.async_get(self.hass)
        for _ in range(30):
            for entity in registry.entities.values():
                if entity.config_entry_id == entry_id and entity.domain == domain:
                    return entity.entity_id
            await asyncio.sleep(0.2)
        raise HomeAssistantError("Helper was saved but its entity did not become available")

    async def async_save_threshold(
        self,
        user: Any,
        *,
        entity_id: str | None,
        name: str,
        sensor: str,
        upper: float | None,
        lower: float | None,
        hysteresis: float,
        place: str,
        labels: list[str],
        client: str | None = None,
    ) -> dict[str, Any]:
        """Create or update a threshold helper for the caller's client."""
        client_id, _, tree = self._require_manager(user, client)
        if not self._entity_allowed(user, sensor):
            raise HomeAssistantError("The watched entity belongs to another client")
        if (upper is None) == (lower is None):
            raise HomeAssistantError("Choose exactly one threshold")
        if not name.strip() or len(name.strip()) > _MAX_NAME:
            raise HomeAssistantError("Enter a rule name of up to 80 characters")
        if hysteresis < 0:
            raise HomeAssistantError("Hysteresis cannot be negative")
        fields = {
            "entity_id": sensor,
            "hysteresis": float(hysteresis),
            **({"upper": float(upper)} if upper is not None else {}),
            **({"lower": float(lower)} if lower is not None else {}),
        }
        entry_id = ""
        helper_entity = entity_id
        if helper_entity:
            if not self._entity_allowed(user, helper_entity):
                raise HomeAssistantError("Alert rule belongs to another client")
            current = self._entity_entry(helper_entity)
            entry_id = str(current.config_entry_id or "")
            entry = self.hass.config_entries.async_get_entry(entry_id)
            if entry is None or entry.domain != "threshold":
                raise HomeAssistantError("The selected entity is not a threshold rule")
            if not self._owns(user, client_id, "entries", entry_id):
                raise HomeAssistantError("Alert rule belongs to another client")
            async with self._helper_lock:
                init_result = await self.hass.config_entries.options.async_init(entry_id)
                await self._async_finish_flow(
                    self.hass.config_entries.options, init_result, fields
                )
        else:
            async with self._helper_lock:
                init_result = await self.hass.config_entries.flow.async_init(
                    "threshold", context={"source": "user"}
                )
                result = await self._async_finish_flow(
                    self.hass.config_entries.flow,
                    init_result,
                    {"name": name.strip(), **fields},
                )
            created = result.get("result")
            entry_id = str(getattr(created, "entry_id", created))
            await self._async_record_owned(
                client_id,
                "entries",
                entry_id,
                lambda: self.hass.config_entries.async_remove(entry_id),
            )
            helper_entity = await self._async_wait_for_entry_entity(entry_id, "binary_sensor")

        await self._async_update_entity_placement(
            user,
            tree,
            helper_entity,
            name=name.strip(),
            labels=labels,
            place=place,
            trusted=not bool(entity_id),
        )
        return {"entity_id": helper_entity, "entry_id": entry_id}

    async def async_delete_helper(
        self, user: Any, entity_id: str, client: str | None = None
    ) -> None:
        """Delete an alert-rule helper the caller's client created."""
        client_id, _, _ = self._require_manager(user, client)
        entry = self._entity_entry(entity_id)
        entry_id = str(entry.config_entry_id or "")
        config_entry = self.hass.config_entries.async_get_entry(entry_id)
        if config_entry is None or config_entry.domain != "threshold":
            raise HomeAssistantError("The selected entity is not a portal helper")
        if not self._owns(user, client_id, "entries", entry_id):
            raise HomeAssistantError("Helper belongs to another client")
        await self.hass.config_entries.async_remove(entry_id)
        await self.manager.async_set_owned(client_id, "entries", entry_id, False)

    async def async_save_sum(
        self,
        user: Any,
        *,
        virtual_id: str,
        kind: str,
        name: str,
        members: list[str],
        entry_id: str | None,
        client: str | None = None,
    ) -> dict[str, Any]:
        """Create or update a Sum helper owned by a virtual portal device.

        A tenant browser cannot write the tree's ``virtual`` or ``sums`` keys,
        so the stored entry id is a trustworthy ownership record.
        """
        client_id, _, tree = self._require_manager(user, client)
        if kind not in ("energy", "power"):
            raise HomeAssistantError("Sum kind must be energy or power")
        if not any(
            isinstance(item, dict) and item.get("id") == virtual_id
            for item in tree.get("virtual", [])
        ):
            raise HomeAssistantError("Virtual device belongs to another client")
        clean_members = sorted({str(value) for value in members})
        if any(not self._entity_allowed(user, value) for value in clean_members):
            raise HomeAssistantError("A Sum member belongs to another client")
        current = (tree.get("sums", {}).get(virtual_id, {}) or {}).get(kind, {})
        if entry_id and current.get("entry") != entry_id:
            raise HomeAssistantError("Sum helper ownership is not valid")
        if not name.strip() or len(name.strip()) > _MAX_NAME:
            raise HomeAssistantError("Enter a Sum name of up to 80 characters")
        result_entry_id = entry_id
        if result_entry_id:
            config_entry = self.hass.config_entries.async_get_entry(result_entry_id)
            if config_entry is None or config_entry.domain != "group":
                raise HomeAssistantError("Sum helper no longer exists")
            async with self._helper_lock:
                init_result = await self.hass.config_entries.options.async_init(result_entry_id)
                await self._async_finish_flow(
                    self.hass.config_entries.options,
                    init_result,
                    {
                        "entities": clean_members,
                        "hide_members": False,
                        "type": "sum",
                        "ignore_non_numeric": False,
                    },
                )
        else:
            async with self._helper_lock:
                init_result = await self.hass.config_entries.flow.async_init(
                    "group", context={"source": "user"}
                )
                result = await self._async_finish_flow(
                    self.hass.config_entries.flow,
                    init_result,
                    {
                        "name": name.strip(),
                        "entities": clean_members,
                        "hide_members": False,
                        "type": "sum",
                    },
                )
                created = result.get("result")
                result_entry_id = str(getattr(created, "entry_id", created))
        helper_entity = current.get("entity") or await self._async_wait_for_entry_entity(
            result_entry_id, "sensor"
        )
        tree.setdefault("sums", {}).setdefault(virtual_id, {})[kind] = {
            "entry": result_entry_id,
            "entity": helper_entity,
            "members": clean_members,
        }
        try:
            await self.manager.async_store_tree(client_id, tree)
        except Exception:
            if not entry_id:
                # A helper nobody owns could never be deleted from the portal.
                await self.hass.config_entries.async_remove(result_entry_id)
            raise
        return {"entry_id": result_entry_id, "entity_id": helper_entity}

    async def async_delete_sum(
        self, user: Any, virtual_id: str, kind: str, client: str | None = None
    ) -> None:
        """Delete one Sum helper owned by a virtual portal device."""
        client_id, _, tree = self._require_manager(user, client)
        current = (tree.get("sums", {}).get(virtual_id, {}) or {}).get(kind)
        if not isinstance(current, dict) or not current.get("entry"):
            raise HomeAssistantError("Sum helper is not owned by this virtual device")
        config_entry = self.hass.config_entries.async_get_entry(str(current["entry"]))
        # Never remove anything but a group helper, whatever the tree says.
        if config_entry is not None:
            if config_entry.domain != "group":
                raise HomeAssistantError("Sum helper is not owned by this virtual device")
            await self.hass.config_entries.async_remove(config_entry.entry_id)
        tree["sums"][virtual_id].pop(kind, None)
        if not tree["sums"][virtual_id]:
            tree["sums"].pop(virtual_id, None)
        await self.manager.async_store_tree(client_id, tree)

    async def async_save_alert_automation(
        self,
        user: Any,
        *,
        rule_entity: str,
        name: str,
        sensor: str,
        unit: str,
        severity: str,
        targets: list[str],
        client: str | None = None,
    ) -> dict[str, Any]:
        """Create the fixed portal notification automation for an alert rule."""
        client_id, _, _ = self._require_manager(user, client)
        if severity not in ("warn", "critical"):
            raise HomeAssistantError("Invalid alert severity")
        message = alert_message(severity, rule_entity, sensor, unit)
        if not self._entity_allowed(user, rule_entity) or not self._entity_allowed(user, sensor):
            raise HomeAssistantError("Alert rule belongs to another client")
        rule_entry = self._entity_entry(rule_entity)
        if not self._owns(user, client_id, "entries", str(rule_entry.config_entry_id or "")):
            raise HomeAssistantError("Alert rule belongs to another client")
        config_id = f"portal_alert_{rule_entity.split('.', 1)[-1]}"
        on_actions = [
            {
                "action": "persistent_notification.create",
                "data": {
                    "notification_id": config_id,
                    "title": "Energy alert",
                    "message": message,
                },
            }
        ]
        config = {
            "id": config_id,
            "alias": f"Portal alert: {name}",
            "description": f"Made by the portal for the alert rule {rule_entity}. It is deleted with the rule.",
            "mode": "queued",
            "triggers": [
                {"trigger": "state", "entity_id": rule_entity, "from": "off", "to": "on", "id": "on"},
                {"trigger": "state", "entity_id": rule_entity, "from": "on", "to": "off", "id": "off"},
            ],
            "conditions": [],
            "actions": [
                {
                    "choose": [
                        {
                            "conditions": [{"condition": "trigger", "id": "on"}],
                            "sequence": on_actions,
                        }
                    ],
                    "default": [
                        {
                            "action": "persistent_notification.dismiss",
                            "data": {"notification_id": config_id},
                        }
                    ],
                }
            ],
        }
        await self._async_write_automations(config_id, config)
        await self._async_record_owned(
            client_id,
            "automations",
            config_id,
            lambda: self._async_write_automations(config_id, None),
        )
        automation_entity = await self._async_find_automation(config_id)
        return {"entity_id": automation_entity, "config": config}

    async def async_entity_entry(self, user: Any, entity_id: str) -> dict[str, Any]:
        self._require_manager(user)
        if not self._entity_allowed(user, entity_id):
            raise HomeAssistantError("Entity belongs to another client")
        entry = self._entity_entry(entity_id)
        return entry.extended_dict

    def _automation_entity_config(self, entity_id: str) -> dict[str, Any] | None:
        component = self.hass.data.get(AUTOMATION_DATA)
        entity = component.get_entity(entity_id) if component is not None else None
        raw = getattr(entity, "raw_config", None)
        return copy.deepcopy(raw) if isinstance(raw, dict) else None

    def _automation_config_id(self, entity_id: str) -> str:
        state = self.hass.states.get(entity_id)
        config_id = str(state.attributes.get("id") or "") if state else ""
        if not config_id:
            config_id = str((self._automation_entity_config(entity_id) or {}).get("id") or "")
        return config_id

    def _automation_owned(self, user: Any, client_id: str, entity_id: str) -> bool:
        """An automation belongs to the client whose command created it."""
        return self._owns(user, client_id, "automations", self._automation_config_id(entity_id))

    async def async_automation_get(
        self, user: Any, entity_id: str, client: str | None = None
    ) -> dict[str, Any]:
        client_id, _, _ = self._require_manager(user, client)
        if not self._automation_owned(user, client_id, entity_id):
            raise HomeAssistantError("Automation belongs to another client")
        config = self._automation_entity_config(entity_id)
        if config is None:
            raise HomeAssistantError("Automation configuration is not available")
        return config

    async def _async_write_automations(self, config_id: str, config: dict[str, Any] | None) -> None:
        path = self.hass.config.path(AUTOMATION_CONFIG_PATH)
        async with self._automation_lock:
            data = None
            if await self.hass.async_add_executor_job(os.path.isfile, path):
                data = await self.hass.async_add_executor_job(load_yaml, path)
            items = data if isinstance(data, list) else []
            if config is not None:
                await async_validate_config_item(self.hass, config_id, config)
                found = False
                for index, item in enumerate(items):
                    if isinstance(item, dict) and item.get("id") == config_id:
                        items[index] = config
                        found = True
                if not found:
                    items.append(config)
            else:
                items = [
                    item
                    for item in items
                    if not (isinstance(item, dict) and item.get("id") == config_id)
                ]

            def write() -> None:
                write_utf8_file_atomic(path, dump(items))

            await self.hass.async_add_executor_job(write)
        if config is None:
            registry = er.async_get(self.hass)
            for entry in list(registry.entities.values()):
                if (
                    entry.domain == AUTOMATION_DOMAIN
                    and entry.unique_id == config_id
                ):
                    registry.async_remove(entry.entity_id)
        try:
            await self.hass.services.async_call(
                AUTOMATION_DOMAIN,
                "reload",
                {"id": config_id},
                blocking=True,
            )
        except HomeAssistantError:
            pass

    async def _async_find_automation(self, config_id: str) -> str:
        for _ in range(25):
            for state in self.hass.states.async_all(AUTOMATION_DOMAIN):
                if state.attributes.get("id") == config_id:
                    return state.entity_id
            await asyncio.sleep(0.2)
        raise HomeAssistantError("Automation was saved but did not start")

    async def async_save_schedule(
        self,
        user: Any,
        *,
        entity_id: str | None,
        name: str,
        place: str,
        how: str,
        at: str,
        days: list[str],
        switches: list[str],
        client: str | None = None,
    ) -> dict[str, Any]:
        client_id, _, tree = self._require_manager(user, client)
        for target in switches:
            if not self._entity_control_allowed(user, target):
                raise HomeAssistantError("A selected switch belongs to another client")
        if place not in {
            str(item.get("id"))
            for item in tree.get("places", [])
            if isinstance(item, dict)
        }:
            raise HomeAssistantError("Choose a group from this client")

        config_id = ""
        if entity_id:
            if not self._automation_owned(user, client_id, entity_id):
                raise HomeAssistantError("Automation belongs to another client")
            config_id = self._automation_config_id(entity_id)
        created = not config_id
        if created:
            config_id = f"portal_{uuid.uuid4().hex[:12]}"

        config = build_schedule_config(config_id, name, how, at, days, switches)
        await self._async_write_automations(config_id, config)
        if created:
            await self._async_record_owned(
                client_id,
                "automations",
                config_id,
                lambda: self._async_write_automations(config_id, None),
            )
        automation_entity = await self._async_find_automation(config_id)
        await self._async_update_entity_placement(
            user, tree, automation_entity, name=name, place=place, trusted=not bool(entity_id)
        )

        entries = [
            item
            for item in tree.get("automations", [])
            if isinstance(item, dict) and item.get("entity") != automation_entity
        ]
        entries.append(
            {
                "entity": automation_entity,
                "name": name,
                "at": at,
                "place": place,
                "devices": len(switches),
                "how": how,
                "days": days,
            }
        )
        tree["automations"] = entries
        await self.manager.async_store_tree(client_id, tree)
        return {"entity_id": automation_entity, "config": config}

    async def async_delete_automation(
        self, user: Any, entity_id: str, client: str | None = None
    ) -> None:
        client_id, _, tree = self._require_manager(user, client)
        if not self._automation_owned(user, client_id, entity_id):
            raise HomeAssistantError("Automation belongs to another client")
        config_id = self._automation_config_id(entity_id)
        if config_id:
            await self._async_write_automations(config_id, None)
            await self.manager.async_set_owned(client_id, "automations", config_id, False)
        tree["automations"] = [
            item
            for item in tree.get("automations", [])
            if not (isinstance(item, dict) and item.get("entity") == entity_id)
        ]
        await self.manager.async_store_tree(client_id, tree)


def _send_error(connection: ActiveConnection, msg: dict[str, Any], err: Exception) -> None:
    connection.send_error(
        msg["id"],
        "unauthorized",
        str(err),
        translation_domain=DOMAIN,
        translation_key="operation_denied",
    )


def async_register_portal_commands(hass: HomeAssistant, manager: TenancyManager) -> None:
    """Register the checked client-administrator command surface."""
    ops = PortalOperations(hass, manager)
    hass.data[f"{DOMAIN}_portal_ops"] = ops
    ops.audit_owned()

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/entity/get",
            probatio.Optional("client"): str,
            probatio.Required("entity_id"): str,
        }
    )
    @websocket_api.async_response
    async def ws_entity_get(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            connection.send_result(msg["id"], await ops.async_entity_entry(connection.user, msg["entity_id"]))
        except HomeAssistantError as err:
            _send_error(connection, msg, err)

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/entity/update",
            probatio.Optional("client"): str,
            probatio.Required("entity_id"): str,
            probatio.Optional("name"): str,
            probatio.Optional("area_id"): str,
            probatio.Optional("labels"): [str],
            probatio.Optional("place"): str,
        }
    )
    @websocket_api.async_response
    async def ws_entity_update(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            area_id = msg.get("area_id")
            if area_id == "":
                area_id = None
            connection.send_result(
                msg["id"],
                await ops.async_update_entity(
                    connection.user,
                    msg["entity_id"],
                    name=msg.get("name"),
                    area_id=area_id,
                    labels=msg.get("labels"),
                    place=msg.get("place"),
                    client=msg.get("client"),
                ),
            )
        except HomeAssistantError as err:
            _send_error(connection, msg, err)

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/device/update",
            probatio.Optional("client"): str,
            probatio.Required("device_id"): str,
            probatio.Required("name"): str,
        }
    )
    @websocket_api.async_response
    async def ws_device_update(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            connection.send_result(
                msg["id"],
                await ops.async_update_device(connection.user, msg["device_id"], msg["name"]),
            )
        except HomeAssistantError as err:
            _send_error(connection, msg, err)

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/automation/get",
            probatio.Optional("client"): str,
            probatio.Required("entity_id"): str,
        }
    )
    @websocket_api.async_response
    async def ws_automation_get(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            connection.send_result(
                msg["id"], {"config": await ops.async_automation_get(connection.user, msg["entity_id"], msg.get("client"))}
            )
        except HomeAssistantError as err:
            _send_error(connection, msg, err)

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/automation/save_schedule",
            probatio.Optional("client"): str,
            probatio.Optional("entity_id"): str,
            probatio.Required("name"): str,
            probatio.Required("place"): str,
            probatio.Required("how"): str,
            probatio.Required("at"): str,
            probatio.Required("days"): [str],
            probatio.Required("switches"): [str],
        }
    )
    @websocket_api.async_response
    async def ws_automation_save_schedule(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            connection.send_result(
                msg["id"],
                await ops.async_save_schedule(
                    connection.user,
                    entity_id=msg.get("entity_id"),
                    name=msg["name"],
                    place=msg["place"],
                    how=msg["how"],
                    at=msg["at"],
                    days=msg["days"],
                    switches=msg["switches"],
                    client=msg.get("client"),
                ),
            )
        except HomeAssistantError as err:
            _send_error(connection, msg, err)

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/automation/delete",
            probatio.Optional("client"): str,
            probatio.Required("entity_id"): str,
        }
    )
    @websocket_api.async_response
    async def ws_automation_delete(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            await ops.async_delete_automation(connection.user, msg["entity_id"], msg.get("client"))
            connection.send_result(msg["id"], {"deleted": True})
        except HomeAssistantError as err:
            _send_error(connection, msg, err)

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/helper/threshold/save",
            probatio.Optional("client"): str,
            probatio.Optional("entity_id"): str,
            probatio.Required("name"): str,
            probatio.Required("sensor"): str,
            probatio.Optional("upper"): float,
            probatio.Optional("lower"): float,
            probatio.Required("hysteresis"): float,
            probatio.Required("place"): str,
            probatio.Required("labels"): [str],
        }
    )
    @websocket_api.async_response
    async def ws_threshold_save(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            connection.send_result(
                msg["id"],
                await ops.async_save_threshold(
                    connection.user,
                    entity_id=msg.get("entity_id"),
                    name=msg["name"],
                    sensor=msg["sensor"],
                    upper=msg.get("upper"),
                    lower=msg.get("lower"),
                    hysteresis=msg["hysteresis"],
                    place=msg["place"],
                    labels=msg["labels"],
                    client=msg.get("client"),
                ),
            )
        except HomeAssistantError as err:
            _send_error(connection, msg, err)

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/helper/delete",
            probatio.Optional("client"): str,
            probatio.Required("entity_id"): str,
        }
    )
    @websocket_api.async_response
    async def ws_helper_delete(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            await ops.async_delete_helper(connection.user, msg["entity_id"], msg.get("client"))
            connection.send_result(msg["id"], {"deleted": True})
        except HomeAssistantError as err:
            _send_error(connection, msg, err)

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/helper/sum/save",
            probatio.Optional("client"): str,
            probatio.Required("virtual_id"): str,
            probatio.Required("kind"): str,
            probatio.Required("name"): str,
            probatio.Required("members"): [str],
            probatio.Optional("entry_id"): str,
        }
    )
    @websocket_api.async_response
    async def ws_sum_save(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            connection.send_result(
                msg["id"],
                await ops.async_save_sum(
                    connection.user,
                    virtual_id=msg["virtual_id"],
                    kind=msg["kind"],
                    name=msg["name"],
                    members=msg["members"],
                    entry_id=msg.get("entry_id"),
                    client=msg.get("client"),
                ),
            )
        except HomeAssistantError as err:
            _send_error(connection, msg, err)

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/helper/sum/delete",
            probatio.Optional("client"): str,
            probatio.Required("virtual_id"): str,
            probatio.Required("kind"): str,
        }
    )
    @websocket_api.async_response
    async def ws_sum_delete(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            await ops.async_delete_sum(connection.user, msg["virtual_id"], msg["kind"], msg.get("client"))
            connection.send_result(msg["id"], {"deleted": True})
        except HomeAssistantError as err:
            _send_error(connection, msg, err)

    @websocket_api.websocket_command(
        {
            probatio.Required("type"): f"{DOMAIN}/automation/save_alert",
            probatio.Optional("client"): str,
            probatio.Required("rule_entity"): str,
            probatio.Required("name"): str,
            probatio.Required("sensor"): str,
            probatio.Required("unit"): str,
            probatio.Required("severity"): str,
            probatio.Required("targets"): [str],
        }
    )
    @websocket_api.async_response
    async def ws_automation_save_alert(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            connection.send_result(
                msg["id"],
                await ops.async_save_alert_automation(
                    connection.user,
                    rule_entity=msg["rule_entity"],
                    name=msg["name"],
                    sensor=msg["sensor"],
                    unit=msg["unit"],
                    severity=msg["severity"],
                    targets=msg["targets"],
                    client=msg.get("client"),
                ),
            )
        except HomeAssistantError as err:
            _send_error(connection, msg, err)

    for handler in (
        ws_entity_get,
        ws_entity_update,
        ws_device_update,
        ws_automation_get,
        ws_automation_save_schedule,
        ws_automation_delete,
        ws_threshold_save,
        ws_helper_delete,
        ws_sum_save,
        ws_sum_delete,
        ws_automation_save_alert,
    ):
        websocket_api.async_register_command(hass, handler)
