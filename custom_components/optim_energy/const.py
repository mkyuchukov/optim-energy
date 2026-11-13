"""Constants for the Optim Energy integration."""

from __future__ import annotations

import json
from pathlib import Path

DOMAIN = "optim_energy"
CONF_SITE_NAME = "site_name"
CONF_AUDIT = "audit"
STATIC_URL_PATH = "/optim_energy_static"
FRONTEND_DIRECTORY = Path(__file__).parent / "frontend"
DASHBOARD_DIRECTORY = Path(__file__).parent / "dashboards"


def _manifest_version() -> str:
    """Return the package version from the integration manifest."""
    manifest = json.loads((Path(__file__).parent / "manifest.json").read_text("utf-8"))
    return str(manifest["version"])


VERSION = _manifest_version()
