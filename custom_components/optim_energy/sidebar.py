"""Server-side sidebar preferences for Optim Energy tenant accounts."""

from __future__ import annotations

from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

CLIENT_PANELS = (
    "energy-start",
    "energy-locations",
    "energy-home",
    "energy-groups",
    "energy-controls",
    "energy-devices",
    "energy-reports",
    "energy-alerts",
    "energy-setup",
)
ADMIN_PANELS = (
    "energy-admin",
    "core_configurator",
    "45df7312_zigbee2mqtt",
    "hacs",
)
_MANAGED_PANELS = frozenset((*CLIENT_PANELS, *ADMIN_PANELS))


def build_sidebar_preferences(
    role: str | None,
    locations: Iterable[str],
    panels: Iterable[str],
    *,
    manage_tree: bool,
) -> dict[str, Any]:
    """Return the sidebar document for one tenant account."""
    assigned = list(dict.fromkeys(str(location) for location in locations if location))
    single_location_user = role == "user" and len(assigned) <= 1
    client_panels = [
        panel
        for panel in CLIENT_PANELS
        # "energy-start" only redirects; it is nobody's tab.
        if panel != "energy-start" and (panel != "energy-locations" or not single_location_user)
    ]
    if not manage_tree:
        client_panels = [panel for panel in client_panels if panel != "energy-setup"]
    allowed = set(client_panels)
    hidden = sorted((set(panels) | _MANAGED_PANELS) - allowed)
    return {"panelOrder": client_panels, "hiddenPanels": hidden}


async def async_sync_default_panel(
    hass: HomeAssistant,
    user_id: str,
    panel: str,
) -> None:
    """Set the account's landing dashboard without changing global defaults."""
    from homeassistant.components.frontend.storage import async_user_store

    store = await async_user_store(hass, user_id)
    core = store.data.get("core") or {}
    if core.get("default_panel") != panel:
        await store.async_set_item("core", {**core, "default_panel": panel})


async def async_sync_admin_sidebar(
    hass: HomeAssistant,
    user_id: str,
) -> None:
    """Keep only the administrator console and native HA tools in the sidebar."""
    from homeassistant.components.frontend.storage import async_user_store

    store = await async_user_store(hass, user_id)
    current = store.data.get("sidebar") or {}
    managed = set(_MANAGED_PANELS)
    hidden = {panel for panel in current.get("hiddenPanels", []) if panel not in managed}
    hidden.update(CLIENT_PANELS)
    value = {"panelOrder": list(ADMIN_PANELS), "hiddenPanels": sorted(hidden)}
    if current != value:
        await store.async_set_item("sidebar", value)


async def async_sync_user_sidebar(
    hass: HomeAssistant,
    user_id: str,
    role: str | None,
    locations: Iterable[str],
    *,
    manage_tree: bool,
) -> None:
    """Persist one tenant account's sidebar before the frontend loads."""
    from homeassistant.components.frontend import DATA_PANELS
    from homeassistant.components.frontend.storage import async_user_store

    store = await async_user_store(hass, user_id)
    value = build_sidebar_preferences(
        role,
        locations,
        hass.data.get(DATA_PANELS, {}),
        manage_tree=manage_tree,
    )
    if store.data.get("sidebar") != value:
        await store.async_set_item("sidebar", value)
