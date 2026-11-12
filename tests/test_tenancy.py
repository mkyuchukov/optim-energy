"""Focused tests for the tenant model and websocket policy decisions.

These tests deliberately run without Home Assistant installed. The server
modules do not call HA APIs at import time, so small import stubs let CI check
the pure security logic in the same environment as the package tests.
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[1]
COMPONENT = ROOT / "custom_components" / "optim_energy"


def _install_ha_stubs() -> None:
    """Install only the imports used while loading the server modules."""
    modules = {
        "homeassistant": ModuleType("homeassistant"),
        "homeassistant.auth": ModuleType("homeassistant.auth"),
        "homeassistant.auth.models": ModuleType("homeassistant.auth.models"),
        "homeassistant.auth.permissions": ModuleType("homeassistant.auth.permissions"),
        "homeassistant.auth.permissions.const": ModuleType("homeassistant.auth.permissions.const"),
        "homeassistant.components": ModuleType("homeassistant.components"),
        "homeassistant.components.websocket_api": ModuleType("homeassistant.components.websocket_api"),
        "homeassistant.components.automation": ModuleType("homeassistant.components.automation"),
        "homeassistant.components.automation.config": ModuleType("homeassistant.components.automation.config"),
        "homeassistant.config": ModuleType("homeassistant.config"),
        "homeassistant.core": ModuleType("homeassistant.core"),
        "homeassistant.data_entry_flow": ModuleType("homeassistant.data_entry_flow"),
        "homeassistant.exceptions": ModuleType("homeassistant.exceptions"),
        "homeassistant.helpers": ModuleType("homeassistant.helpers"),
        "homeassistant.helpers.area_registry": ModuleType("homeassistant.helpers.area_registry"),
        "homeassistant.helpers.device_registry": ModuleType("homeassistant.helpers.device_registry"),
        "homeassistant.helpers.entity_registry": ModuleType("homeassistant.helpers.entity_registry"),
        "homeassistant.helpers.floor_registry": ModuleType("homeassistant.helpers.floor_registry"),
        "homeassistant.helpers.label_registry": ModuleType("homeassistant.helpers.label_registry"),
        "homeassistant.helpers.event": ModuleType("homeassistant.helpers.event"),
        "homeassistant.helpers.storage": ModuleType("homeassistant.helpers.storage"),
        "homeassistant.util": ModuleType("homeassistant.util"),
        "homeassistant.util.file": ModuleType("homeassistant.util.file"),
        "homeassistant.util.yaml": ModuleType("homeassistant.util.yaml"),
    }
    modules["homeassistant.auth.models"].Group = type("Group", (), {})
    modules["homeassistant.auth.models"].User = type("User", (), {})
    const = modules["homeassistant.auth.permissions.const"]
    const.POLICY_CONTROL = "control"
    const.POLICY_EDIT = "edit"
    const.POLICY_READ = "read"
    modules["homeassistant.components"].websocket_api = modules["homeassistant.components.websocket_api"]
    modules["homeassistant.components"].automation = modules["homeassistant.components.automation"]
    modules["homeassistant.components.automation"].DATA_COMPONENT = "automation"
    modules["homeassistant.components.automation"].DOMAIN = "automation"
    modules["homeassistant.components.automation.config"].async_validate_config_item = MagicMock()
    modules["homeassistant.config"].AUTOMATION_CONFIG_PATH = "automations.yaml"
    ws = modules["homeassistant.components.websocket_api"]
    ws.ActiveConnection = type("ActiveConnection", (), {})
    ws.ERR_UNAUTHORIZED = "unauthorized"
    modules["homeassistant.core"].HomeAssistant = type("HomeAssistant", (), {})
    modules["homeassistant.core"].callback = lambda fn: fn
    class FlowResultType:
        MENU = "menu"
        FORM = "form"
        CREATE_ENTRY = "create_entry"
    modules["homeassistant.data_entry_flow"].FlowResultType = FlowResultType
    modules["homeassistant.util.file"].write_utf8_file_atomic = MagicMock()
    modules["homeassistant.util.yaml"].dump = lambda value: str(value)
    modules["homeassistant.util.yaml"].load_yaml = MagicMock(return_value=[])
    modules["homeassistant.exceptions"].HomeAssistantError = RuntimeError
    modules["homeassistant.helpers.event"].async_call_later = MagicMock()
    modules["homeassistant.helpers.storage"].Store = type("Store", (), {})
    sys.modules.update(modules)
    sys.modules["probatio"] = ModuleType("probatio")


def _load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_install_ha_stubs()
_PACKAGE = ModuleType("optim_energy_test")
_PACKAGE.__path__ = [str(COMPONENT)]
sys.modules[_PACKAGE.__name__] = _PACKAGE
tenancy = _load("optim_energy_test.tenancy", COMPONENT / "tenancy.py")
firewall = _load("optim_energy_test.firewall", COMPONENT / "firewall.py")
portal_ops = _load("optim_energy_test.portal_ops", COMPONENT / "portal_ops.py")


def test_location_filter_does_not_expose_another_location() -> None:
    tree = {
        "places": [
            {"id": "loc:a", "name": "A", "kind": "location", "parent": None},
            {"id": "area:a", "name": "A room", "kind": "group", "parent": "loc:a"},
            {"id": "loc:b", "name": "B", "kind": "location", "parent": None},
            {"id": "area:b", "name": "B room", "kind": "group", "parent": "loc:b"},
        ],
        "placed": {"d:a": "area:a", "d:b": "area:b"},
        "parents": {"d:a": "virt:a", "d:b": "virt:b"},
        "virtual": [{"id": "virt:a", "name": "A virtual"}, {"id": "virt:b", "name": "B virtual"}],
        "mains": {"loc:a": "d:a", "loc:b": "d:b"},
        "prices": {"loc:a": {"mode": "fixed", "fixed": 0.2}, "loc:b": {"mode": "fixed", "fixed": 0.3}},
        "automations": [{"entity": "automation.a", "place": "area:a"}, {"entity": "automation.b", "place": "area:b"}],
        "alarms": [{"id": "a", "place": "area:a"}, {"id": "b", "place": "area:b"}],
        "kinds": {"d:a": "lights", "d:b": "relay"},
        "sums": {"virt:a": {"energy": {"entity": "sensor.a"}}, "virt:b": {"energy": {"entity": "sensor.b"}}},
    }
    scoped = tenancy._filter_tree_for_location(tree, "loc:a")
    assert [p["id"] for p in scoped["places"]] == ["loc:a", "area:a"]
    assert scoped["placed"] == {"d:a": "area:a"}
    assert [v["id"] for v in scoped["virtual"]] == ["virt:a"]
    assert scoped["mains"] == {"loc:a": "d:a"}
    assert set(scoped["prices"]) == {"loc:a"}
    assert [a["entity"] for a in scoped["automations"]] == ["automation.a"]
    assert [a["id"] for a in scoped["alarms"]] == ["a"]
    assert set(scoped["kinds"]) == {"d:a"}
    assert set(scoped["sums"]) == {"virt:a"}


class _Permissions:
    def __init__(self, allowed: set[str]) -> None:
        self.allowed = allowed

    def check_entity(self, entity_id: str, key: str) -> bool:
        return entity_id in self.allowed


class _User:
    def __init__(self, allowed: set[str] | None = None, admin: bool = False) -> None:
        self.id = "u"
        self.name = "User"
        self.is_admin = admin
        self.is_owner = False
        self.permissions = _Permissions(allowed or set())


class _Manager:
    def __init__(self, role: str | None) -> None:
        self._role = role

    def is_root(self, user: _User) -> bool:
        return user.is_admin

    def role(self, user: _User) -> str | None:
        return self._role


class _Connection:
    def __init__(self, user: _User) -> None:
        self.user = user
        self.last_id = 0
        self.send_error = MagicMock()


def _decision(role: str | None, allowed: set[str], msg: dict) -> tuple[bool, str]:
    guard = firewall.WebsocketFirewall(MagicMock(), _Manager(role))
    return guard.decision(_Connection(_User(allowed)), msg)


def test_firewall_denies_rendering_and_rest_commands() -> None:
    assert not _decision("user", {"light.a"}, {"type": "render_template"})[0]
    assert not _decision("user", {"light.a"}, {"type": "call_service", "domain": "rest_command", "service": "chat"})[0]
    assert _decision("user", {"light.a"}, {"type": "call_service", "domain": "light", "service": "toggle"})[0]


def test_firewall_rejects_foreign_history_and_statistics() -> None:
    assert not _decision("user", {"sensor.a"}, {"type": "history/history_during_period", "entity_ids": ["sensor.a", "sensor.b"]})[0]
    assert not _decision("user", {"sensor.a"}, {"type": "recorder/statistics_during_period", "statistic_ids": ["sensor.a", "sensor.b"]})[0]
    assert _decision("user", {"sensor.a"}, {"type": "recorder/statistics_during_period", "statistic_ids": ["sensor.a"]})[0]


def test_unassigned_account_is_fail_closed() -> None:
    assert not _decision(None, {"sensor.a"}, {"type": "get_states"})[0]
    assert _decision(None, set(), {"type": "optim_energy/whoami"})[0]


def test_rest_guard_keeps_only_the_bootstrap_allowlist_for_tenants() -> None:
    for path in ("/api/", "/api/config", "/api/websocket"):
        assert firewall._rest_request_decision(path, authenticated=True, root=False)[0]

    for path in (
        "/api/states",
        "/api/history/period/2026-11-11T00:00:00+00:00",
        "/api/logbook/2026-11-11T00:00:00+00:00",
        "/api/template",
        "/api/services",
        "/api/config/config_entries/entry",
        "/api/error_log",
    ):
        assert not firewall._rest_request_decision(path, authenticated=True, root=False)[0]


def test_rest_guard_leaves_unauthenticated_regular_api_paths_to_ha_auth() -> None:
    assert firewall._rest_request_decision("/api/states", authenticated=False, root=False)[0]
    assert firewall._rest_request_decision("/api/template", authenticated=False, root=False)[0]


def test_rest_guard_hard_blocks_webhooks_without_root() -> None:
    for path in (
        "/api/webhook",
        "/api/webhook/",
        "/api/webhook/companion-device",
    ):
        assert not firewall._rest_request_decision(path, authenticated=False, root=False)[0]
        assert not firewall._rest_request_decision(path, authenticated=True, root=False)[0]
        assert firewall._rest_request_decision(path, authenticated=True, root=True)[0]


def test_rest_guard_allows_valid_ingress_capability_session() -> None:
    for path in (
        "/api/hassio_ingress",
        "/api/hassio_ingress/",
        "/api/hassio_ingress/signed-addon-url",
    ):
        assert not firewall._rest_request_decision(path, authenticated=False, root=False)[0]
        assert not firewall._rest_request_decision(path, authenticated=True, root=False)[0]
        assert firewall._rest_request_decision(
            path,
            authenticated=False,
            root=False,
            ingress_session=True,
        )[0]
        assert firewall._rest_request_decision(path, authenticated=True, root=True)[0]


def test_rest_guard_allows_root_and_non_api_paths() -> None:
    assert firewall._rest_request_decision("/api/states", authenticated=True, root=True)[0]
    assert firewall._rest_request_decision("/auth/login_flow", authenticated=False, root=False)[0]
    assert firewall._rest_request_decision("/optim_energy_static/app.js", authenticated=False, root=False)[0]


def test_multi_location_tree_filter_and_legacy_assignment() -> None:
    tree = {
        "places": [
            {"id": "loc:a", "name": "A", "kind": "location", "parent": None},
            {"id": "area:a", "name": "A room", "kind": "group", "parent": "loc:a"},
            {"id": "loc:b", "name": "B", "kind": "location", "parent": None},
            {"id": "area:b", "name": "B room", "kind": "group", "parent": "loc:b"},
        ],
        "placed": {"d:a": "area:a", "d:b": "area:b"},
        "mains": {"loc:a": "d:a", "loc:b": "d:b"},
        "virtual": [],
    }
    assert tenancy._record_locations({"location": "loc:a"}) == ["loc:a"]
    assert tenancy._record_locations({"location": "loc:a", "locations": ["loc:a", "loc:b"]}) == ["loc:a", "loc:b"]
    scoped = tenancy._filter_tree_for_locations(tree, ["loc:a", "loc:b"])
    assert {p["id"] for p in scoped["places"]} == {"loc:a", "area:a", "loc:b", "area:b"}
    assert set(scoped["placed"]) == {"d:a", "d:b"}


def test_tree_payload_rejects_wrong_shapes() -> None:
    try:
        tenancy._guard_tree({"places": "not a list"})
    except RuntimeError:
        pass
    else:
        raise AssertionError("invalid tree payload was accepted")


def test_registry_entry_preserves_user_device_name_and_metadata() -> None:
    entry = SimpleNamespace(
        id="device-id",
        name="shelly3em63g3-9c9e6e3fda60",
        name_by_user="T18 Main",
        original_name=None,
        manufacturer="Shelly",
        model="Shelly 1PM Gen4",
        model_id="S4SW-001P16EU",
        configuration_url="http://192.168.40.52:80",
        via_device_id="parent-device",
    )
    payload = tenancy._registry_entry_dict(entry)
    assert payload["name"] == "shelly3em63g3-9c9e6e3fda60"
    assert payload["name_by_user"] == "T18 Main"
    assert payload["manufacturer"] == "Shelly"
    assert payload["model"] == "Shelly 1PM Gen4"
    assert payload["model_id"] == "S4SW-001P16EU"
    assert payload["configuration_url"] == "http://192.168.40.52:80"
    assert payload["via_device_id"] == "parent-device"


class TenancyTests(unittest.TestCase):
    """Run the module-level checks under unittest discovery."""

    def test_location_filter(self) -> None:
        test_location_filter_does_not_expose_another_location()

    def test_firewall_service_policy(self) -> None:
        test_firewall_denies_rendering_and_rest_commands()

    def test_firewall_data_policy(self) -> None:
        test_firewall_rejects_foreign_history_and_statistics()

    def test_unassigned_policy(self) -> None:
        test_unassigned_account_is_fail_closed()

    def test_rest_tenant_allowlist(self) -> None:
        test_rest_guard_keeps_only_the_bootstrap_allowlist_for_tenants()

    def test_rest_unauthenticated_fallback(self) -> None:
        test_rest_guard_leaves_unauthenticated_regular_api_paths_to_ha_auth()

    def test_rest_bypass_surfaces(self) -> None:
        test_rest_guard_hard_blocks_webhooks_without_root()
        test_rest_guard_allows_valid_ingress_capability_session()

    def test_rest_root_and_static_paths(self) -> None:
        test_rest_guard_allows_root_and_non_api_paths()

    def test_tree_shape(self) -> None:
        test_tree_payload_rejects_wrong_shapes()

    def test_multi_location_assignment(self) -> None:
        test_multi_location_tree_filter_and_legacy_assignment()

    def test_registry_device_name(self) -> None:
        test_registry_entry_preserves_user_device_name_and_metadata()

    def test_schedule_builder_is_fixed_schema(self) -> None:
        config = portal_ops.build_schedule_config(
            "portal_1", "Evening", "off", "18:30", ["mon", "fri"], ["switch.a"]
        )
        assert config["triggers"] == [{"trigger": "time", "at": "18:30:00"}]
        assert config["actions"][0]["action"] == "switch.turn_off"
        assert config["actions"][0]["target"]["entity_id"] == ["switch.a"]
        assert config["conditions"][0]["weekday"] == ["mon", "fri"]

    def test_schedule_builder_rejects_foreign_domains(self) -> None:
        try:
            portal_ops.build_schedule_config(
                "portal_1", "Bad", "on", "18:30", ["mon"], ["automation.a"]
            )
        except RuntimeError:
            pass
        else:
            raise AssertionError("schedule builder accepted an unsupported target domain")

    def test_client_admin_tree_save_changes_prices_only(self) -> None:
        stored = {
            "places": [{"id": "loc:a", "kind": "location"}],
            "placed": {"d:a": "loc:a"},
            "virtual": [{"id": "virt:a"}],
            "sums": {"virt:a": {"energy": {"entry": "own", "entity": "sensor.a"}}},
            "automations": [{"entity": "automation.a"}],
            "parents": {},
            "mains": {"loc:a": "d:a"},
            "prices": {},
        }
        hostile = {
            "places": [{"id": "area_of_b", "kind": "location"}],
            "placed": {"d:b": "loc:a"},
            "virtual": [{"id": "virt:x"}],
            "sums": {"virt:x": {"energy": {"entry": "mqtt_entry", "entity": "sensor.b"}}},
            "automations": [{"entity": "automation.b"}],
            "parents": {"d:b": "d:a"},
            "mains": {"loc:a": "d:b"},
            "prices": {"loc:a": {"mode": "fixed", "fixed": 0.2}},
        }
        clean = tenancy._client_tree_update(stored, hostile, {"loc:a"})
        assert clean == {**stored, "prices": {"loc:a": {"mode": "fixed", "fixed": 0.2}}}
        for bad in (
            {"loc:b": {"mode": "fixed"}},  # another client's location
            {"loc:a": {"mode": "exchange", "sensor": "sensor.x') }}{{ states('sensor.b"}},
            {"loc:a": "fixed"},
            {"loc:a": {"deep": {"a": {"b": {"c": {"d": {}}}}}}},
        ):
            with self.assertRaises(RuntimeError):
                tenancy._client_tree_update(stored, {"prices": bad}, {"loc:a"})

    def test_alert_template_takes_no_free_text(self) -> None:
        text = portal_ops.alert_message("warn", "binary_sensor.rule", "sensor.a_power", "W")
        assert "states('sensor.a_power')" in text
        for rule, sensor, unit in (
            ("binary_sensor.rule", "sensor.a", "}}{{ states('sensor.b') }}"),
            ("binary_sensor.rule", "sensor.a') }}{{ states('sensor.b", "W"),
            ("binary_sensor.r') }}", "sensor.a", "W"),
        ):
            with self.assertRaises(RuntimeError):
                portal_ops.alert_message("warn", rule, sensor, unit)

    def test_helpers_and_automations_need_recorded_ownership(self) -> None:
        import asyncio
        from unittest.mock import AsyncMock

        entries = {
            "own": SimpleNamespace(entry_id="own", domain="threshold"),
            "foreign": SimpleNamespace(entry_id="foreign", domain="threshold"),
            "mqtt": SimpleNamespace(entry_id="mqtt", domain="mqtt"),
        }
        registry = {
            "binary_sensor.own": SimpleNamespace(config_entry_id="own"),
            "binary_sensor.foreign": SimpleNamespace(config_entry_id="foreign"),
        }
        portal_ops.er.async_get = lambda hass: SimpleNamespace(async_get=registry.get)

        class Tenancy:
            def __init__(self, role: str, fail: bool = False) -> None:
                self.role, self.fail = role, fail
                self.owned = {"entries": {"own"}, "automations": {"portal_own"}}
                self.tree = {"sums": {"virt:a": {"energy": {"entry": "mqtt"}}}}
                self.stored = None

            def is_root(self, user: _User) -> bool:
                return user.is_admin

            def require_client_value(self, user: _User, client: str | None = None):
                return "a", {"is_root": user.is_admin, "role": self.role}

            def tree_for(self, user: _User, client: str | None = None):
                return {"tree": self.tree}

            def owns(self, client_id: str, kind: str, value: str) -> bool:
                return value in self.owned[kind]

            async def async_set_owned(self, client_id, kind, value, present) -> None:
                if self.fail:
                    raise OSError("disk full")
                (self.owned[kind].add if present else self.owned[kind].discard)(value)

            async def async_store_tree(self, client_id, tree) -> None:
                self.stored = tree

        def ops_for(role: str, fail: bool = False):
            hass = SimpleNamespace(
                config_entries=SimpleNamespace(
                    async_get_entry=entries.get, async_remove=AsyncMock()
                ),
                states=SimpleNamespace(get=lambda entity_id: SimpleNamespace(
                    attributes={"id": {"automation.own": "portal_own", "automation.root": "root_made"}.get(entity_id)}
                )),
                data={},
            )
            return portal_ops.PortalOperations(hass, Tenancy(role, fail)), hass

        everything = {"binary_sensor.own", "binary_sensor.foreign"}
        # A plain user cannot delete a helper, even one it can read.
        ops, hass = ops_for("user")
        with self.assertRaises(RuntimeError):
            asyncio.run(ops.async_delete_helper(_User(everything), "binary_sensor.own"))
        hass.config_entries.async_remove.assert_not_called()
        # A client admin cannot delete a helper it can read but did not create.
        ops, hass = ops_for("client_admin")
        with self.assertRaises(RuntimeError):
            asyncio.run(ops.async_delete_helper(_User(everything), "binary_sensor.foreign"))
        hass.config_entries.async_remove.assert_not_called()
        asyncio.run(ops.async_delete_helper(_User(everything), "binary_sensor.own"))
        hass.config_entries.async_remove.assert_called_once_with("own")
        # A tree that names a shared integration as a Sum never gets it removed.
        ops, hass = ops_for("client_admin")
        with self.assertRaises(RuntimeError):
            asyncio.run(ops.async_delete_sum(_User(), "virt:a", "energy"))
        hass.config_entries.async_remove.assert_not_called()
        # Automations: only what this client's commands created.
        with self.assertRaises(RuntimeError):
            asyncio.run(ops.async_automation_get(_User(), "automation.root"))
        # A failed ownership save leaves no helper behind.
        ops, hass = ops_for("client_admin", fail=True)
        undo = AsyncMock()
        with self.assertRaises(OSError):
            asyncio.run(ops._async_record_owned("a", "entries", "new", undo))
        undo.assert_awaited_once()

    def test_guard_is_closed_before_tenancy_loads(self) -> None:
        # Stage one of startup: the guard wraps a manager with no data. If
        # loading the store then fails, this is what tenants keep getting.
        manager = tenancy.TenancyManager.__new__(tenancy.TenancyManager)
        manager.data = {}
        guard = firewall.WebsocketFirewall(MagicMock(), manager)
        tenant = _Connection(_User({"light.a"}))
        for msg in (
            {"type": "get_states"},
            {"type": "subscribe_entities"},
            {"type": "call_service", "domain": "light", "service": "turn_on"},
            {"type": "history/history_during_period", "entity_ids": ["light.a"]},
            {"type": "config/entity_registry/list"},
            {"type": "optim_energy/tree/get"},
            {"type": "optim_energy/registry/list", "kind": "device"},
        ):
            assert not guard.decision(tenant, msg)[0], msg
        assert guard.decision(_Connection(_User(admin=True)), {"type": "get_states"})[0]
        assert not firewall._rest_request_decision("/api/states", authenticated=True, root=False)[0]

    def test_every_command_has_a_capability_row(self) -> None:
        import re

        registered: set[str] = set()
        for name in ("tenancy.py", "portal_ops.py"):
            source = (COMPONENT / name).read_text()
            registered.update(re.findall(r'Required\("type"\): f"\{DOMAIN\}/([a-z_/]+)"', source))
            registered.update(re.findall(r'_command\(\s*"([a-z_/]+)"', source))
        documented = set(
            re.findall(r"^\| `([a-z_/]+)` \|", (ROOT / "docs" / "CAPABILITIES.md").read_text(), re.M)
        )
        assert registered and registered == documented, registered ^ documented
