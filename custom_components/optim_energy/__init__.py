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
from .portal_ops import async_register_portal_commands
from .prices import PriceMemory
from .tenancy import MARKET_PRICE_PLATFORMS, TenancyManager, async_register_commands

_LOGGER = logging.getLogger(__name__)
_FRONTEND_KEY = f"{DOMAIN}_frontend"
_FRONTEND_READY_KEY = f"{DOMAIN}_frontend_ready"
_TENANCY_KEY = f"{DOMAIN}_tenancy"
_FIREWALL_KEY = f"{DOMAIN}_firewall"
_REST_FIREWALL_KEY = f"{DOMAIN}_rest_firewall"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Optim Energy tenancy, its API, and its bundled portal."""
    await _async_register_frontend(hass)
    # Stage one: guard first, around a manager that knows no tenant yet. With
    # no assignments every non-admin account is refused, so if anything below
    # raises, the instance stays closed to tenants instead of open.
    manager = TenancyManager(hass)
    websocket_firewall: WebsocketFirewall | None = hass.data.get(_FIREWALL_KEY)
    if websocket_firewall is None:
        websocket_firewall = WebsocketFirewall(hass, manager)
        websocket_firewall.install()
        hass.data[_FIREWALL_KEY] = websocket_firewall
    rest_firewall: RestFirewall | None = hass.data.get(_REST_FIREWALL_KEY)
    if rest_firewall is None:
        rest_firewall = RestFirewall(hass, manager)
        await rest_firewall.install()
        hass.data[_REST_FIREWALL_KEY] = rest_firewall
    websocket_firewall.manager = rest_firewall.manager = manager
    websocket_firewall.audit = rest_firewall.audit = False

    # Stage two: the same guards start answering from real tenant data.
    await manager.async_initialize(entry.data[CONF_SITE_NAME])
    manager.prices = PriceMemory(hass, MARKET_PRICE_PLATFORMS)
    await manager.prices.async_start()
    async_register_commands(hass, manager)
    async_register_portal_commands(hass, manager)
    audit = bool(entry.options.get("audit", False))
    websocket_firewall.audit = rest_firewall.audit = audit

    await _async_replace_dashboards(hass, entry.data[CONF_SITE_NAME])
    await _async_set_portal_default(hass)
    await manager.async_sync_all_sidebars()
    entry.async_on_unload(entry.add_update_listener(_async_apply_options))
    return True


async def _async_apply_options(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Apply audit mode in place without stacking a second middleware chain."""
    audit = bool(entry.options.get("audit", False))
    websocket_firewall: WebsocketFirewall | None = hass.data.get(_FIREWALL_KEY)
    rest_firewall: RestFirewall | None = hass.data.get(_REST_FIREWALL_KEY)
    if websocket_firewall is not None:
        websocket_firewall.audit = audit
    if rest_firewall is not None:
        rest_firewall.audit = audit
    _LOGGER.warning("Optim Energy audit mode %s", "enabled" if audit else "disabled")


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
        if manager.prices is not None:
            manager.prices.stop()
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


async def _async_replace_dashboards(hass: HomeAssistant, site_name: str) -> None:
    """Replace the known portal dashboards with the bundled versions."""
    collection = DashboardsCollection(hass)
    await collection.async_load()
    lovelace_data = hass.data[LOVELACE_DATA]
    existing = {
        item["url_path"]: item for item in collection.async_items()
    }
    configs = await hass.async_add_executor_job(build_dashboard_configs, site_name)

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

        dashboard = lovelace_data.dashboards.get(url_path)
        if item is None and dashboard is not None:
            # A just-created dashboard can still be waiting for Home
            # Assistant's delayed collection save. The live panel exists even
            # though a newly loaded collection cannot see the item yet.
            if isinstance(dashboard.config, dict):
                dashboard.config.update(metadata)
            item = dashboard.config
        elif item is None and url_path in lovelace_data.yaml_dashboards:
            _LOGGER.warning(
                "Optim Energy cannot replace YAML dashboard %s; use storage mode",
                url_path,
            )
            continue
        elif item is None:
            item = await collection.async_create_item(
                {"url_path": url_path, **metadata}
            )
        else:
            item = await collection.async_update_item(item["id"], metadata)

        if not isinstance(item, dict):
            raise HomeAssistantError(f"Dashboard {url_path} has no storage metadata")
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
    """Open the tenant portal first while leaving an explicit user choice alone."""
    system_store = await frontend.async_system_store(hass)
    core_data = system_store.data.get("core") or {}
    # Home Assistant always keeps the default panel in the sidebar, even when
    # an account hides it. Start is therefore a neutral landing panel that
    # redirects to the right surface for each role.
    if core_data.get("default_panel") in (
        None,
        "lovelace",
        "home",
        "energy-admin",
        "energy-locations",
        "energy-home",
    ):
        await system_store.async_set_item(
            "core",
            {**core_data, "default_panel": "energy-start"},
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
