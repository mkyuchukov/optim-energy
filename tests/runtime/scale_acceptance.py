"""Three-client scale and lifecycle acceptance test for Optim Energy."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from acceptance import (
    OWNER_PASSWORD,
    OWNER_USERNAME,
    RuntimeHarness,
    assert_equal,
    assert_true,
    client_tree,
    complete_onboarding,
    create_config_entry,
    create_fixture_entry,
    ensure_location,
    ensure_client,
    ensure_user,
    free_port,
    read_policy_group,
    set_entity_area,
    wait_until,
)
from ha_client import Http, WebSocket, wait_ready, wait_server

VERSION_FILE = Path(__file__).with_name("HA_VERSION")
PASSWORD = "Scale-Test-2026!"
PORTAL_DASHBOARDS = {
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
}


def credentials(client: str, role: str, index: int) -> tuple[str, str]:
    return f"scale_{client}_{role}_{index}", PASSWORD


def login_ws(http: Http, username: str) -> tuple[WebSocket, str]:
    token = http.login(username, PASSWORD)["access_token"]
    ws = WebSocket(http.host, http.port)
    ws.auth(token)
    return ws, token


def registry_ids(ws: WebSocket, kind: str, key: str = "id") -> set[str]:
    return {
        str(item[key])
        for item in ws.command(
            {"type": "optim_energy/registry/list", "kind": kind}
        )
    }


def assert_role_scope(
    ws: WebSocket,
    *,
    expected_entities: set[str],
    expected_devices: set[str],
    expected_areas: set[str],
    expected_labels: set[str],
    foreign_entity: str,
) -> None:
    states = {
        state["entity_id"]
        for state in ws.command({"type": "get_states"})
        if state["entity_id"].startswith(("input_boolean.", "sensor.runtime_"))
    }
    assert_equal(states, expected_entities, "exact tenant state scope")
    registry = ws.command({"type": "config/entity_registry/list_for_display"})[
        "entities"
    ]
    assert_equal(
        {entry["entity_id"] for entry in registry},
        expected_entities,
        "tenant entity registry scope",
    )
    assert_equal(
        registry_ids(ws, "device"),
        expected_devices,
        "tenant device registry scope",
    )
    assert_equal(
        registry_ids(ws, "area", "area_id"),
        expected_areas,
        "tenant area registry scope",
    )
    assert_equal(
        registry_ids(ws, "label", "label_id"),
        expected_labels,
        "tenant label registry scope",
    )
    for command in (
        {
            "type": "history/history_during_period",
            "start_time": "2026-11-11T00:00:00+00:00",
            "entity_ids": [foreign_entity],
            "minimal_response": True,
        },
        {
            "type": "recorder/statistics_during_period",
            "start_time": "2026-11-11T00:00:00+00:00",
            "statistic_ids": [foreign_entity],
            "period": "hour",
            "types": ["mean"],
        },
    ):
        try:
            ws.command(command)
        except RuntimeError:
            pass
        else:
            raise AssertionError(f"foreign {command['type']} was allowed")


def assert_dashboards(ws: WebSocket, *, include_admin: bool = False) -> None:
    for url_path in PORTAL_DASHBOARDS:
        if url_path == "energy-admin" and not include_admin:
            continue
        config = ws.command({"type": "lovelace/config", "url_path": url_path})
        assert_true(isinstance(config, dict), f"dashboard {url_path} did not load")
    home = ws.command({"type": "lovelace/config", "url_path": "energy-home"})
    assert_equal(
        {view.get("path") for view in home.get("views", [])},
        {"home", "help"},
        "Overview and Help pages",
    )


def policy_snapshot(harness: RuntimeHarness) -> str:
    groups = harness.storage("auth")["data"]["groups"]
    groups = groups.values() if isinstance(groups, dict) else groups
    payload = {
        group["id"]: group.get("policy")
        for group in groups
        if str(group.get("id", "")).startswith("optim_energy_user_")
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def run(version: str, *, keep: bool = False) -> None:
    port = free_port()
    harness = RuntimeHarness(version, port, keep=keep, profile="scale")
    http = Http(f"http://127.0.0.1:{port}")
    success = False
    tenant_sessions: list[tuple[dict[str, Any], WebSocket, str]] = []
    root: WebSocket | None = None
    try:
        harness.start()
        root_token = complete_onboarding(http)
        entry_id = create_config_entry(http, root_token)
        fixture_entry_id = create_fixture_entry(http, root_token)
        root = WebSocket(http.host, http.port)
        root.auth(root_token)
        root.command({"type": "optim_runtime_fixture/install_late_command"})
        assert_equal(
            root.command({"type": "optim_runtime_fixture/late_probe"}),
            {"late": True},
            "late-registered fixture command",
        )
        assert_dashboards(root, include_admin=True)

        client_a, _ = ensure_client(root, "Scale Client A")
        client_b, _ = ensure_client(root, "Scale Client B")
        client_c, _ = ensure_client(root, "Scale Client C")
        root.command({"type": "optim_energy/client/delete", "client": "default"})
        client_of = {"a_north": client_a, "a_south": client_a, "a_west": client_a, "b": client_b, "c": client_c}
        location_ids: dict[str, str] = {}
        areas: dict[str, str] = {}
        for scope, name in (("a_north", "Scale A North"), ("a_south", "Scale A South"), ("a_west", "Scale A West"), ("b", "Scale B"), ("c", "Scale C")):
            location_ids[scope], areas[scope] = ensure_location(root, client_of[scope], name)

        entity_scopes: dict[str, set[str]] = {
            "a_north": set(),
            "a_south": set(),
            "a_west": set(),
            "b": set(),
            "c": set(),
        }
        for index in range(120):
            if index < 40:
                scope, area_id = "a_north", areas["a_north"]
            elif index < 80:
                scope, area_id = "a_south", areas["a_south"]
            else:
                scope, area_id = "a_west", areas["a_west"]
            entity_id = f"input_boolean.runtime_a_{index:03d}"
            set_entity_area(root, entity_id, area_id)
            entity_scopes[scope].add(entity_id)
        for client in ("b", "c"):
            for index in range(120):
                entity_id = f"input_boolean.runtime_{client}_{index:03d}"
                set_entity_area(root, entity_id, areas[client])
                entity_scopes[client].add(entity_id)
        for client, scope in (("a", "a_north"), ("b", "b"), ("c", "c")):
            sensor = f"sensor.runtime_{client}_energy"
            set_entity_area(root, sensor, areas[scope])
            entity_scopes[scope].add(sensor)

        fixture = root.command(
            {
                "type": "optim_runtime_fixture/create_devices",
                "config_entry_id": fixture_entry_id,
                "devices": [
                    {"key": "a_area", "name": "Scale A Area Device", "area_id": areas["a_north"]},
                    {"key": "a_second", "name": "Scale A Second Device", "area_id": areas["a_north"]},
                    {"key": "b_area", "name": "Scale B Area Device", "area_id": areas["b"]},
                    {"key": "b_second", "name": "Scale B Second Device", "area_id": areas["b"]},
                    {"key": "c_area", "name": "Scale C Area Device", "area_id": areas["c"]},
                    {"key": "c_second", "name": "Scale C Second Device", "area_id": areas["c"]},
                ],
            }
        )
        device_ids = {item["name"]: item["id"] for item in fixture}

        def save_trees() -> None:
            # Saving a tree queues the permission sync, as any change does.
            for client_id in (client_a, client_b, client_c):
                root.command({"type": "optim_energy/tree/save", "client": client_id, "tree": client_tree(root, client_id)})

        sync_started = time.monotonic()
        for _ in range(3):
            save_trees()
        sync_seconds = round(time.monotonic() - sync_started, 3)
        time.sleep(5)  # longer than the debounced permission sync
        baseline_policy = wait_until(
            lambda: (
                snapshot
                if "input_boolean.runtime_a_000" in (snapshot := policy_snapshot(harness))
                else None
            ),
            "initial scale policies were not persisted",
        )
        save_trees()
        time.sleep(5)
        assert_equal(
            policy_snapshot(harness),
            baseline_policy,
            "permission synchronization is idempotent",
        )

        user_specs: list[dict[str, Any]] = []
        for index in (1, 2):
            username, _ = credentials("a", "admin", index)
            user_specs.append(
                {
                    "client": client_a,
                    "scope": "a_north",
                    "username": username,
                    "role": "client_admin",
                    "location": None,
                }
            )
        for index, scope in enumerate(("a_north", "a_south", "a_west", "a_north"), 1):
            username, _ = credentials("a", "user", index)
            user_specs.append(
                {
                    "client": client_a,
                    "scope": scope,
                    "username": username,
                    "role": "user",
                    "location": location_ids[scope],
                }
            )
        for client in ("b", "c"):
            client_id = client_b if client == "b" else client_c
            username, _ = credentials(client, "admin", 1)
            user_specs.append(
                {
                    "client": client_id,
                    "scope": client,
                    "username": username,
                    "role": "client_admin",
                    "location": None,
                }
            )
            for index in (1, 2):
                username, _ = credentials(client, "user", index)
                user_specs.append(
                    {
                        "client": client_id,
                        "scope": client,
                        "username": username,
                        "role": "user",
                        "location": location_ids[client],
                    }
                )

        users = []
        for spec in user_specs:
            users.append(
                ensure_user(
                    root,
                    client_id=spec["client"],
                    name=spec["username"].replace("_", " ").title(),
                    username=spec["username"],
                    password=PASSWORD,
                    role=spec["role"],
                    location=spec["location"],
                )
            )
        assert_equal(len(users), 12, "multiple users and administrators created")

        for spec in user_specs:
            ws, token = login_ws(http, spec["username"])
            tenant_sessions.append((spec, ws, token))
            assert_dashboards(ws)

        for spec, ws, _token in tenant_sessions:
            client_key = {
                client_a: "A",
                client_b: "B",
                client_c: "C",
            }[spec["client"]]
            if spec["client"] == client_a and spec["role"] == "client_admin":
                expected_entities = set().union(
                    entity_scopes["a_north"],
                    entity_scopes["a_south"],
                    entity_scopes["a_west"],
                )
                expected_devices = {
                    device_ids["Scale A Area Device"],
                    device_ids["Scale A Second Device"],
                }
                expected_areas = {areas["a_north"], areas["a_south"], areas["a_west"]}
            else:
                scope = spec["scope"]
                expected_entities = entity_scopes[scope]
                expected_areas = {areas[scope]}
                if spec["client"] == client_a and scope != "a_north":
                    expected_devices = set()
                else:
                    prefix = client_key
                    expected_devices = {
                        device_ids[f"Scale {prefix} Area Device"],
                        device_ids[f"Scale {prefix} Second Device"],
                    }
            assert_role_scope(
                ws,
                expected_entities=expected_entities,
                expected_devices=expected_devices,
                expected_areas=expected_areas,
                expected_labels=set(),  # no type labels in this suite, and a location is not a label
                foreign_entity="input_boolean.runtime_c_000"
                if spec["client"] != client_c
                else "input_boolean.runtime_a_000",
            )
            device_names = {
                item["name"]
                for item in ws.command(
                    {"type": "optim_energy/registry/list", "kind": "device"}
                )
            }
            forbidden = (
                ("Scale B", "Scale C")
                if spec["client"] == client_a
                else ("Scale A", "Scale C")
                if spec["client"] == client_b
                else ("Scale A", "Scale B")
            )
            assert_true(
                not any(name.startswith(forbidden) for name in device_names),
                "foreign device name leaked",
            )

        temp_username, _ = credentials("a", "temp", 1)
        temp_user = ensure_user(
            root,
            client_id=client_a,
            name="Scale Temporary User",
            username=temp_username,
            password=PASSWORD,
            role="user",
            location=location_ids["a_north"],
        )
        temp_ws, temp_token = login_ws(http, temp_username)
        temp_ws.close()
        root.command(
            {"type": "optim_energy/user/update", "user_id": temp_user["id"], "is_active": False}
        )
        assert_equal(
            http.request("GET", "/api/", token=temp_token, expected=(401,))[0],
            401,
            "disabled user retained REST access",
        )
        root.command(
            {"type": "optim_energy/user/update", "user_id": temp_user["id"], "is_active": True}
        )
        temp_ws, temp_token = login_ws(http, temp_username)
        temp_ws.close()
        root.command({"type": "optim_energy/user/delete", "user_id": temp_user["id"]})
        assert_equal(
            http.request("GET", "/api/", token=temp_token, expected=(401,))[0],
            401,
            "deleted user retained REST access",
        )
        try:
            http.login(temp_username, PASSWORD)
        except AssertionError:
            pass
        else:
            raise AssertionError("deleted user could still log in")

        moved = sorted(entity_scopes["a_west"])[:20]
        for entity_id in moved:
            root.command(
                {
                    "type": "config/entity_registry/update",
                    "entity_id": entity_id,
                    "area_id": areas["a_south"],
                }
            )
            entity_scopes["a_west"].remove(entity_id)
            entity_scopes["a_south"].add(entity_id)
        for _spec, ws, _token in tenant_sessions:
            try:
                ws.close()
            except Exception:
                pass
        tenant_sessions.clear()
        if root is not None:
            root.close()
        harness.restart()
        wait_server(http, timeout=180)
        root = WebSocket(http.host, http.port)
        root.auth(http.login(OWNER_USERNAME, OWNER_PASSWORD)["access_token"])

        south_user = next(
            spec["username"]
            for spec in user_specs
            if spec["client"] == client_a and spec["scope"] == "a_south"
        )

        def south_after_restart() -> bool:
            ws, _ = login_ws(http, south_user)
            try:
                states = {
                    state["entity_id"]
                    for state in ws.command({"type": "get_states"})
                    if state["entity_id"].startswith("input_boolean.")
                }
                return states == entity_scopes["a_south"]
            finally:
                ws.close()

        wait_until(south_after_restart, "restart did not repair the queued permission sync")
        south_ws, _ = login_ws(http, south_user)
        try:
            assert_dashboards(south_ws)
        finally:
            south_ws.close()

        # A location moves to another client once nobody is assigned to it; its old client loses it at once.
        for spec, user in zip(user_specs, users):
            if spec["client"] == client_b and spec["role"] == "user":
                root.command({"type": "optim_energy/user/delete", "user_id": user["id"]})
        root.command({"type": "optim_energy/location/move", "client": client_b, "location": location_ids["b"], "target": client_c})
        time.sleep(5)
        b_admin_spec = next(
            spec for spec in user_specs if spec["username"].startswith("scale_b_admin")
        )
        b_admin_ws, _ = login_ws(http, b_admin_spec["username"])
        try:
            b_input_states = {
                state["entity_id"]
                for state in b_admin_ws.command({"type": "get_states"})
                if state["entity_id"].startswith("input_boolean.")
            }
            assert_equal(b_input_states, set(), "a moved location revoked access")
        finally:
            b_admin_ws.close()
        b_admin_token = http.login(b_admin_spec["username"], PASSWORD)["access_token"]
        root.command(
            {
                "type": "optim_energy/client/delete",
                "client": client_b,
                "delete_users": True,
            }
        )
        assert_equal(
            http.request("GET", "/api/", token=b_admin_token, expected=(401,))[0],
            401,
            "deleted client administrator retained access",
        )
        client_ids = {item["id"] for item in root.command({"type": "optim_energy/client/list"})}
        assert_equal(client_ids, {client_a, client_c}, "client deletion cleanup")

        # Rehearse a cold operational restore: back up the auth, tenant and
        # Lovelace stores, make a disposable change, then restore and restart.
        harness.backup_config()
        restore_probe = root.command(
            {"type": "optim_energy/client/create", "name": "Restore Probe"}
        )
        assert_true(restore_probe["id"] not in client_ids, "restore probe was not created")
        root.close()
        root = None
        harness.stop_container()
        harness.restore_config()
        harness.start_container()
        wait_server(http, timeout=180)
        root = WebSocket(http.host, http.port)
        root.auth(http.login(OWNER_USERNAME, OWNER_PASSWORD)["access_token"])
        restored_client_list = wait_until(
            lambda: (
                root.command({"type": "optim_energy/client/list"})
                if root is not None
                else None
            ),
            "Optim Energy did not resume after cold restore",
        )
        restored_clients = {item["id"] for item in restored_client_list}
        assert_equal(
            restored_clients,
            {client_a, client_c},
            "cold restore removed the probe client",
        )

        store_sizes = {
            "tenancy_bytes": harness.file_size("/config/.storage/optim_energy.tenancy"),
            "auth_bytes": harness.file_size("/config/.storage/auth"),
        }
        root.command({"type": "config/auth/list"})
        print(
            json.dumps(
                {
                    "ha_version": version,
                    "profile": "3 clients / 360 entities / 12 users",
                    "entry_id": entry_id,
                    "sync_seconds": sync_seconds,
                    "store_sizes": store_sizes,
                    "restore_rehearsal": "PASS",
                    "status": "PASS",
                },
                indent=2,
            )
        )
        success = True
    finally:
        if not success or keep:
            sys.stderr.write("\n--- Home Assistant runtime log ---\n")
            sys.stderr.write(harness.logs())
        for _spec, ws, _token in tenant_sessions:
            try:
                ws.close()
            except Exception:
                pass
        if root is not None:
            try:
                root.close()
            except Exception:
                pass
        harness.stop()
        harness.cleanup()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--ha-version",
        default=VERSION_FILE.read_text(encoding="utf-8").strip(),
    )
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    run(args.ha_version, keep=args.keep)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
