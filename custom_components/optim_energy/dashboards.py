"""Bundled Optim Energy dashboards."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

DASHBOARD_DIRECTORY = Path(__file__).parent / "dashboards"

DASHBOARD_SPECS: tuple[dict[str, Any], ...] = (
    {
        "url_path": "energy-start",
        "title": "Home",
        "icon": "mdi:home-outline",
        "filename": "energy-start.json",
        # Safe landing page for every account. The start card redirects Home
        # Assistant administrators to Administration, multi-location users to
        # the picker, and single-location users straight to their workspace.
        "require_admin": False,
    },
    {
        "url_path": "energy-admin",
        "title": "Administration",
        "icon": "mdi:shield-account-outline",
        "filename": "energy-admin.json",
        # Home Assistant enforces this flag before the panel renders, so
        # ordinary and client-admin accounts cannot see or open it.
        "require_admin": True,
    },
    {
        "url_path": "energy-locations",
        "title": "Locations",
        "icon": "mdi:map-marker-multiple",
        "filename": "energy-locations.json",
        "require_admin": False,
    },
    {
        "url_path": "energy-home",
        "title": "Overview",
        "icon": "mdi:view-dashboard-outline",
        "filename": "energy-home.json",
        "require_admin": False,
    },
    {
        "url_path": "energy-groups",
        "title": "Groups",
        "icon": "mdi:floor-plan",
        "filename": "energy-groups.json",
        "require_admin": False,
    },
    {
        "url_path": "energy-controls",
        "title": "Controls",
        "icon": "mdi:tune-variant",
        "filename": "energy-controls.json",
        "require_admin": False,
    },
    {
        "url_path": "energy-devices",
        "title": "Devices",
        "icon": "mdi:power-plug-outline",
        "filename": "energy-devices.json",
        "require_admin": False,
    },
    {
        "url_path": "energy-reports",
        "title": "Reports",
        "icon": "mdi:chart-box-outline",
        "filename": "energy-reports.json",
        "require_admin": False,
    },
    {
        "url_path": "energy-alerts",
        "title": "Alerts",
        "icon": "mdi:bell-outline",
        "filename": "energy-alerts.json",
        "require_admin": False,
    },
    {
        "url_path": "energy-setup",
        "title": "Setup",
        "icon": "mdi:cog-outline",
        "filename": "energy-setup.json",
        "require_admin": False,
    },
)


def default_device_tree(site_name: str) -> dict[str, Any]:
    """Return the empty site model used on a fresh installation."""
    return {
        "main": None,
        "mains": {},
        "parents": {},
        "virtual": [],
        "known": None,
        "places": [
            {
                "id": "loc:default",
                "name": site_name,
                "kind": "location",
                "parent": None,
            }
        ],
        "placed": {},
        "automations": [],
        "alarms": [],
        "kept": None,
        "kinds": {},
        "notify": {},
        "sums": {},
        "prices": {},
    }


def build_dashboard_configs(site_name: str) -> dict[str, dict[str, Any]]:
    """Load bundled dashboard templates and add the installation site."""
    configs: dict[str, dict[str, Any]] = {}
    for spec in DASHBOARD_SPECS:
        config = json.loads(
            (DASHBOARD_DIRECTORY / spec["filename"]).read_text("utf-8")
        )
        config = copy.deepcopy(config)
        # Tenant data lives in the integration store now. Dashboards are
        # replaceable presentation only and must never contain another
        # client's tree.
        configs[spec["url_path"]] = config
    return configs


def apply_existing_device_tree(
    configs: dict[str, dict[str, Any]], existing_home_config: dict[str, Any] | None
) -> None:
    """Keep client data while replacing every dashboard layout from the package."""
    if not existing_home_config:
        return
    tree = existing_home_config.get("device_tree")
    if isinstance(tree, dict) and tree:
        configs["energy-home"]["device_tree"] = copy.deepcopy(tree)
