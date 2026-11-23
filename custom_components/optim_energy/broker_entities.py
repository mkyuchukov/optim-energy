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
    """One reading of a device. Its value is written by the import, at most once per interval."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, importer: Any, key: str, account: str, device: str, reading: Reading) -> None:
        self._importer = importer
        self._base = f"{account}/{device}"
        self._attr_unique_id = f"broker:{key}"
        self._attr_name = reading.name
        self._attr_device_class = SensorDeviceClass(reading.device_class)
        self._attr_native_unit_of_measurement = reading.unit
        self._attr_state_class = SensorStateClass(reading.state_class)
        self._attr_entity_registry_enabled_default = reading.enabled
        self._attr_device_info = _device(account, device)
        self.value: float | None = reading.value

    @property
    def native_value(self) -> float | None:
        return self.value

    @property
    def available(self) -> bool:
        return self._importer.online.get(self._base, True) and self.value is not None


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

    def update_now(self, online: bool) -> None:
        self._attr_is_on = online
        if self.hass is not None:
            self.async_write_ha_state()
