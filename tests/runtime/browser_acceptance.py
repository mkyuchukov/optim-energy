"""Browser acceptance for client-admin portal flows and the client switch race."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from acceptance import (
    CLIENT_ADMIN_A,
    RuntimeHarness,
    client_tree,
    complete_onboarding,
    create_config_entry,
    ensure_area,
    ensure_client,
    ensure_label,
    ensure_user,
    free_port,
    location_for_label,
    set_entity_place,
)
from ha_client import Http, WebSocket

ROOT = Path(__file__).resolve().parents[2]
BROWSER_DIR = ROOT / "tests" / "browser"
VERSION_FILE = Path(__file__).with_name("HA_VERSION")
ADMIN_B = ("browser_admin_b", "Browser-AdminB-2026!")
USER_A = ("browser_user_a", "Browser-UserA-2026!")
USER_B = ("browser_user_b", "Browser-UserB-2026!")
CREATED_USER = ("browser_created_user", "Browser-Created-2026!")


def session(http: Http, username: str, password: str) -> dict[str, object]:
    return {"username": username, "tokens": http.login(username, password)}


def run(version: str, *, keep: bool = False) -> None:
    port = free_port()
    harness = RuntimeHarness(version, port, keep=keep)
    http = Http(f"http://127.0.0.1:{port}")
    success = False
    root: WebSocket | None = None
    try:
        harness.start()
        root_token = complete_onboarding(http)
        create_config_entry(http, root_token)
        root = WebSocket(http.host, http.port)
        root.auth(root_token)

        ensure_label(root, "browser_a_north", "Browser A North")
        ensure_label(root, "browser_a_west", "Browser A West")
        ensure_label(root, "browser_b", "Browser B")
        areas = {
            "a_north": ensure_area(root, "living_room", "Living Room", "browser_a_north"),
            "a_west": ensure_area(root, "browser_a_west", "West Wing", "browser_a_west"),
            "b": ensure_area(root, "kitchen", "Kitchen", "browser_b"),
        }
        set_entity_place(
            root,
            "input_boolean.runtime_a_toggle",
            areas["a_north"],
            "browser_a_north",
        )
        set_entity_place(
            root,
            "input_boolean.runtime_b_toggle",
            areas["b"],
            "browser_b",
        )

        client_a, _ = ensure_client(root, "Browser Client A")
        client_b, _ = ensure_client(root, "Browser Client B")
        root.command({"type": "optim_energy/client/delete", "client": "default"})
        root.command(
            {
                "type": "optim_energy/client/set_locations",
                "client": client_a,
                "labels": ["browser_a_north", "browser_a_west"],
            }
        )
        root.command(
            {
                "type": "optim_energy/client/set_locations",
                "client": client_b,
                "labels": ["browser_b"],
            }
        )
        tree_a = client_tree(root, client_a)
        tree_b = client_tree(root, client_b)
        location_a_north = location_for_label(tree_a, "browser_a_north")
        location_a_west = location_for_label(tree_a, "browser_a_west")
        location_b = location_for_label(tree_b, "browser_b")

        tree_a.setdefault("virtual", []).append(
            {"id": "virt:browser-main", "name": "Browser Main Device"}
        )
        tree_a.setdefault("placed", {})["virt:browser-main"] = location_a_north
        root.command(
            {
                "type": "optim_energy/tree/save",
                "client": client_a,
                "tree": tree_a,
            }
        )

        ensure_user(
            root,
            client_id=client_a,
            name="Browser Admin A",
            username=CLIENT_ADMIN_A[0],
            password=CLIENT_ADMIN_A[1],
            role="client_admin",
            location=None,
        )
        ensure_user(
            root,
            client_id=client_b,
            name="Browser Admin B",
            username=ADMIN_B[0],
            password=ADMIN_B[1],
            role="client_admin",
            location=None,
        )
        ensure_user(
            root,
            client_id=client_a,
            name="Browser User A",
            username=USER_A[0],
            password=USER_A[1],
            role="user",
            location=location_a_north,
        )
        ensure_user(
            root,
            client_id=client_b,
            name="Browser User B",
            username=USER_B[0],
            password=USER_B[1],
            role="user",
            location=location_b,
        )

        user_a_state = session(http, *USER_A)
        user_a_ws = WebSocket(http.host, http.port)
        user_a_ws.auth(user_a_state["tokens"]["access_token"])
        try:
            user_a_sidebar = user_a_ws.command(
                {"type": "frontend/get_user_data", "key": "sidebar"}
            )["value"]
            assert user_a_sidebar["panelOrder"][0] == "energy-start"
            assert "energy-locations" in user_a_sidebar["hiddenPanels"]
            assert "energy-admin" in user_a_sidebar["hiddenPanels"]
        finally:
            user_a_ws.close()

        state = {
            "base_url": http.base_url,
            "root": {"username": "runtime_owner", "tokens": http.login("runtime_owner", "Runtime-Owner-2026!")},
            "admin_a": session(http, *CLIENT_ADMIN_A),
            "admin_b": session(http, *ADMIN_B),
            "user_a": user_a_state,
            "client_a": client_a,
            "client_b": client_b,
            "client_a_name": "Browser Client A",
            "client_b_name": "Browser Client B",
            "location_a_north": location_a_north,
            "location_a_west": location_a_west,
            "location_b": location_b,
            "created_user": {"username": CREATED_USER[0], "password": CREATED_USER[1]},
            "virtual_main": "virt:browser-main",
        }
        state_path = harness.temp_dir / "browser-state.json"
        state_path.write_text(json.dumps(state), encoding="utf-8")

        env = os.environ.copy()
        subprocess.run(
            ["node", "portal_acceptance.mjs", str(state_path)],
            cwd=BROWSER_DIR,
            env=env,
            check=True,
            timeout=180,
        )
        success = True
        print(json.dumps({"profile": "browser portal flows", "status": "PASS"}, indent=2))
    finally:
        if not success or keep:
            sys.stderr.write("\n--- Home Assistant runtime log ---\n")
            sys.stderr.write(harness.logs())
        if root is not None:
            try:
                root.close()
            except Exception:
                pass
        harness.stop()
        harness.cleanup()


def main() -> int:
    run(VERSION_FILE.read_text(encoding="utf-8").strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
