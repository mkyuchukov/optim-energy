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
from homeassistant.exceptions import HomeAssistantError

from .const import (
    CONF_SITE_NAME,
    DOMAIN,
    FRONTEND_DIRECTORY,
    STATIC_URL_PATH,
    VERSION,
)
from .dashboards import DASHBOARD_SPECS, build_dashboard_configs
from .firewall import RestFirewall, WebsocketFirewall
from .tenancy import TenancyManager, async_register_commands, async_setup_tenancy

_LOGGER = logging.getLogger(__name__)
_FRONTEND_KEY = f"{DOMAIN}_frontend"
_FRONTEND_READY_KEY = f"{DOMAIN}_frontend_ready"
_TENANCY_KEY = f"{DOMAIN}_tenancy"
_FIREWALL_KEY = f"{DOMAIN}_firewall"
_REST_FIREWALL_KEY = f"{DOMAIN}_rest_firewall"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Optim Energy tenancy, its API, and its bundled portal."""
    await _async_register_frontend(hass)
    initial_tree = await _async_existing_device_tree(hass)
    manager = await async_setup_tenancy(hass, entry.data[CONF_SITE_NAME], initial_tree)
    async_register_commands(hass, manager)

    audit = bool(entry.options.get("audit", False))
    websocket_firewall = WebsocketFirewall(hass, manager, audit=audit)
    websocket_firewall.install()
    hass.data[_FIREWALL_KEY] = websocket_firewall

    rest_firewall = RestFirewall(hass, manager, audit=audit)
    await rest_firewall.install()
    hass.data[_REST_FIREWALL_KEY] = rest_firewall

    await _async_replace_dashboards(hass, entry.data[CONF_SITE_NAME])
    await _async_set_portal_default(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove runtime hooks while keeping client data and dashboards."""
    rest_firewall: RestFirewall | None = hass.data.pop(_REST_FIREWALL_KEY, None)
    if rest_firewall is not None:
        rest_firewall.uninstall()
    websocket_firewall: WebsocketFirewall | None = hass.data.pop(_FIREWALL_KEY, None)
    if websocket_firewall is not None:
        websocket_firewall.uninstall()
    manager: TenancyManager | None = hass.data.pop(_TENANCY_KEY, None)
    if manager is not None:
        await manager.async_unload()
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


async def _async_existing_device_tree(hass: HomeAssistant) -> dict[str, Any] | None:
    """Read the old tree before replacing the dashboard storage document."""
    collection = DashboardsCollection(hass)
    await collection.async_load()
    existing = {item["url_path"]: item for item in collection.async_items()}
    old_home = existing.get("energy-home")
    if old_home is None:
        return None
    old_dashboard = _dashboard_storage(hass, old_home)
    try:
        old_config = await old_dashboard.async_load(False)
    except HomeAssistantError:
        return None
    tree = old_config.get("device_tree") if isinstance(old_config, dict) else None
    return tree if isinstance(tree, dict) and tree else None


async def _async_replace_dashboards(hass: HomeAssistant, site_name: str) -> None:
    """Replace the known portal dashboards with the bundled versions."""
    collection = DashboardsCollection(hass)
    await collection.async_load()
    existing = {
        item["url_path"]: item for item in collection.async_items()
    }
    configs = build_dashboard_configs(site_name)

    await _async_remove_legacy_resources(hass)

    for spec in DASHBOARD_SPECS:
        url_path = spec["url_path"]
        item = existing.get(url_path)
        metadata = {
            "title": spec["title"],
            "icon": spec["icon"],
            "show_in_sidebar": True,
            "require_admin": spec["require_admin"],
        }

        if item is None:
            item = await collection.async_create_item(
                {"url_path": url_path, **metadata}
            )
        else:
            item = await collection.async_update_item(item["id"], metadata)

        dashboard = _dashboard_storage(hass, item)
        await dashboard.async_save(configs[url_path])

        frontend.async_register_built_in_panel(
            hass,
            "lovelace",
            frontend_url_path=url_path,
            require_admin=spec["require_admin"],
            show_in_sidebar=True,
            sidebar_title=spec["title"],
            sidebar_icon=spec["icon"],
            config={"mode": "storage"},
            update=frontend.async_panel_exists(hass, url_path),
        )


async def _async_set_portal_default(hass: HomeAssistant) -> None:
    """Open the portal first while leaving an explicit user choice alone."""
    system_store = await frontend.async_system_store(hass)
    core_data = system_store.data.get("core") or {}
    if core_data.get("default_panel") in (None, "lovelace"):
        await system_store.async_set_item(
            "core",
            {**core_data, "default_panel": "energy-locations"},
        )


async def _async_remove_legacy_resources(hass: HomeAssistant) -> None:
    """Remove old manually installed copies of our frontend modules."""
    lovelace_data = hass.data[LOVELACE_DATA]
    resources = lovelace_data.resources
    if not hasattr(resources, "async_delete_item"):
        _LOGGER.warning(
            "Optim Energy could not clean legacy YAML dashboard resources; "
            "remove the old /local/building-cards.js and "
            "/local/energy-report-card.js entries manually"
        )
        return

    await resources.async_load()
    legacy_names = ("/building-cards.js", "/energy-report-card.js")
    for item in list(resources.async_items()):
        url = str(item.get("url", "")).split("?", 1)[0]
        if url.endswith(legacy_names):
            await resources.async_delete_item(item["id"])


def _dashboard_storage(hass: HomeAssistant, item: dict[str, Any]) -> LovelaceStorage:
    """Return a dashboard storage object and register it in Lovelace."""
    url_path = item["url_path"]
    lovelace_data = hass.data[LOVELACE_DATA]
    dashboard = lovelace_data.dashboards.get(url_path)
    if dashboard is None:
        dashboard = LovelaceStorage(hass, item)
        lovelace_data.dashboards[url_path] = dashboard
    return dashboard
