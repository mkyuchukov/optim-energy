"""Optim Energy portal integration."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.lovelace import LOVELACE_DATA
from homeassistant.components.lovelace.dashboard import (
    DashboardsCollection,
    LovelaceStorage,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import (
    CONF_SITE_NAME,
    DOMAIN,
    FRONTEND_DIRECTORY,
    STATIC_URL_PATH,
    VERSION,
)
from .dashboards import DASHBOARD_SPECS, build_dashboard_configs

_LOGGER = logging.getLogger(__name__)
_FRONTEND_KEY = f"{DOMAIN}_frontend"
_FRONTEND_READY_KEY = f"{DOMAIN}_frontend_ready"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Optim Energy and its bundled dashboard views."""
    await _async_register_frontend(hass)
    await _async_ensure_dashboards(hass, entry.data[CONF_SITE_NAME])
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove runtime frontend hooks while keeping client dashboards."""
    urls: set[str] = hass.data.pop(_FRONTEND_KEY, set())
    for url in urls:
        frontend.remove_extra_js_url(hass, url)
    return True


async def _async_register_frontend(hass: HomeAssistant) -> None:
    """Serve and load the bundled portal assets."""
    if _FRONTEND_READY_KEY not in hass.data:
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(
                    STATIC_URL_PATH,
                    str(FRONTEND_DIRECTORY),
                    cache_headers=True,
                )
            ]
        )
        hass.data[_FRONTEND_READY_KEY] = True

    urls = {
        f"{STATIC_URL_PATH}/energy-report-card.js?v={VERSION}",
        f"{STATIC_URL_PATH}/building-cards.js?v={VERSION}",
    }
    for url in urls:
        frontend.add_extra_js_url(hass, url)

    hass.data[_FRONTEND_KEY] = urls


async def _async_ensure_dashboards(hass: HomeAssistant, site_name: str) -> None:
    """Create missing Optim Energy dashboards without overwriting existing ones."""
    collection = DashboardsCollection(hass)
    await collection.async_load()
    existing = {
        item["url_path"]: item for item in collection.async_items()
    }
    configs = build_dashboard_configs(site_name)

    for spec in DASHBOARD_SPECS:
        url_path = spec["url_path"]
        item = existing.get(url_path)
        created = item is None

        if created:
            item = await collection.async_create_item(
                {
                    "url_path": url_path,
                    "title": spec["title"],
                    "icon": spec["icon"],
                    "show_in_sidebar": True,
                    "require_admin": spec["require_admin"],
                }
            )

        dashboard = _dashboard_storage(hass, item)
        if created:
            await dashboard.async_save(configs[url_path])

        if not frontend.async_panel_exists(hass, url_path):
            frontend.async_register_built_in_panel(
                hass,
                "lovelace",
                frontend_url_path=url_path,
                require_admin=spec["require_admin"],
                show_in_sidebar=True,
                sidebar_title=spec["title"],
                sidebar_icon=spec["icon"],
                config={"mode": "storage"},
                update=False,
            )


def _dashboard_storage(hass: HomeAssistant, item: dict[str, Any]) -> LovelaceStorage:
    """Return a dashboard storage object and register it in Lovelace."""
    url_path = item["url_path"]
    lovelace_data = hass.data[LOVELACE_DATA]
    dashboard = lovelace_data.dashboards.get(url_path)
    if dashboard is None:
        dashboard = LovelaceStorage(hass, item)
        lovelace_data.dashboards[url_path] = dashboard
    return dashboard
