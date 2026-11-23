"""Shelly devices from an MQTT broker, as Home Assistant devices.

Shelly Gen2/Gen3 devices that report to a shared broker publish their status
under ``<account>/<device>/status/<component>`` and an ``online`` flag under
``<account>/<device>/online``. This reads those messages through Home
Assistant's own MQTT connection and makes a device with sensors for each
Shelly it hears from, the first time it hears from it. Nothing is ever
published: the broker and its devices only ever see a subscriber.

The live readings change every few seconds. They are written to Home
Assistant at most once per interval, so hundreds of devices do not flood the
database.
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
_COMPONENT_RE = re.compile(r"^(em|emdata|em1|em1data|switch|pm1):(\d+)$")


@dataclass(frozen=True)
class Reading:
    """One sensor of a device: what it is called and how it is measured."""

    key: str
    name: str
    device_class: str
    unit: str
    state_class: str
    enabled: bool
    value: float


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def readings(component: str, payload: Any) -> list[Reading]:
    """Turn one Shelly status message into readings. Pure, so it is easy to test.

    A device's main power and energy keep the plain names "Power" and
    "Energy"; everything per phase or per extra channel is named after them
    ("Power phase A", "Energy channel 2") and starts disabled, so it costs
    nothing until someone turns it on.
    """
    match = _COMPONENT_RE.match(component)
    if not match or not isinstance(payload, dict):
        return []
    kind, index = match.group(1), int(match.group(2))
    channel = f" channel {index + 1}" if index else ""
    suffix = f"_{index + 1}" if index else ""
    out: list[Reading] = []

    def add(key: str, name: str, device_class: str, unit: str, raw: Any, *, main: bool, scale: float = 1.0, total: bool = False) -> None:
        value = _number(raw)
        if value is None:
            return
        out.append(
            Reading(
                key=f"{key}{suffix}",
                name=f"{name}{channel}",
                device_class=device_class,
                unit=unit,
                state_class="total_increasing" if total else "measurement",
                enabled=main and not index,
                value=round(value * scale, 4),
            )
        )

    if kind == "em":
        add("power", "Power", "power", "W", payload.get("total_act_power"), main=True)
        add("current", "Current", "current", "A", payload.get("total_current"), main=False)
        for phase in "abc":
            name = phase.upper()
            add(f"power_phase_{phase}", f"Power phase {name}", "power", "W", payload.get(f"{phase}_act_power"), main=False)
            add(f"voltage_phase_{phase}", f"Voltage phase {name}", "voltage", "V", payload.get(f"{phase}_voltage"), main=False)
            add(f"current_phase_{phase}", f"Current phase {name}", "current", "A", payload.get(f"{phase}_current"), main=False)
    elif kind == "emdata":
        add("energy", "Energy", "energy", "kWh", payload.get("total_act"), main=True, scale=0.001, total=True)
        add("energy_returned", "Energy returned", "energy", "kWh", payload.get("total_act_ret"), main=True, scale=0.001, total=True)
        for phase in "abc":
            add(f"energy_phase_{phase}", f"Energy phase {phase.upper()}", "energy", "kWh", payload.get(f"{phase}_total_act_energy"), main=False, scale=0.001, total=True)
    elif kind == "em1":
        add("power", "Power", "power", "W", payload.get("act_power"), main=True)
        add("voltage", "Voltage", "voltage", "V", payload.get("voltage"), main=False)
        add("current", "Current", "current", "A", payload.get("current"), main=False)
        add("frequency", "Frequency", "frequency", "Hz", payload.get("freq"), main=False)
    elif kind == "em1data":
        add("energy", "Energy", "energy", "kWh", payload.get("total_act_energy"), main=True, scale=0.001, total=True)
        add("energy_returned", "Energy returned", "energy", "kWh", payload.get("total_act_ret_energy"), main=True, scale=0.001, total=True)
    else:  # switch and pm1: a relay or a power meter with its own counter
        add("power", "Power", "power", "W", payload.get("apower"), main=True)
        add("voltage", "Voltage", "voltage", "V", payload.get("voltage"), main=False)
        add("current", "Current", "current", "A", payload.get("current"), main=False)
        add("energy", "Energy", "energy", "kWh", (payload.get("aenergy") or {}).get("total") if isinstance(payload.get("aenergy"), dict) else None, main=True, scale=0.001, total=True)
        returned = payload.get("ret_aenergy")
        add("energy_returned", "Energy returned", "energy", "kWh", returned.get("total") if isinstance(returned, dict) else None, main=True, scale=0.001, total=True)
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
    """Hold the devices heard on the broker and keep their sensors up to date."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.enabled = False
        self.accounts: set[str] = set()
        self.interval = 60
        self.adders: dict[str, Any] = {}
        self.entities: dict[str, Any] = {}
        self.waiting: dict[str, list[Any]] = {"sensor": [], "binary_sensor": []}
        self.online: dict[str, bool] = {}
        self._dirty: set[str] = set()
        self._unsubs: list[Any] = []

    async def async_configure(self, enabled: bool, accounts: set[str], interval: int) -> None:
        """Start, stop or change the import. Devices already made are kept."""
        self.stop()
        self.enabled, self.accounts, self.interval = enabled, accounts, max(5, int(interval))
        if not enabled:
            return
        self._unsubs.append(async_track_time_interval(self.hass, self._flush, timedelta(seconds=self.interval)))
        try:
            from homeassistant.components import mqtt
        except ImportError:  # pragma: no cover - MQTT is part of Home Assistant
            return
        if not await mqtt.async_wait_for_mqtt_client(self.hass):
            _LOGGER.warning("Optim Energy broker import is on, but MQTT is not set up in Home Assistant")
            return
        for topic in (STATUS_TOPIC, ONLINE_TOPIC):
            self._unsubs.append(await mqtt.async_subscribe(self.hass, topic, self._message, qos=0))
        _LOGGER.info("Optim Energy broker import listening (%s)", ", ".join(sorted(accounts)) or "all accounts")

    def stop(self) -> None:
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()

    @callback
    def _message(self, msg: Any) -> None:
        self.handle(msg.topic, msg.payload)

    @callback
    def handle(self, topic: str, payload: Any) -> None:
        """Take one broker message. Also called directly by the tests."""
        if not self.enabled:
            return
        where = split_topic(topic)
        if where is None:
            return
        account, device, part = where
        if self.accounts and account not in self.accounts:
            return
        base = f"{account}/{device}"
        if part == "online":
            text = payload.decode() if isinstance(payload, bytes) else str(payload)
            self.online[base] = text.strip().lower() == "true"
            entity = self._entity("binary_sensor", f"{base}:online", account, device, None)
            entity.update_now(self.online[base])
            for key in [k for k in self.entities if k.startswith(f"{base}:")]:
                self._dirty.add(key)
            return
        try:
            data = json.loads(payload) if isinstance(payload, (str, bytes)) else payload
        except ValueError:
            return
        for reading in readings(part, data):
            entity = self._entity("sensor", f"{base}:{reading.key}", account, device, reading)
            entity.value = reading.value
            self._dirty.add(f"{base}:{reading.key}")

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

    def register(self, platform: str, adder: Any) -> None:
        """A platform is ready: it takes every entity made before it was."""
        self.adders[platform] = adder
        if self.waiting[platform]:
            adder(self.waiting[platform])
            self.waiting[platform] = []

    @callback
    def _flush(self, _now: Any = None) -> None:
        dirty, self._dirty = self._dirty, set()
        for key in dirty:
            entity = self.entities.get(key)
            if entity is not None and entity.hass is not None:
                entity.async_write_ha_state()
