"""Remember the last market prices.

The exchange price comes from another integration. After a restart, or
while that source cannot be reached, its sensors are unavailable and the
portal would have no price and no price chart at all. What was last seen is
kept here, on disk, and handed to the portal marked as not live.
"""

from __future__ import annotations

import time
from typing import Any

from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import Event, HomeAssistant, State, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.storage import Store

from .const import DOMAIN

_STORE_VERSION = 1
_NO_READING = ("unavailable", "unknown", "")


def _numeric(value: Any) -> bool:
    try:
        float(value)
    except (TypeError, ValueError):
        return False
    return True


def _rows(value: Any) -> list[dict[str, Any]]:
    """The quarter-hour prices of one day, as plain data."""
    if not isinstance(value, list):
        return []
    return [
        {"time": str(row.get("time")), "price": row.get("price")}
        for row in value
        if isinstance(row, dict) and _numeric(row.get("price"))
    ]


class PriceMemory:
    """Keep the last readings of the market price sensors."""

    def __init__(self, hass: HomeAssistant, platforms: frozenset[str]) -> None:
        self.hass = hass
        self.platforms = platforms
        self.store: Store[dict[str, Any]] = Store(hass, _STORE_VERSION, f"{DOMAIN}.prices", private=True)
        self.data: dict[str, Any] = {"at": None, "values": {}, "today": [], "tomorrow": []}
        self._unsub: Any = None

    async def async_start(self) -> None:
        loaded = await self.store.async_load()
        if isinstance(loaded, dict) and isinstance(loaded.get("values"), dict):
            self.data = {**self.data, **loaded}
        for state in self.hass.states.async_all("sensor"):
            self._take(state)
        self._unsub = self.hass.bus.async_listen(EVENT_STATE_CHANGED, self._changed)

    def stop(self) -> None:
        if self._unsub is not None:
            self._unsub()
            self._unsub = None

    @callback
    def _changed(self, event: Event) -> None:
        self._take(event.data.get("new_state"))

    def _take(self, state: State | None) -> None:
        if state is None or not state.entity_id.startswith("sensor.") or state.state in _NO_READING:
            return
        entry = er.async_get(self.hass).async_get(state.entity_id)
        if entry is None or entry.platform not in self.platforms:
            return
        self.data["values"][state.entity_id] = {
            "state": state.state,
            "unit": state.attributes.get("unit_of_measurement"),
        }
        today = _rows(state.attributes.get("prices_today"))
        if today:
            self.data["today"] = today
            self.data["tomorrow"] = _rows(state.attributes.get("prices_tomorrow"))
        self.data["at"] = time.time()
        self.store.async_delay_save(lambda: self.data, 30)

    def snapshot(self) -> dict[str, Any]:
        """What was last seen, and whether the source is giving readings right now."""
        live = any(
            (state := self.hass.states.get(entity_id)) is not None and _numeric(state.state)
            for entity_id in self.data["values"]
        )
        return {**self.data, "live": live}
