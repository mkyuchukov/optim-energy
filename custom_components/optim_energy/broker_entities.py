"""The sensors of devices heard on an MQTT broker (see broker.py)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.const import EntityCategory
from homeassistant.helpers.device_registry import DeviceInfo

from .broker import Reading, device_name
from .const import DOMAIN


def _device(account: str, device: str) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, f"broker:{account}/{device}")},
        name=device_name(account, device),
        manufacturer="Shelly",
        model="Shelly (MQTT)",
        serial_number=device,
    )


class BrokerSensor(SensorEntity):
    """One reading of a device, written every time the device reports it."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, importer: Any, key: str, account: str, device: str, reading: Reading) -> None:
        self._importer = importer
        self._base = f"{account}/{device}"
        self._attr_unique_id = f"broker:{key}"
        self._attr_name = reading.name
        self._attr_device_class = SensorDeviceClass(reading.device_class) if reading.device_class else None
        self._attr_native_unit_of_measurement = reading.unit
        self._attr_state_class = SensorStateClass(reading.state_class)
        self._attr_device_info = _device(account, device)
        self._attr_native_value = reading.value

    @property
    def available(self) -> bool:
        return self._importer.online.get(self._base, True)

    def show(self, value: float) -> None:
        self._attr_native_value = value
        if self.hass is not None:
            self.async_write_ha_state()


class BrokerOnline(BinarySensorEntity):
    """Whether the device is connected to the broker."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_name = "Online"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, importer: Any, key: str, account: str, device: str) -> None:
        self._attr_unique_id = f"broker:{key}"
        self._attr_device_info = _device(account, device)
        self._attr_is_on: bool | None = None

    def show(self, online: bool) -> None:
        self._attr_is_on = online
        if self.hass is not None:
            self.async_write_ha_state()


class BrokerLoad(SensorEntity):
    """How many broker messages arrived in the last minute, and from how many devices."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_name = "Messages per minute"
    _attr_unique_id = "broker:load"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "messages/min"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_device_info = DeviceInfo(identifiers={(DOMAIN, "broker")}, name="MQTT broker import", manufacturer="Optim Energy")

    def __init__(self, importer: Any) -> None:
        self._importer = importer

    @property
    def native_value(self) -> int | None:
        return self._importer.rate

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"devices": len(self._importer.devices), "sensors": sum(1 for k in self._importer.entities if k != "load")}
