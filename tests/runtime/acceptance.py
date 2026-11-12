"""End-to-end acceptance tests against a pinned real Home Assistant runtime."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from ha_client import Http, WebSocket, wait_ready

ROOT = Path(__file__).resolve().parents[2]
COMPONENT = ROOT / "custom_components" / "optim_energy"
VERSION_FILE = Path(__file__).with_name("HA_VERSION")
OWNER_USERNAME = "runtime_owner"
OWNER_PASSWORD = "Runtime-Owner-2026!"
CLIENT_A_USER = ("runtime_user_a", "Runtime-UserA-2026!")
CLIENT_B_USER = ("runtime_user_b", "Runtime-UserB-2026!")
CLIENT_ADMIN_A = ("runtime_admin_a", "Runtime-AdminA-2026!")
LEGACY_TREE = {
    "places": [
        {"id": "loc:legacy", "name": "Legacy Site", "kind": "location", "parent": None},
        {"id": "area:legacy", "name": "Legacy Room", "kind": "group", "parent": "loc:legacy"},
    ],
    "mains": {"loc:legacy": "legacy-device"},
    "prices": {"loc:legacy": {"mode": "fixed", "fixed": 0.25}},
}


class RuntimeHarness:
    """Own one disposable Home Assistant Docker container."""

    def __init__(
        self, version: str, port: int, *, keep: bool = False, profile: str = "base"
    ) -> None:
        self.version = version
        self.port = port
        self.keep = keep
        self.profile = profile
        self.image = f"ghcr.io/home-assistant/home-assistant:{version}"
        self.name = f"optim-energy-runtime-{os.getpid()}"
        self.temp_dir = Path(tempfile.mkdtemp(prefix="optim-energy-runtime-"))
        self.config_dir = self.temp_dir / "config"
        self.config_dir.mkdir()
        self._write_config()

    def _write_config(self) -> None:
        entities = (
            [("runtime_a_toggle", "Runtime Client A Toggle"), ("runtime_b_toggle", "Runtime Client B Toggle")]
            if self.profile == "base"
            else [
                (f"runtime_{client}_{index:03d}", f"Runtime {client.upper()} {index:03d}")
                for client in ("a", "b", "c")
                for index in range(120)
            ]
        )
        input_boolean = "\n".join(
            f"  {entity_id}:\n    name: {name}" for entity_id, name in entities
        )
        scale_template = (
            """
template:
  - sensor:
      - name: Runtime A Energy
        unique_id: runtime_a_energy
        unit_of_measurement: kWh
        state_class: total_increasing
        state: "1"
      - name: Runtime B Energy
        unique_id: runtime_b_energy
        unit_of_measurement: kWh
        state_class: total_increasing
        state: "1"
      - name: Runtime C Energy
        unique_id: runtime_c_energy
        unit_of_measurement: kWh
        state_class: total_increasing
        state: "1"
"""
            if self.profile == "scale"
            else ""
        )
        (self.config_dir / "configuration.yaml").write_text(
            f"""\
homeassistant:
  name: Runtime Test
  latitude: 42.6977
  longitude: 23.3219
  elevation: 550
  unit_system: metric
  country: BG
  time_zone: Europe/Sofia
http:
  ip_ban_enabled: false
frontend:
lovelace:
recorder:
  db_url: sqlite:////config/recorder.db
  purge_keep_days: 1
input_boolean:
{input_boolean}
{scale_template}optim_runtime_fixture:
logger:
  default: warning
  logs:
    custom_components.optim_energy: info
""",
            encoding="utf-8",
        )

    def _docker(self, *args: str, timeout: int = 120) -> str:
        result = subprocess.run(
            ["docker", *args],
            check=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return result.stdout.strip()

    def start(self) -> None:
        subprocess.run(["docker", "rm", "-f", self.name], capture_output=True, text=True)
        self._docker(
            "run",
            "-d",
            "--name",
            self.name,
            "-p",
            f"127.0.0.1:{self.port}:8123",
            "-v",
            f"{self.config_dir}:/config",
            "-v",
            f"{COMPONENT}:/config/custom_components/optim_energy:ro",
            "-v",
            f"{Path(__file__).with_name('fixture_component')}:/config/custom_components/optim_runtime_fixture:ro",
            self.image,
            timeout=300,
        )

    def stop(self) -> None:
        if not self.keep:
            subprocess.run(
                ["docker", "rm", "-f", self.name], capture_output=True, text=True
            )

    def cleanup(self) -> None:
        if not self.keep:
            shutil.rmtree(self.temp_dir, ignore_errors=True)

    def logs(self) -> str:
        result = subprocess.run(
            ["docker", "logs", "--tail", "400", self.name],
            capture_output=True,
            text=True,
        )
        return result.stdout + result.stderr

    def restart(self) -> None:
        self._docker("restart", self.name, timeout=180)

    def file_size(self, path: str) -> int:
        return int(self._docker("exec", self.name, "stat", "-c", "%s", path))

    def backup_config(self) -> None:
        """Create the operational backup used by the restore rehearsal."""
        self._docker(
            "exec",
            self.name,
            "sh",
            "-c",
            "rm -rf /config/ops_backup && mkdir -p /config/ops_backup && "
            "for f in auth optim_energy.tenancy optim_energy.migration_backup; do "
            "[ -e /config/.storage/$f ] && cp -a /config/.storage/$f /config/ops_backup/; "
            "done; for f in /config/.storage/lovelace*; do "
            "[ -e $f ] && cp -a $f /config/ops_backup/; done; true",
            timeout=180,
        )

    def stop_container(self) -> None:
        self._docker("stop", self.name, timeout=180)

    def start_container(self) -> None:
        self._docker("start", self.name, timeout=180)

    def restore_config(self) -> None:
        """Restore the operational files into the stopped container's config."""
        self._docker(
            "run",
            "--rm",
            "--entrypoint",
            "sh",
            "-v",
            f"{self.config_dir}:/config",
            self.image,
            "-c",
            "cp -a /config/ops_backup/. /config/.storage/",
            timeout=180,
        )

    def storage(self, key: str) -> dict[str, Any]:
        try:
            raw = self._docker("exec", self.name, "cat", f"/config/.storage/{key}")
        except subprocess.CalledProcessError as err:
            raise AssertionError(f"missing storage file: {key}") from err
        return json.loads(raw)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def assert_equal(actual: Any, expected: Any, message: str) -> None:
    if actual != expected:
        raise AssertionError(f"{message}: expected {expected!r}, got {actual!r}")


def assert_true(value: Any, message: str) -> None:
    if not value:
        raise AssertionError(message)


def complete_onboarding(http: Http) -> str:
    steps = wait_ready(http)
    client_id = http.base_url + "/"
    user_done = next(step for step in steps if step["step"] == "user")["done"]
    if user_done:
        return str(http.login(OWNER_USERNAME, OWNER_PASSWORD)["access_token"])

    _, created = http.request(
        "POST",
        "/api/onboarding/users",
        {
            "name": "Runtime Owner",
            "username": OWNER_USERNAME,
            "password": OWNER_PASSWORD,
            "client_id": client_id,
            "language": "en",
        },
    )
    _, tokens = http.request(
        "POST",
        "/auth/token",
        {
            "grant_type": "authorization_code",
            "code": created["auth_code"],
            "client_id": client_id,
        },
        form=True,
    )
    token = str(tokens["access_token"])
    _, onboarding = http.request("GET", "/api/onboarding")
    done = {step["step"] for step in onboarding if step["done"]}
    if "core_config" not in done:
        http.request("POST", "/api/onboarding/core_config", {}, token=token)
        done.add("core_config")
    if "analytics" not in done:
        http.request("POST", "/api/onboarding/analytics", {}, token=token)
        done.add("analytics")
    if "integration" not in done:
        http.request(
            "POST",
            "/api/onboarding/integration",
            {"client_id": client_id, "redirect_uri": client_id + "?auth_callback=1"},
            token=token,
        )
    return token


def create_config_entry(http: Http, token: str) -> str:
    _, flow = http.request(
        "POST",
        "/api/config/config_entries/flow",
        {"handler": "optim_energy", "show_advanced_options": False},
        token=token,
    )
    assert_equal(flow.get("type"), "form", "Optim Energy config flow")
    _, result = http.request(
        "POST",
        f"/api/config/config_entries/flow/{flow['flow_id']}",
        {"site_name": "Runtime Test"},
        token=token,
    )
    assert_equal(result.get("type"), "create_entry", "Optim Energy entry creation")
    entry = result["result"]
    assert_equal(entry.get("state"), "loaded", "Optim Energy entry state")
    return str(entry["entry_id"])


def create_fixture_entry(http: Http, token: str) -> str:
    """Create the runtime fixture config entry used to own test devices."""
    _, flow = http.request(
        "POST",
        "/api/config/config_entries/flow",
        {"handler": "optim_runtime_fixture", "show_advanced_options": False},
        token=token,
    )
    assert_equal(flow.get("type"), "form", "runtime fixture config flow")
    _, result = http.request(
        "POST",
        f"/api/config/config_entries/flow/{flow['flow_id']}",
        {},
        token=token,
    )
    assert_equal(result.get("type"), "create_entry", "runtime fixture entry")
    return str(result["result"]["entry_id"])


def set_audit_mode(http: Http, token: str, entry_id: str, enabled: bool) -> None:
    """Toggle Optim Energy audit mode through the real options flow."""
    _, flow = http.request(
        "POST",
        "/api/config/config_entries/options/flow",
        {"handler": entry_id},
        token=token,
    )
    assert_equal(flow.get("type"), "form", "audit options flow")
    _, result = http.request(
        "POST",
        f"/api/config/config_entries/options/flow/{flow['flow_id']}",
        {"audit": enabled},
        token=token,
    )
    assert_equal(result.get("type"), "create_entry", "audit options update")


def wait_until(predicate: Any, message: str, timeout: float = 30.0) -> Any:
    deadline = time.monotonic() + timeout
    last: Any = None
    while time.monotonic() < deadline:
        try:
            last = predicate()
            if last:
                return last
        except Exception as exc:  # pragma: no cover - diagnostic path
            last = exc
        time.sleep(0.25)
    raise AssertionError(f"{message}; last={last!r}")


def ensure_label(root: WebSocket, label_id: str, name: str) -> None:
    labels = root.command({"type": "config/label_registry/list"})
    if any(label["label_id"] == label_id for label in labels):
        return
    root.command(
        {
            "type": "config/label_registry/create",
            "name": name,
            "icon": "mdi:map-marker",
            "description": "Optim Energy runtime location",
            "color": "blue",
        }
    )


def ensure_area(root: WebSocket, area_id: str, name: str, label_id: str) -> str:
    areas = root.command({"type": "config/area_registry/list"})
    existing = next((area for area in areas if area["area_id"] == area_id), None)
    if existing is None:
        created = root.command(
            {
                "type": "config/area_registry/create",
                "name": name,
                "labels": [label_id],
                "aliases": [],
            }
        )
        return str(created["area_id"])
    else:
        updated = root.command(
            {
                "type": "config/area_registry/update",
                "area_id": area_id,
                "labels": sorted(set(existing.get("labels", [])) | {label_id}),
            }
        )
        return str(updated["area_id"])


def set_entity_place(
    root: WebSocket, entity_id: str, area_id: str, label_id: str
) -> None:
    root.command(
        {
            "type": "config/entity_registry/update",
            "entity_id": entity_id,
            "area_id": area_id,
            "labels": [label_id],
        }
    )


def ensure_client(root: WebSocket, name: str) -> tuple[str, str]:
    for client in root.command({"type": "optim_energy/client/list"}):
        if client["name"] == name:
            return str(client["id"]), str(client["slug"])
    created = root.command({"type": "optim_energy/client/create", "name": name})
    return str(created["id"]), str(created["slug"])


def client_tree(root: WebSocket, client_id: str) -> dict[str, Any]:
    return root.command({"type": "optim_energy/tree/get", "client": client_id})["tree"]


def location_for_label(tree: dict[str, Any], label_id: str) -> str:
    expected = f"loc:{label_id}"
    for place in tree.get("places", []):
        if place.get("id") == expected:
            return expected
    raise AssertionError(f"location {expected} missing from tree")


def ensure_user(
    root: WebSocket,
    *,
    client_id: str,
    name: str,
    username: str,
    password: str,
    role: str,
    location: str | None,
) -> dict[str, Any]:
    for user in root.command({"type": "optim_energy/user/list"}):
        if user.get("username") == username:
            return user
    payload: dict[str, Any] = {
        "type": "optim_energy/user/create",
        "client": client_id,
        "name": name,
        "username": username,
        "password": password,
        "role": role,
    }
    if location:
        payload["location"] = location
    return root.command(payload)


def assert_tenant_rest(http: Http, token: str) -> None:
    assert_equal(http.request("GET", "/api/", token=token)[0], 200, "tenant API root")
    assert_equal(
        http.request("GET", "/api/config", token=token)[0], 200, "tenant API config"
    )
    for method, path, body in (
        ("GET", "/api/states", None),
        ("GET", "/api/history/period/2026-11-11T00:00:00+00:00", None),
        ("GET", "/api/logbook/2026-11-11T00:00:00+00:00", None),
        ("GET", "/api/services", None),
        ("GET", "/api/config/config_entries/entry", None),
        ("GET", "/api/error_log", None),
        ("POST", "/api/template", {"template": "1"}),
        ("POST", "/api/webhook/acceptance-does-not-exist", {}),
        ("GET", "/api/hassio_ingress/acceptance-does-not-exist", None),
    ):
        status = http.request(
            method, path, body, token=token, expected=(403,)
        )[0]
        assert_equal(status, 403, f"tenant REST denial for {path}")
    assert_equal(
        http.request("GET", "/api/states", expected=(401,))[0],
        401,
        "anonymous REST denial",
    )


def assert_tenant_ws(
    http: Http,
    token: str,
    *,
    expected_entities: set[str],
    expected_devices: set[str],
    expected_areas: set[str],
) -> None:
    tenant = WebSocket(http.host, http.port)
    try:
        tenant.auth(token)
        states = tenant.command({"type": "get_states"})
        entity_ids = {state["entity_id"] for state in states}
        assert_true(
            expected_entities <= entity_ids,
            "tenant-owned states are missing",
        )
        registry = tenant.command(
            {"type": "config/entity_registry/list_for_display"}
        )["entities"]
        registry_ids = {entry["entity_id"] for entry in registry}
        assert_equal(
            registry_ids,
            expected_entities,
            "tenant-filtered entity registry",
        )
        devices = tenant.command(
            {"type": "optim_energy/registry/list", "kind": "device"}
        )
        assert_equal(
            {device["id"] for device in devices},
            expected_devices,
            "tenant-filtered device registry",
        )
        areas = tenant.command(
            {"type": "optim_energy/registry/list", "kind": "area"}
        )
        assert_equal(
            {area["area_id"] for area in areas},
            expected_areas,
            "tenant-filtered area registry",
        )
        assert_equal(
            tenant.command({"type": "repairs/list_issues"}),
            {"issues": []},
            "tenant repairs filtering",
        )
        for payload in (
            {
                "type": "history/history_during_period",
                "start_time": "2026-11-11T00:00:00+00:00",
                "entity_ids": ["input_boolean.runtime_b_toggle"],
                "minimal_response": True,
            },
            {
                "type": "recorder/statistics_during_period",
                "start_time": "2026-11-11T00:00:00+00:00",
                "statistic_ids": ["input_boolean.runtime_b_toggle"],
                "period": "hour",
                "types": ["mean"],
            },
            {"type": "render_template", "template": "{{ 1 }}"},
            {
                "type": "call_service",
                "domain": "rest_command",
                "service": "discretestack_chat",
                "service_data": {},
            },
            {"type": "config/entity_registry/list"},
            {"type": "config/auth/list"},
            {
                "type": "optim_runtime_fixture/late_probe",
            },
        ):
            try:
                tenant.command(payload)
            except RuntimeError:
                pass
            else:
                raise AssertionError(f"tenant command was not denied: {payload['type']}")
    finally:
        tenant.close()


def read_policy_group(harness: RuntimeHarness, group_id: str) -> dict[str, Any]:
    auth = harness.storage("auth")["data"]
    groups = auth["groups"]
    if isinstance(groups, dict):
        return groups[group_id]
    return next(group for group in groups if group["id"] == group_id)


def run(version: str, *, keep: bool = False) -> None:
    port = free_port()
    harness = RuntimeHarness(version, port, keep=keep)
    http = Http(f"http://127.0.0.1:{port}")
    success = False
    try:
        harness.start()
        root_token = complete_onboarding(http)
        _, config = http.request("GET", "/api/config", token=root_token)
        assert_equal(config["version"], version, "pinned HA runtime version")
        root = WebSocket(http.host, http.port)
        root.auth(root_token)
        try:
            root.command(
                {
                    "type": "lovelace/dashboards/create",
                    "url_path": "energy-home",
                    "title": "Legacy Optim Energy",
                    "icon": "mdi:flash",
                    "show_in_sidebar": True,
                    "require_admin": False,
                }
            )
            root.command(
                {
                    "type": "lovelace/config/save",
                    "url_path": "energy-home",
                    "config": {"views": [], "device_tree": LEGACY_TREE},
                }
            )
        finally:
            root.close()
        wait_until(
            lambda: any(
                item["url_path"] == "energy-home"
                for item in harness.storage("lovelace_dashboards")["data"]["items"]
            ),
            "legacy dashboard metadata was not persisted",
            timeout=20,
        )

        entry_id = create_config_entry(http, root_token)
        fixture_entry_id = create_fixture_entry(http, root_token)
        wait_until(
            lambda: "Optim Energy websocket firewall active"
            in harness.logs()
            and "Optim Energy REST guard active" in harness.logs(),
            "runtime guards did not report activation",
        )
        backup = wait_until(
            lambda: harness.storage("optim_energy.migration_backup"),
            "legacy dashboard backup was not written",
        )
        assert_equal(
            backup["data"]["dashboard"]["device_tree"],
            LEGACY_TREE,
            "legacy dashboard backup contents",
        )
        backup_created = backup["data"]["created_at"]
        tenancy = harness.storage("optim_energy.tenancy")["data"]
        assert_equal(
            tenancy["trees"]["default"]["places"],
            LEGACY_TREE["places"],
            "legacy tree migration",
        )
        root = WebSocket(http.host, http.port)
        root.auth(root_token)
        root.command({"type": "optim_runtime_fixture/install_late_command"})
        assert_equal(
            root.command({"type": "optim_runtime_fixture/late_probe"}),
            {"late": True},
            "late-registered fixture command",
        )
        saved_dashboard = root.command(
            {"type": "lovelace/config", "url_path": "energy-home"}
        )
        assert_true(
            "device_tree" not in saved_dashboard,
            "legacy tree remained in Lovelace storage",
        )
        dashboards = root.command({"type": "lovelace/dashboards/list"})
        assert_equal(
            {item["url_path"] for item in dashboards}
            & {
                "energy-admin",
                "energy-locations",
                "energy-home",
                "energy-groups",
                "energy-controls",
                "energy-devices",
                "energy-reports",
                "energy-alerts",
                "energy-setup",
            },
            {
                "energy-admin",
                "energy-locations",
                "energy-home",
                "energy-groups",
                "energy-controls",
                "energy-devices",
                "energy-reports",
                "energy-alerts",
                "energy-setup",
            },
            "portal dashboards",
        )

        ensure_label(root, "runtime_client_a", "Runtime Client A")
        ensure_label(root, "runtime_client_b", "Runtime Client B")
        ensure_area(root, "living_room", "Living Room", "runtime_client_a")
        ensure_area(root, "kitchen", "Kitchen", "runtime_client_b")
        set_entity_place(
            root,
            "input_boolean.runtime_a_toggle",
            "living_room",
            "runtime_client_a",
        )
        set_entity_place(
            root,
            "input_boolean.runtime_b_toggle",
            "kitchen",
            "runtime_client_b",
        )
        fixture_devices = root.command(
            {
                "type": "optim_runtime_fixture/create_devices",
                "config_entry_id": fixture_entry_id,
                "devices": [
                    {
                        "key": "client_a_area_device",
                        "name": "Runtime Client A Area Device",
                        "area_id": "living_room",
                    },
                    {
                        "key": "client_b_label_device",
                        "name": "Runtime Client B Label Device",
                        "labels": ["runtime_client_b"],
                    },
                ],
            }
        )
        devices_by_name = {device["name"]: device for device in fixture_devices}
        client_a, _ = ensure_client(root, "Runtime Client A")
        client_b, _ = ensure_client(root, "Runtime Client B")
        root.command(
            {
                "type": "optim_energy/client/set_locations",
                "client": client_a,
                "labels": ["runtime_client_a"],
            }
        )
        root.command(
            {
                "type": "optim_energy/client/set_locations",
                "client": client_b,
                "labels": ["runtime_client_b"],
            }
        )
        tree_a = client_tree(root, client_a)
        tree_b = client_tree(root, client_b)
        location_a = location_for_label(tree_a, "runtime_client_a")
        location_b = location_for_label(tree_b, "runtime_client_b")
        ensure_user(
            root,
            client_id=client_a,
            name="Runtime Admin A",
            username=CLIENT_ADMIN_A[0],
            password=CLIENT_ADMIN_A[1],
            role="client_admin",
            location=None,
        )
        user_a = ensure_user(
            root,
            client_id=client_a,
            name="Runtime User A",
            username=CLIENT_A_USER[0],
            password=CLIENT_A_USER[1],
            role="user",
            location=location_a,
        )
        user_b = ensure_user(
            root,
            client_id=client_b,
            name="Runtime User B",
            username=CLIENT_B_USER[0],
            password=CLIENT_B_USER[1],
            role="user",
            location=location_b,
        )

        unassigned = root.command(
            {"type": "config/auth/create", "name": "Runtime Unassigned"}
        )["user"]
        root.command(
            {
                "type": "optim_energy/client/set_locations",
                "client": client_a,
                "labels": ["runtime_client_a"],
            }
        )
        unassigned_now = next(
            user
            for user in root.command({"type": "config/auth/list"})
            if user["id"] == unassigned["id"]
        )
        assert_true(
            unassigned_now["group_ids"]
            and all(
                group.startswith("optim_energy_user_")
                for group in unassigned_now["group_ids"]
            ),
            f"unassigned user retained a system group: {unassigned_now['group_ids']}",
        )
        group_id = unassigned_now["group_ids"][0]
        policy = wait_until(
            lambda: read_policy_group(harness, group_id).get("policy"),
            "unassigned group policy was not persisted",
        )
        assert_equal(
            policy,
            {"entities": {"area_ids": {}, "entity_ids": {}}},
            "unassigned fail-closed policy",
        )

        token_a = http.login(*CLIENT_A_USER)["access_token"]
        assert_tenant_rest(http, token_a)
        assert_tenant_ws(
            http,
            token_a,
            expected_entities={"input_boolean.runtime_a_toggle"},
            expected_devices={devices_by_name["Runtime Client A Area Device"]["id"]},
            expected_areas={"living_room"},
        )
        token_b = http.login(*CLIENT_B_USER)["access_token"]
        b = WebSocket(http.host, http.port)
        try:
            b.auth(token_b)
            b_ids = {
                state["entity_id"]
                for state in b.command({"type": "get_states"})
                if state["entity_id"].startswith("input_boolean.")
            }
            assert_equal(
                b_ids,
                {"input_boolean.runtime_b_toggle"},
                "Client B state isolation",
            )
            b_devices = b.command(
                {"type": "optim_energy/registry/list", "kind": "device"}
            )
            assert_equal(
                {device["id"] for device in b_devices},
                {devices_by_name["Runtime Client B Label Device"]["id"]},
                "label-only device isolation",
            )
        finally:
            b.close()

        set_audit_mode(http, root_token, entry_id, True)
        wait_until(
            lambda: http.request("GET", "/api/states", token=token_a)[0] == 200,
            "audit mode did not reload the REST guard",
        )
        set_audit_mode(http, root_token, entry_id, False)
        wait_until(
            lambda: http.request(
                "GET", "/api/states", token=token_a, expected=(403,)
            )[0]
            == 403,
            "audit mode did not restore enforced REST isolation",
        )

        http.request(
            "POST",
            f"/api/config/config_entries/entry/{entry_id}/reload",
            token=root_token,
        )
        wait_until(
            lambda: any(
                item["entry_id"] == entry_id and item["state"] == "loaded"
                for item in http.request(
                    "GET", "/api/config/config_entries/entry?domain=optim_energy", token=root_token
                )[1]
            ),
            "Optim Energy did not reload",
        )
        assert_tenant_rest(http, token_a)

        backup_after = harness.storage("optim_energy.migration_backup")["data"]
        assert_equal(
            backup_after["created_at"], backup_created, "migration backup idempotency"
        )
        tenancy_after = harness.storage("optim_energy.tenancy")["data"]
        assert_true(user_a["id"] in tenancy_after["users"], "tenant users were lost")
        assert_true(user_b["id"] in tenancy_after["users"], "tenant users were lost")

        # A second reload proves unload/setup can run repeatedly without
        # producing a new migration backup or dropping tenant state.
        http.request(
            "POST",
            f"/api/config/config_entries/entry/{entry_id}/reload",
            token=root_token,
        )
        wait_until(
            lambda: any(
                item["entry_id"] == entry_id and item["state"] == "loaded"
                for item in http.request(
                    "GET", "/api/config/config_entries/entry?domain=optim_energy", token=root_token
                )[1]
            ),
            "Optim Energy did not finish its second reload",
        )
        assert_equal(
            harness.storage("optim_energy.migration_backup")["data"]["created_at"],
            backup_created,
            "migration backup remained idempotent after a second reload",
        )
        assert_tenant_rest(http, token_a)
        success = True
        print(
            json.dumps(
                {
                    "ha_version": version,
                    "entry_id": entry_id,
                    "checks": "compile-and-runtime",
                    "status": "PASS",
                },
                indent=2,
            )
        )
    finally:
        if not success or keep:
            sys.stderr.write("\n--- Home Assistant runtime log ---\n")
            sys.stderr.write(harness.logs())
        harness.stop()
        harness.cleanup()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--ha-version",
        default=VERSION_FILE.read_text(encoding="utf-8").strip(),
        help="Exact ghcr.io/home-assistant/home-assistant image tag",
    )
    parser.add_argument("--keep", action="store_true", help="Keep the container and config")
    args = parser.parse_args()
    run(args.ha_version, keep=args.keep)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
