"""Package-level tests that do not require a running Home Assistant."""

from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPONENT = ROOT / "custom_components" / "optim_energy"
MANIFEST = json.loads((COMPONENT / "manifest.json").read_text("utf-8"))
HACS = json.loads((ROOT / "hacs.json").read_text("utf-8"))

spec = importlib.util.spec_from_file_location(
    "optim_energy_dashboards", COMPONENT / "dashboards.py"
)
assert spec and spec.loader
dashboards = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dashboards)


class PackageTests(unittest.TestCase):
    """Validate the installable package."""

    def test_manifest_and_hacs_versions(self) -> None:
        self.assertEqual(MANIFEST["domain"], "optim_energy")
        self.assertEqual(MANIFEST["version"], "0.2.12")
        self.assertTrue(MANIFEST["config_flow"])
        self.assertEqual(HACS["homeassistant"], "2026.11.0")

    def test_dashboard_set_is_complete(self) -> None:
        configs = dashboards.build_dashboard_configs("Example Client")
        self.assertEqual(
            set(configs),
            {
                "energy-locations",
                "energy-home",
                "energy-groups",
                "energy-controls",
                "energy-devices",
                "energy-reports",
                "energy-alerts",
                "energy-setup",
            },
        )
        for config in configs.values():
            self.assertNotIn("theme", json.dumps(config))
            self.assertGreaterEqual(len(config["views"]), 1)

    def test_dashboards_never_contain_tenant_data(self) -> None:
        configs = dashboards.build_dashboard_configs("Example Client")
        self.assertNotIn("device_tree", configs["energy-home"])
        self.assertEqual(
            [view["path"] for view in configs["energy-home"]["views"]],
            ["home", "help"],
        )
        self.assertFalse(next(s for s in dashboards.DASHBOARD_SPECS if s["url_path"] == "energy-setup")["require_admin"])

    def test_assets_exist(self) -> None:
        for name in (
            "building-cards.js",
            "energy-report-card.js",
            "bill-reader.json",
        ):
            self.assertTrue((COMPONENT / "frontend" / name).is_file())
        self.assertTrue((COMPONENT / "brand" / "icon.png").is_file())
        self.assertTrue((COMPONENT / "brand" / "logo.png").is_file())

    def test_client_sidebar_is_limited_to_portal(self) -> None:
        source = (COMPONENT / "frontend" / "building-cards.js").read_text("utf-8")
        self.assertIn("Object.keys(hass.panels || {})", source)
        self.assertIn("allowed.has(id)", source)
        self.assertIn("optim_energy/whoami", source)
        self.assertIn("building-tenant-admin-card", source)

    def test_server_tenancy_files_are_present(self) -> None:
        for name in ("tenancy.py", "firewall.py"):
            self.assertTrue((COMPONENT / name).is_file())

    def test_bill_reader_uses_integration_route(self) -> None:
        source = (COMPONENT / "frontend" / "building-cards.js").read_text("utf-8")
        self.assertIn(
            "const BILL_READER = '/optim_energy_static/bill-reader.json';", source
        )
        self.assertNotIn("const BILL_READER = '/local/bill-reader.json';", source)


if __name__ == "__main__":
    unittest.main()
