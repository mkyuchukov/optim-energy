"""Runtime-only registry fixture used by the acceptance suite."""

from __future__ import annotations

from typing import Any

import probatio
from homeassistant.components import websocket_api
from homeassistant.components.websocket_api import ActiveConnection
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, label_registry as lr


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    """Register device and late-command fixtures."""

    @websocket_api.require_admin
    @websocket_api.websocket_command(
        {probatio.Required("type"): "optim_runtime_fixture/install_late_command"}
    )
    @callback
    def websocket_install_late_command(
        hass: HomeAssistant,
        connection: ActiveConnection,
        msg: dict[str, Any],
    ) -> None:
        @websocket_api.require_admin
        @websocket_api.websocket_command(
            {probatio.Required("type"): "optim_runtime_fixture/late_probe"}
        )
        @callback
        def websocket_late_probe(
            hass: HomeAssistant,
            connection: ActiveConnection,
            msg: dict[str, Any],
        ) -> None:
            connection.send_result(msg["id"], {"late": True})

        websocket_api.async_register_command(hass, websocket_late_probe)
        connection.send_result(msg["id"], {"installed": True})

    @websocket_api.require_admin
    @websocket_api.websocket_command(
        {
            probatio.Required("type"): "optim_runtime_fixture/create_devices",
            probatio.Required("config_entry_id"): str,
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
        spec_entry_id = msg["config_entry_id"]
        created = []
        for spec in msg["devices"]:
            device = registry.async_get_or_create(
                config_entry_id=spec_entry_id,
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

    websocket_api.async_register_command(hass, websocket_create_devices)
    websocket_api.async_register_command(hass, websocket_install_late_command)
    return True
