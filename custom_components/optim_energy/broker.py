"""Shelly devices from an MQTT broker, as Home Assistant devices.

Shelly Gen2/Gen3/Gen4 devices that report to a shared broker publish their
status under ``<account>/<device>/status/<component>`` and an ``online`` flag
under ``<account>/<device>/online``. This reads those messages through Home
Assistant's own MQTT connection and makes a device with a sensor for every
number it reports, the first time it is heard. Every message is written as it
arrives: nothing is averaged, skipped or held back. Nothing is ever published:
the broker and its devices only ever see a subscriber.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_interval

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

BROKER_KEY = f"{DOMAIN}_broker"
STATUS_TOPIC = "+/+/status/+"
ONLINE_TOPIC = "+/+/online"
# Parts of a Shelly that describe the device itself, not what it measures.
_NOT_MEASURED = {"sys", "wifi", "cloud", "mqtt", "ble", "ws", "eth", "ui", "knx", "modbus", "bthome", "script", "schedule", "plugs_ui", "matter", "zigbee", "input"}
_COMPONENT_RE = re.compile(r"^([a-z0-9_]+):(\d+)$")
_SKIP_KEYS = {"id", "minute_ts", "tF", "by_minute", "errors", "flags"}
_PHASES = {"a": "phase A", "b": "phase B", "c": "phase C", "n": "neutral"}
# What a field is: its name, device class, unit, how to scale it, and whether it only counts up.
_FIELDS: dict[str, tuple[str, str | None, str | None, float, bool]] = {
    "act_power": ("Power", "power", "W", 1.0, False),
    "apower": ("Power", "power", "W", 1.0, False),
    "aprt_power": ("Apparent power", "apparent_power", "VA", 1.0, False),
    "voltage": ("Voltage", "voltage", "V", 1.0, False),
    "current": ("Current", "current", "A", 1.0, False),
    "freq": ("Frequency", "frequency", "Hz", 1.0, False),
    "pf": ("Power factor", "power_factor", None, 1.0, False),
    "total_act": ("Energy", "energy", "kWh", 0.001, True),
    "total_act_ret": ("Energy returned", "energy", "kWh", 0.001, True),
    "total_act_energy": ("Energy", "energy", "kWh", 0.001, True),
    "total_act_ret_energy": ("Energy returned", "energy", "kWh", 0.001, True),
    "aenergy.total": ("Energy", "energy", "kWh", 0.001, True),
    "ret_aenergy.total": ("Energy returned", "energy", "kWh", 0.001, True),
    "temperature.tC": ("Temperature", "temperature", "°C", 1.0, False),
    "tC": ("Temperature", "temperature", "°C", 1.0, False),
}


@dataclass(frozen=True)
class Reading:
    """One sensor of a device: what it is called and how it is measured."""

    key: str
    name: str
    device_class: str | None
    unit: str | None
    state_class: str
    value: float


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _flat(payload: dict[str, Any]) -> list[tuple[str, Any]]:
    """Fields one level deep, so ``{"aenergy": {"total": 5}}`` gives ``aenergy.total``."""
    out: list[tuple[str, Any]] = []
    for key, value in payload.items():
        if key in _SKIP_KEYS:
            continue
        if isinstance(value, dict):
            out.extend((f"{key}.{inner}", v) for inner, v in value.items() if inner not in _SKIP_KEYS)
        else:
            out.append((key, value))
    return out


def describe(field: str) -> tuple[str, str | None, str | None, float, bool]:
    """Name a field. Known ones get their unit; anything else is kept under a readable name."""
    if field in _FIELDS:
        return _FIELDS[field]
    phase, rest = None, field
    if len(field) > 2 and field[1] == "_" and field[0] in _PHASES:
        phase, rest = _PHASES[field[0]], field[2:]
    elif field.startswith("total_") and field[6:] in _FIELDS:
        rest = field[6:]
    if rest == "total_act_energy" and phase:
        name, cls, unit, scale, total = _FIELDS["total_act_energy"]
    elif rest == "total_act_ret_energy" and phase:
        name, cls, unit, scale, total = _FIELDS["total_act_ret_energy"]
    elif rest in _FIELDS:
        name, cls, unit, scale, total = _FIELDS[rest]
    else:
        name, cls, unit, scale, total = rest.replace(".", " ").replace("_", " ").capitalize(), None, None, 1.0, False
    return (f"{name} {phase}" if phase else name, cls, unit, scale, total)


def readings(component: str, payload: Any) -> list[Reading]:
    """Turn one Shelly status message into readings: one for every number in it.

    Pure, so it is easy to test. The device's main power and energy keep the
    plain names "Power" and "Energy"; a second channel is named apart
    ("Power channel 2").
    """
    match = _COMPONENT_RE.match(component)
    if not match or match.group(1) in _NOT_MEASURED or not isinstance(payload, dict):
        return []
    kind, index = match.group(1), int(match.group(2))
    channel = f" channel {index + 1}" if index else ""
    out: list[Reading] = []
    for field, raw in _flat(payload):
        value = _number(raw)
        if value is None:
            continue
        name, cls, unit, scale, total = describe(field)
        out.append(
            Reading(
                key=f"{kind}{index}_{field}".replace(".", "_"),
                name=f"{name}{channel}",
                device_class=cls,
                unit=unit,
                state_class="total_increasing" if total else "measurement",
                value=round(value * scale, 6),
            )
        )
    return out


def split_topic(topic: str) -> tuple[str, str, str] | None:
    """``account/device/status/em:0`` → (account, device, "em:0"); ``account/device/online`` → (…, "online")."""
    parts = topic.split("/")
    if len(parts) == 4 and parts[2] == "status":
        return parts[0], parts[1], parts[3]
    if len(parts) == 3 and parts[2] == "online":
        return parts[0], parts[1], "online"
    return None


def device_name(account: str, device: str) -> str:
    """The broker does not carry a device's own name, so it is named by its account and id."""
    return f"{account.split('@')[0]} · {device}"


class BrokerImport:
    """Hold the devices heard on the broker and write every reading as it arrives."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.enabled = False
        self.adders: dict[str, Any] = {}
        self.entities: dict[str, Any] = {}
        self.waiting: dict[str, list[Any]] = {"sensor": [], "binary_sensor": []}
        self.online: dict[str, bool] = {}
        self.devices: set[str] = set()
        self.rate = None  # messages in the last full minute, for the load sensor
        self._count = 0
        self._unsubs: list[Any] = []

    async def async_configure(self, enabled: bool) -> None:
        """Start or stop listening. Devices already made are kept."""
        self.stop()
        self.enabled = enabled
        if not enabled:
            return
        self._unsubs.append(async_track_time_interval(self.hass, self._minute, timedelta(minutes=1)))
        self._load_sensor()
        try:
            from homeassistant.components import mqtt
        except ImportError:  # pragma: no cover - MQTT is part of Home Assistant
            return
        if not await mqtt.async_wait_for_mqtt_client(self.hass):
            _LOGGER.warning("Optim Energy broker import is on, but MQTT is not set up in Home Assistant")
            return
        for topic in (STATUS_TOPIC, ONLINE_TOPIC):
            self._unsubs.append(await mqtt.async_subscribe(self.hass, topic, self._message, qos=0))
        _LOGGER.info("Optim Energy broker import listening")

    def stop(self) -> None:
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()

    @callback
    def _message(self, msg: Any) -> None:
        self.handle(msg.topic, msg.payload)

    @callback
    def handle(self, topic: str, payload: Any) -> None:
        """Take one broker message and write what it says at once. Also called by the tests."""
        if not self.enabled:
            return
        where = split_topic(topic)
        if where is None:
            return
        self._count += 1
        account, device, part = where
        base = f"{account}/{device}"
        self.devices.add(base)
        if part == "online":
            text = payload.decode() if isinstance(payload, bytes) else str(payload)
            self.online[base] = text.strip().lower() == "true"
            self._entity("binary_sensor", f"{base}:online", account, device, None).show(self.online[base])
            # Its readings follow: unavailable while it is offline.
            for key, entity in self.entities.items():
                if key.startswith(f"{base}:") and entity.hass is not None and key != f"{base}:online":
                    entity.async_write_ha_state()
            return
        try:
            data = json.loads(payload) if isinstance(payload, (str, bytes)) else payload
        except ValueError:
            return
        for reading in readings(part, data):
            self._entity("sensor", f"{base}:{reading.key}", account, device, reading).show(reading.value)

    def _entity(self, platform: str, key: str, account: str, device: str, reading: Reading | None) -> Any:
        entity = self.entities.get(key)
        if entity is not None:
            return entity
        from .broker_entities import BrokerOnline, BrokerSensor

        entity = BrokerOnline(self, key, account, device) if platform == "binary_sensor" else BrokerSensor(self, key, account, device, reading)
        self.entities[key] = entity
        adder = self.adders.get(platform)
        if adder is not None:
            adder([entity])
        else:
            self.waiting[platform].append(entity)
        return entity

    def _load_sensor(self) -> None:
        if "load" in self.entities:
            return
        from .broker_entities import BrokerLoad

        entity = BrokerLoad(self)
        self.entities["load"] = entity
        if self.adders.get("sensor"):
            self.adders["sensor"]([entity])
        else:
            self.waiting["sensor"].append(entity)

    @callback
    def _minute(self, _now: Any = None) -> None:
        self.rate, self._count = self._count, 0
        load = self.entities.get("load")
        if load is not None and load.hass is not None:
            load.async_write_ha_state()

    def register(self, platform: str, adder: Any) -> None:
        """A platform is ready: it takes every entity made before it was."""
        self.adders[platform] = adder
        if self.waiting[platform]:
            adder(self.waiting[platform])
            self.waiting[platform] = []

