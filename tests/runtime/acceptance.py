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
# Registry-only sensors the fixture hangs on each client's device.
A_DEVICE_SENSOR = "sensor.client_a_area_device_power"
B_DEVICE_SENSOR = "sensor.client_b_area_device_power"
MARKET_SENSOR = "sensor.exchange_market_price"



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
            "for f in auth optim_energy.tenancy; do "
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


def ensure_location(root: WebSocket, client_id: str, name: str) -> tuple[str, str]:
    """Create a location in a client; return its id and its Home Assistant area."""
    location = root.command({"type": "optim_energy/location/save", "client": client_id, "name": name})["id"]
    place = next(p for p in client_tree(root, client_id)["places"] if p["id"] == location)
    return str(location), str(place["area_id"])


def set_entity_area(root: WebSocket, entity_id: str, area_id: str) -> None:
    root.command({"type": "config/entity_registry/update", "entity_id": entity_id, "area_id": area_id})


def ensure_client(root: WebSocket, name: str) -> tuple[str, str]:
    for client in root.command({"type": "optim_energy/client/list"}):
        if client["name"] == name:
            return str(client["id"]), str(client["slug"])
    created = root.command({"type": "optim_energy/client/create", "name": name})
    return str(created["id"]), str(created["slug"])


def client_tree(root: WebSocket, client_id: str) -> dict[str, Any]:
    return root.command({"type": "optim_energy/tree/get", "client": client_id})["tree"]


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
        # The market price is shared by every tenant; it is checked on its own further down.
        registry_ids = {entry["entity_id"] for entry in registry} - {MARKET_SENSOR}
        assert_equal(
            registry_ids,
            expected_entities | {A_DEVICE_SENSOR},
            "tenant-filtered entity registry",
        )
        devices = tenant.command(
            {"type": "optim_energy/registry/list", "kind": "device"}
        )
        assert_equal(
            {device["id"] for device in devices if device["name"] != "Runtime Exchange"},
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
        entry_id = create_config_entry(http, root_token)
        fixture_entry_id = create_fixture_entry(http, root_token)
        wait_until(
            lambda: "Optim Energy websocket firewall active"
            in harness.logs()
            and "Optim Energy REST guard active" in harness.logs(),
            "runtime guards did not report activation",
        )
        root = WebSocket(http.host, http.port)
        root.auth(root_token)
        root.command({"type": "optim_runtime_fixture/install_late_command"})
        assert_equal(
            root.command({"type": "optim_runtime_fixture/late_probe"}),
            {"late": True},
            "late-registered fixture command",
        )
        dashboards = root.command({"type": "lovelace/dashboards/list"})
        assert_equal(
            {item["url_path"] for item in dashboards}
            & {
                "energy-start",
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
                "energy-start",
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

        client_a, _ = ensure_client(root, "Runtime Client A")
        client_b, _ = ensure_client(root, "Runtime Client B")
        location_a, area_a = ensure_location(root, client_a, "Runtime Site A")
        location_b, area_b = ensure_location(root, client_b, "Runtime Site B")
        set_entity_area(root, "input_boolean.runtime_a_toggle", area_a)
        set_entity_area(root, "input_boolean.runtime_b_toggle", area_b)
        fixture_devices = root.command(
            {
                "type": "optim_runtime_fixture/create_devices",
                "config_entry_id": fixture_entry_id,
                "devices": [
                    {"key": "client_a_area_device", "name": "Runtime Client A Area Device", "area_id": area_a, "entity": True},
                    {"key": "client_b_area_device", "name": "Runtime Client B Area Device", "area_id": area_b, "entity": True},
                ],
            }
        )
        devices_by_name = {device["name"]: device for device in fixture_devices}
        a_device = devices_by_name["Runtime Client A Area Device"]["id"]
        b_device = devices_by_name["Runtime Client B Area Device"]["id"]
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
        # Any saved change re-runs the permission sync, which is what catches a new account.
        root.command({"type": "optim_energy/tree/save", "client": client_a, "tree": client_tree(root, client_a)})

        def unassigned_user() -> dict[str, Any] | None:
            found = next(user for user in root.command({"type": "config/auth/list"}) if user["id"] == unassigned["id"])
            groups = found["group_ids"]
            return found if groups and all(group.startswith("optim_energy_user_") for group in groups) else None

        unassigned_now = wait_until(unassigned_user, "unassigned user retained a system group", timeout=20)
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
            expected_devices={a_device},
            expected_areas={area_a},
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
                {b_device},
                "Client B device isolation",
            )
        finally:
            b.close()

        # A client administrator sends a tree that claims Client B's device,
        # area and entity. Only its own price may land; nothing of B's opens.
        admin_a = WebSocket(http.host, http.port)
        try:
            admin_a.auth(http.login(*CLIENT_ADMIN_A)["access_token"])
            hostile = admin_a.command({"type": "optim_energy/tree/get"})["tree"]
            hostile["placed"] = {b_device: location_a}
            hostile["places"] = [*hostile["places"], {"id": "loc:stolen", "name": "Stolen", "kind": "location", "parent": None, "area_id": area_b}]
            hostile["virtual"] = [{"id": "virt:x", "name": "X"}]
            hostile["sums"] = {"virt:x": {"energy": {"entry": entry_id, "entity": "input_boolean.runtime_b_toggle"}}}
            hostile["automations"] = [{"entity": "automation.anything", "place": location_a}]
            hostile["prices"] = {location_a: {"mode": "fixed", "fixed": 0.31}}
            admin_a.command({"type": "optim_energy/tree/save", "tree": hostile})
            time.sleep(4)  # longer than the debounced permission sync
            saved = admin_a.command({"type": "optim_energy/tree/get"})["tree"]
            assert_equal(saved["prices"], {location_a: {"mode": "fixed", "fixed": 0.31}}, "client admin price save")
            assert_true(b_device not in (saved.get("placed") or {}), "foreign device was accepted into the tree")
            assert_true(not saved.get("sums") and not saved.get("virtual"), "foreign Sum was accepted into the tree")
            assert_true(
                "loc:stolen" not in {place["id"] for place in saved["places"]},
                "foreign area was accepted as a location",
            )
            assert_true(
                "input_boolean.runtime_b_toggle"
                not in {state["entity_id"] for state in admin_a.command({"type": "get_states"})},
                "hostile tree opened Client B's entity",
            )
            for refused in (
                {"type": "optim_energy/helper/sum/delete", "virtual_id": "virt:x", "kind": "energy"},
                {"type": "optim_energy/tree/save", "tree": {"prices": {location_b: {"mode": "fixed", "fixed": 1}}}},
            ):
                try:
                    admin_a.command(refused)
                except RuntimeError:
                    continue
                raise AssertionError(f"{refused['type']} was not refused")
        finally:
            admin_a.close()
        assert_true(
            any(entry["entry_id"] == entry_id for entry in root.command({"type": "config_entries/get"})),
            "a client administrator removed a config entry",
        )

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

        tenancy_after = harness.storage("optim_energy.tenancy")["data"]
        assert_true(user_a["id"] in tenancy_after["users"], "tenant users were lost")
        assert_true(user_b["id"] in tenancy_after["users"], "tenant users were lost")

        # A second reload proves unload/setup can run repeatedly.
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
        assert_tenant_rest(http, token_a)

        # ---- Locations, groups and devices ----------------------------------

        def refused(ws: WebSocket, command: dict[str, Any], what: str) -> None:
            try:
                ws.command(command)
            except RuntimeError:
                return
            raise AssertionError(f"{what} was not refused")

        def place_ids(tree: dict[str, Any], kind: str) -> dict[str, dict[str, Any]]:
            return {p["id"]: p for p in tree["places"] if p["kind"] == kind}

        root = WebSocket(http.host, http.port)
        admin_a = WebSocket(http.host, http.port)
        try:
            root.auth(root_token)
            def root_client_entities(client: str) -> set[str]:
                listed = root.command({"type": "optim_energy/registry/list", "kind": "entity", "client": client})
                return {entry["entity_id"] for entry in listed}

            scoped_a = {"input_boolean.runtime_a_toggle", A_DEVICE_SENSOR}
            scoped_b = {"input_boolean.runtime_b_toggle", B_DEVICE_SENSOR}
            assert_equal(root_client_entities(client_a), scoped_a, "root's view of client A")
            assert_equal(root_client_entities(client_b), scoped_b, "root's view of client B")
            assert_tenant_ws(
                http,
                token_a,
                expected_entities={"input_boolean.runtime_a_toggle"},
                expected_devices={a_device},
                expected_areas={area_a},
            )
            b = WebSocket(http.host, http.port)
            try:
                b.auth(token_b)
                assert_equal(
                    {s["entity_id"] for s in b.command({"type": "get_states"}) if s["entity_id"].startswith("input_boolean.")},
                    {"input_boolean.runtime_b_toggle"},
                    "Client B state isolation, again",
                )
                assert_equal(
                    {d["id"] for d in b.command({"type": "optim_energy/registry/list", "kind": "device"})},
                    {b_device},
                    "Client B devices, again",
                )
                # Root moves B's device to A: B loses it at once, A gains it.
                root.command({"type": "optim_energy/device/assign", "client": client_a, "device_id": b_device, "place": location_a})
                assert_equal(
                    b.command({"type": "optim_energy/registry/list", "kind": "device"}), [], "B kept a device that moved to A"
                )
                assert_equal(
                    client_tree(root, client_a)["placed"].get(b_device), location_a, "moved device is not in A"
                )
                root.command({"type": "optim_energy/device/assign", "client": client_b, "device_id": b_device, "place": location_b})
                assert_equal(
                    {d["id"] for d in b.command({"type": "optim_energy/registry/list", "kind": "device"})},
                    {b_device},
                    "device did not return to B",
                )
            finally:
                b.close()

            # A client administrator organises its own devices and nothing else.
            admin_a.auth(http.login(*CLIENT_ADMIN_A)["access_token"])
            group = admin_a.command({"type": "optim_energy/group/save", "name": "Lab", "parent": location_a})["id"]
            admin_a.command({"type": "optim_energy/device/assign", "device_id": a_device, "place": group})
            assert_equal(admin_a.command({"type": "optim_energy/tree/get"})["tree"]["placed"].get(a_device), group, "client admin group move")
            refused(admin_a, {"type": "optim_energy/device/assign", "device_id": b_device, "place": location_a}, "taking another client's device")
            refused(admin_a, {"type": "optim_energy/device/assign", "device_id": a_device, "place": location_b}, "moving a device into another client")
            refused(admin_a, {"type": "optim_energy/device/assign", "device_id": a_device}, "unassigning a device as a client admin")
            refused(admin_a, {"type": "optim_energy/group/save", "name": "Sneaky", "parent": location_b}, "a group in another client")
            refused(admin_a, {"type": "optim_energy/location/save", "name": "Mine"}, "a client admin creating a location")
            # A client administrator can give its own user a new password, not another client's user.
            new_password = "Runtime-Reset-2026!"
            refused(admin_a, {"type": "optim_energy/user/update", "user_id": user_b["id"], "password": new_password}, "resetting another client's password")
            refused(admin_a, {"type": "optim_energy/user/update", "user_id": user_a["id"], "password": "short"}, "a too-short password")
            admin_a.command({"type": "optim_energy/user/update", "user_id": user_a["id"], "password": new_password})
            assert_true(http.login(CLIENT_A_USER[0], new_password)["access_token"], "the new password does not log in")
            try:
                http.login(*CLIENT_A_USER)
            except Exception:
                pass
            else:
                raise AssertionError("the old password still logs in")
            admin_a.command({"type": "optim_energy/user/update", "user_id": user_a["id"], "password": CLIENT_A_USER[1]})
            # A group moves to another location of the tenant and takes its device, and that device's area, along.
            other, other_area = ensure_location(root, client_a, "Runtime Site A2")
            admin_a.command({"type": "optim_energy/group/save", "group": group, "name": "Lab", "parent": other})
            moved_tree = admin_a.command({"type": "optim_energy/tree/get"})["tree"]
            assert_equal(moved_tree["placed"].get(a_device), group, "the device left its group when the group moved")
            assert_equal(
                next(d["area_id"] for d in root.command({"type": "config/device_registry/list"}) if d["id"] == a_device),
                other_area,
                "the device did not follow its group to the new location",
            )
            refused(admin_a, {"type": "optim_energy/group/save", "group": group, "name": "Lab", "parent": location_b}, "moving a group into another tenant")
            admin_a.command({"type": "optim_energy/group/save", "group": group, "name": "Lab", "parent": location_a})
            root.command({"type": "optim_energy/location/delete", "client": client_a, "location": other})
            admin_a.command({"type": "optim_energy/group/delete", "group": group})
            assert_equal(admin_a.command({"type": "optim_energy/tree/get"})["tree"]["placed"].get(a_device), location_a, "device left a deleted group")

            # A location has one name: its area's. Home Assistant needs distinct area names, so a
            # second location with a taken name is refused, and a rename on either side shows on the other.
            area_of = lambda client, loc: place_ids(client_tree(root, client), "location")[loc]
            area_names = lambda: {a["area_id"]: a["name"] for a in root.command({"type": "config/area_registry/list"})}
            office = root.command({"type": "optim_energy/location/save", "client": client_a, "name": "Head Office"})["id"]
            office_area = area_of(client_a, office)["area_id"]
            assert_equal(area_names()[office_area], "Head Office", "area name of a new location")
            refused(root, {"type": "optim_energy/location/save", "client": client_b, "name": "Head Office"}, "a second location with a taken name")
            refused(root, {"type": "optim_energy/location/save", "client": client_a, "location": location_a, "name": "Head Office"}, "renaming a location to a taken name")
            root.command({"type": "optim_energy/location/save", "client": client_a, "location": office, "name": "Branch"})
            assert_equal(area_names()[office_area], "Branch", "a rename in the portal did not rename the area")
            root.command({"type": "config/area_registry/update", "area_id": office_area, "name": "Depot"})
            assert_equal(area_of(client_a, office)["name"], "Depot", "a rename in Home Assistant did not rename the location")
            root.command({"type": "optim_energy/location/delete", "client": client_a, "location": office})

            # Root adds and removes a location; a location in use cannot go.
            annex = root.command({"type": "optim_energy/location/save", "client": client_a, "name": "Annex"})["id"]
            assert_true(place_ids(client_tree(root, client_a), "location")[annex]["area_id"], "new location has no area")
            root.command({"type": "optim_energy/location/delete", "client": client_a, "location": annex})
            refused(root, {"type": "optim_energy/location/delete", "client": client_a, "location": location_a}, "deleting a location in use")

            # A whole location changes client, with its group, device and price.
            refused(root, {"type": "optim_energy/location/move", "client": client_a, "location": location_a, "target": client_b}, "moving a location people are assigned to")
            wing = root.command({"type": "optim_energy/location/save", "client": client_a, "name": "Wing"})["id"]
            wing_room = root.command({"type": "optim_energy/group/save", "client": client_a, "name": "Wing Room", "parent": wing})["id"]
            root.command({"type": "optim_energy/device/assign", "client": client_a, "device_id": a_device, "place": wing_room})
            with_price = client_tree(root, client_a)
            with_price["prices"] = {**with_price.get("prices", {}), wing: {"mode": "fixed", "fixed": 0.4}}
            root.command({"type": "optim_energy/tree/save", "client": client_a, "tree": with_price})
            refused(admin_a, {"type": "optim_energy/location/move", "location": wing, "target": client_b}, "a client admin moving a location")
            root.command({"type": "optim_energy/location/move", "client": client_a, "location": wing, "target": client_b})
            tree_a, tree_b = client_tree(root, client_a), client_tree(root, client_b)
            assert_true(wing not in place_ids(tree_a, "location") and wing_room not in place_ids(tree_a, "group"), "the moved location is still in the old client")
            assert_true(wing in place_ids(tree_b, "location") and wing_room in place_ids(tree_b, "group"), "the moved location did not arrive")
            assert_equal(tree_b["placed"].get(a_device), wing_room, "the device did not keep its group")
            assert_equal(tree_b["prices"].get(wing), {"mode": "fixed", "fixed": 0.4}, "the price did not move with the location")
            assert_true(wing not in tree_a.get("prices", {}) and a_device not in tree_a["placed"], "the old client kept settings of the moved location")
            assert_equal(root_client_entities(client_a), {"input_boolean.runtime_a_toggle"}, "the old client still sees the moved device")
            assert_true(A_DEVICE_SENSOR in root_client_entities(client_b), "the new client does not see the moved device")
            # Put things back for the checks that follow.
            root.command({"type": "optim_energy/device/assign", "client": client_a, "device_id": a_device, "place": location_a})
            root.command({"type": "optim_energy/location/delete", "client": client_b, "location": wing})

            # The inbox: every device, where it is, and why it was recognised.
            spare = root.command(
                {
                    "type": "optim_runtime_fixture/create_devices",
                    "config_entry_id": fixture_entry_id,
                    "devices": [{"key": "spare_device", "name": "Runtime Spare Device", "entity": True}],
                }
            )[0]["id"]

            def inbox() -> dict[str, dict[str, Any]]:
                return {d["id"]: d for d in root.command({"type": "optim_energy/device/inbox"})}

            seen = inbox()
            assert_equal((seen[a_device]["status"], seen[a_device]["client"], seen[a_device]["location"]), ("assigned", client_a, location_a), "inbox row of A's device")
            assert_equal((seen[b_device]["status"], seen[b_device]["client"]), ("assigned", client_b), "inbox row of B's device")
            assert_equal((seen[spare]["status"], seen[spare]["kind"]), ("unassigned", "meter"), "a new device is an unassigned candidate")
            assert_true("sensor.spare_device_power" in seen[spare]["why"], "the inbox does not say why the device was recognised")
            assert_true(seen[spare]["integrations"] == ["optim_runtime_fixture"], "the inbox does not name the integration")
            assert_equal(seen[spare]["labels"], [], "labels of a device that has none")
            refused(admin_a, {"type": "optim_energy/device/inbox"}, "a client admin reading the inbox")
            refused(admin_a, {"type": "optim_energy/device/assign", "device_id": spare, "place": location_a}, "a client admin claiming an unassigned device")
            root.command({"type": "optim_energy/device/ignore", "device_id": spare, "ignored": True})
            assert_equal(inbox()[spare]["status"], "ignored", "ignored device")
            refused(root, {"type": "optim_energy/device/ignore", "device_id": a_device, "ignored": True}, "ignoring an assigned device")
            root.command({"type": "optim_energy/device/ignore", "device_id": spare, "ignored": False})
            root.command({"type": "optim_energy/device/assign", "client": client_a, "device_id": spare, "place": location_a})
            assert_equal(inbox()[spare]["status"], "assigned", "assigned from the inbox")
            root.command({"type": "optim_energy/device/assign", "client": client_a, "device_id": spare})
            assert_equal(inbox()[spare]["status"], "unassigned", "removed from the client")

            # A meter reports each phase as a device of its own. Such a channel has to sit in its
            # meter's area, or the tenant's users see the meter without any of its readings.
            made = root.command(
                {
                    "type": "optim_runtime_fixture/create_devices",
                    "config_entry_id": fixture_entry_id,
                    "devices": [
                        {"key": "phase_meter", "name": "Runtime Phase Meter", "model": "Three Phase", "area_id": area_a},
                        {"key": "phase_meter_a", "name": "Runtime Phase Meter Phase A", "model": "Three Phase", "via": "phase_meter", "meter": True},
                        # Same parent, another model: a device of its own, as a Zigbee plug under its bridge is.
                        {"key": "phase_guest", "name": "Runtime Guest Device", "model": "Something Else", "via": "phase_meter", "entity": True},
                    ],
                }
            )
            meter, channel, guest = (item["id"] for item in made)

            def area_of_device(device_id: str) -> str | None:
                return next(d["area_id"] for d in root.command({"type": "config/device_registry/list"}) if d["id"] == device_id)

            def user_a_reads(entity_id: str) -> bool:
                ws = WebSocket(http.host, http.port)
                try:
                    ws.auth(http.login(*CLIENT_A_USER)["access_token"])
                    return entity_id in {e["entity_id"] for e in ws.command({"type": "optim_energy/registry/list", "kind": "entity"})}
                finally:
                    ws.close()

            # The exchange price belongs to no location, and every tenant's price is worked out from it.
            root.command(
                {
                    "type": "optim_runtime_fixture/create_devices",
                    "config_entry_id": fixture_entry_id,
                    "devices": [{"key": "exchange", "name": "Runtime Exchange", "market": True}],
                }
            )
            wait_until(lambda: user_a_reads("sensor.exchange_market_price"), "a tenant's user cannot read the market price", timeout=20)
            wait_until(lambda: area_of_device(channel) == area_a, "a channel device did not follow its meter into the location", timeout=20)
            assert_equal(area_of_device(guest), None, "a device of another model was pulled along with its parent")
            wait_until(lambda: user_a_reads("sensor.phase_meter_a_power"), "the tenant's user cannot read a channel of their own meter", timeout=20)
            # Taken out of its area by hand, the channel is put back.
            root.command({"type": "config/device_registry/update", "device_id": channel, "area_id": None})
            wait_until(lambda: area_of_device(channel) == area_a, "a channel that lost its area was not put back", timeout=20)
            # The meter leaves the tenant: its channel goes with it, and the user stops reading it.
            root.command({"type": "optim_energy/device/assign", "client": client_a, "device_id": meter})
            assert_equal(area_of_device(channel), None, "a channel stayed in the location its meter left")
            wait_until(lambda: not user_a_reads("sensor.phase_meter_a_power"), "the user still reads a channel whose meter left", timeout=20)

            # A device still counted in a client's sum cannot leave that client.
            with_sum = client_tree(root, client_a)
            with_sum["virtual"] = [{"id": "virt:total", "name": "Runtime Total"}]
            with_sum["sums"] = {"virt:total": {"energy": {"entry": "none", "entity": "sensor.none", "members": [A_DEVICE_SENSOR]}}}
            root.command({"type": "optim_energy/tree/save", "client": client_a, "tree": with_sum})
            try:
                root.command({"type": "optim_energy/device/assign", "client": client_b, "device_id": a_device, "place": location_b})
            except RuntimeError as err:
                assert_true("Runtime Total" in str(err), f"the refusal does not name what to fix: {err}")
            else:
                raise AssertionError("a device left its client while a sum still counted it")
            with_sum["virtual"], with_sum["sums"] = [], {}
            root.command({"type": "optim_energy/tree/save", "client": client_a, "tree": with_sum})
            root.command({"type": "optim_energy/device/assign", "client": client_b, "device_id": a_device, "place": location_b})
            root.command({"type": "optim_energy/device/assign", "client": client_a, "device_id": a_device, "place": location_a})
        finally:
            admin_a.close()
            root.close()

        # Everything survives a restart.
        harness.restart()

        def login_a() -> str | None:
            try:
                return str(http.login(*CLIENT_A_USER)["access_token"])
            except Exception:
                return None

        token_after = wait_until(login_a, "Home Assistant did not come back after the restart", timeout=180)
        time.sleep(6)  # let the integration finish loading and sync permissions
        assert_tenant_ws(
            http,
            token_after,
            expected_entities={"input_boolean.runtime_a_toggle"},
            expected_devices={a_device},
            expected_areas={area_a},
        )
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
