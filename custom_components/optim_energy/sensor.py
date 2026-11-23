"""The sensor entities of the broker import (see broker.py)."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .broker import BROKER_KEY


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    importer = hass.data.get(BROKER_KEY)
    if importer is not None:
        importer.register("sensor", async_add_entities)
