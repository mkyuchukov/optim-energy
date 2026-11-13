"""A brand-new installation: a floor for the first client, no placeholder location, and a device inbox."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from acceptance import (
    RuntimeHarness,
    assert_equal,
    assert_true,
    client_tree,
    complete_onboarding,
    create_config_entry,
    free_port,
)
from ha_client import Http, WebSocket

VERSION_FILE = Path(__file__).with_name("HA_VERSION")


def run(version: str) -> None:
    port = free_port()
    harness = RuntimeHarness(version, port)
    http = Http(f"http://127.0.0.1:{port}")
    success = False
    try:
        harness.start()
        token = complete_onboarding(http)
        create_config_entry(http, token)
        root = WebSocket(http.host, http.port)
        root.auth(token)
        try:
            who = root.command({"type": "optim_energy/whoami"})
            client = who["clients"][0]["id"]
            assert_equal(client_tree(root, client)["places"], [], "a new installation has a placeholder location")
            floors = [f["name"] for f in root.command({"type": "config/floor_registry/list"})]
            assert_true("Runtime Test" in floors, f"the first client has no floor: {floors}")
            location = root.command({"type": "optim_energy/location/save", "client": client, "name": "First Site"})["id"]
            tree = client_tree(root, client)
            assert_true(any(p["id"] == location and p.get("area_id") for p in tree["places"]), "the first location has no area")
            assert_true(isinstance(root.command({"type": "optim_energy/device/inbox"}), list), "no device inbox")
        finally:
            root.close()
        success = True
        print(json.dumps({"profile": "fresh installation", "status": "PASS"}, indent=2))
    finally:
        if not success:
            sys.stderr.write(harness.logs())
        harness.stop()
        harness.cleanup()


if __name__ == "__main__":
    run(VERSION_FILE.read_text(encoding="utf-8").strip())
