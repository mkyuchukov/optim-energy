"""Runtime-only registry fixture used by the acceptance suite."""

from __future__ import annotations

from typing import Any

import probatio
from homeassistant.components import websocket_api
from homeassistant.components.websocket_api import ActiveConnection
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, label_registry as lr


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    """Register a device-creation command after Optim Energy has started."""

    @websocket_api.require_admin
    @websocket_api.websocket_command(
        {
            probatio.Required("type"): "optim_runtime_fixture/create_devices",
            probatio.Required("devices"): [
                {
                    probatio.Required("key"): str,
                    probatio.Required("name"): str,
                    probatio.Optional("area_id"): str,
                    probatio.Optional("labels"): [str],
                }
            ],
        }
    )
    @callback
    def websocket_create_devices(
        hass: HomeAssistant,
        connection: ActiveConnection,
        msg: dict[str, Any],
    ) -> None:
        registry = dr.async_get(hass)
        created = []
        for spec in msg["devices"]:
            device = registry.async_get_or_create(
                config_entry_id=None,
                identifiers={("optim_runtime_fixture", spec["key"])},
                name=spec["name"],
                manufacturer="Optim Energy",
                model="Runtime Fixture",
            )
            changes: dict[str, Any] = {}
            if spec.get("area_id"):
                changes["area_id"] = spec["area_id"]
            if spec.get("labels"):
                wanted = set(spec["labels"])
                changes["labels"] = wanted - lr.async_get_missing_label_ids(hass, wanted)
            if changes:
                device = registry.async_update_device(device.id, **changes)
            created.append(
                {
                    "id": device.id,
                    "name": device.name,
                    "area_id": device.area_id,
                    "labels": sorted(device.labels),
                }
            )
        connection.send_result(msg["id"], created)

    return True
