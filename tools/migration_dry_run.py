#!/usr/bin/env python3
"""Dry run of the "floor = client, area = location" migration.

Reads a Home Assistant configuration folder (for example a restored backup),
plans the migration and prints a report. It writes nothing and needs no
running Home Assistant:

    python3 tools/migration_dry_run.py /path/to/config
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "optim_migration", ROOT / "custom_components" / "optim_energy" / "migration.py"
)
migration = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(migration)



def load_snapshot(config: Path) -> dict:
    def data(name: str) -> dict:
        return json.loads((config / ".storage" / name).read_text())["data"]

    return {
        "store": data("optim_energy.tenancy"),
        "labels": [{"id": x["label_id"], "name": x["name"]} for x in data("core.label_registry")["labels"]],
        "floors": [{"id": x["floor_id"], "name": x["name"]} for x in data("core.floor_registry")["floors"]],
        "areas": [
            {"id": x["id"], "name": x["name"], "floor_id": x.get("floor_id"), "labels": x.get("labels") or []}
            for x in data("core.area_registry")["areas"]
        ],
        "devices": [
            {"id": x["id"], "name": x.get("name_by_user") or x.get("name") or x["id"], "area_id": x.get("area_id"), "labels": x.get("labels") or []}
            for x in data("core.device_registry")["devices"]
        ],
        "entities": [
            {"entity_id": x["entity_id"], "device_id": x.get("device_id"), "area_id": x.get("area_id"), "labels": x.get("labels") or []}
            for x in data("core.entity_registry")["entities"]
        ],
    }


def area_consumers(config: Path, area_ids: set[str], floor_ids: set[str]) -> list[str]:
    """Find automations, scripts and dashboards that target an old area or floor.

    ponytail: line-based text search, not a YAML parser. It reports the file
    and line, never the line's content, so nothing secret is printed.
    """
    hits: list[str] = []
    wanted = {"area_id": area_ids, "floor_id": floor_ids}
    # Every top-level YAML file (automations, scripts, scenes, packages) and
    # every dashboard. secrets.yaml is never opened.
    files = [x for x in sorted(config.glob("*.yaml")) if x.name != "secrets.yaml"]
    files += sorted((config / ".storage").glob("lovelace*"))
    for path in files:
        if not path.is_file():
            continue
        key = None
        for number, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
            match = re.search(r"\b(area_id|floor_id|area)\b[\"']?\s*:\s*(.*)", line)
            if match:
                key = "floor_id" if match.group(1) == "floor_id" else "area_id"
                values = match.group(2)
            elif key and re.match(r"\s*-\s*\S", line):
                values = line  # a list item under the key
            else:
                key = None
                continue
            for value in re.findall(r"[a-z0-9_]+", values):
                if value in wanted[key]:
                    hits.append(f"{path.relative_to(config)}:{number} targets {key[:-3]} {value}")
    return hits


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    config = Path(sys.argv[1])
    snap = load_snapshot(config)
    plan = migration.plan_migration(snap)
    report = plan["report"]
    if report.get("already_migrated"):
        print("This configuration is already on the new model. Nothing to do.")
        return 0
    after = migration.apply_plan(snap, plan)
    again = migration.plan_migration(after)
    before_seen, after_seen = migration.visible_before(snap), migration.visible_after(after)
    count = lambda kind: sum(1 for op in plan["ops"] if op["op"] == kind)  # noqa: E731

    print("MIGRATION DRY RUN — nothing was changed\n")
    print(f"Changes that would be made: {count('create_floor')} floor(s) created, {count('create_area')} area(s) created, "
          f"{count('set_device_area')} device(s) moved, {count('set_entity_area')} loose entit(ies) moved. Nothing deleted.\n")
    for client in report["clients"]:
        print(f"Client {client['name']}  ->  new floor \"{client['floor']}\"")
        for loc in client["locations"]:
            by = ", ".join(f"{n} by {how}" for how, n in loc["by"].items() if n)
            print(f"  Location {loc['name']}  ->  new area \"{loc['new_area']}\"")
            print(f"    devices: {loc['devices']} ({by or 'none'}); entities: {loc['entities']} ({loc['loose_entities']} without a device); users: {loc['users']}")
            print(f"    groups kept in the plugin: {', '.join(loc['groups']) or 'none'}")
            if loc["empty_groups"]:
                print(f"    empty groups: {', '.join(loc['empty_groups'])}")
            old, new = before_seen.get(loc["id"], set()), after_seen.get(loc["id"], set())
            print(f"    visible entities before/after: {len(old)} / {len(new)}; lost: {len(old - new)}, gained: {len(new - old)}")
            for entity_id in sorted(old - new)[:20]:
                print(f"      lost   {entity_id}")
            for entity_id in sorted(new - old)[:20]:
                print(f"      gained {entity_id}")
        print()
    hits = area_consumers(config, set(report["old_areas"]), set(report["old_floors"]))
    print(f"Automations, scripts and dashboards that target an old area or floor: {len(hits)}")
    for hit in hits:
        print(f"  {hit}")
    print(f"\nWarnings: {len(report['warnings'])}")
    for text in report["warnings"]:
        print(f"  {text}")
    print(f"\nBlockers: {len(report['blockers'])}")
    for text in report["blockers"]:
        print(f"  {text}")
    print(f"\nRunning it a second time would make {len(again['ops'])} change(s).")
    return 1 if report["blockers"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
