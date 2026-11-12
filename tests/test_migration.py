"""The floor/area migration plan, checked on a small two-client installation."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "optim_migration", ROOT / "custom_components" / "optim_energy" / "migration.py"
)
migration = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(migration)


def snapshot() -> dict:
    """Two clients sharing one HA floor, with a device placed by each rule."""
    return {
        "labels": [{"id": "a_north", "name": "North"}, {"id": "a_south", "name": "South"}, {"id": "b_site", "name": "North"}],
        "floors": [{"id": "ground", "name": "Ground"}],
        "areas": [
            {"id": "a_room", "name": "A room", "floor_id": "ground", "labels": ["a_north"]},
            {"id": "b_room", "name": "B room", "floor_id": "ground", "labels": ["b_site"]},
            {"id": "spare", "name": "Spare", "floor_id": None, "labels": []},
        ],
        "devices": [
            {"id": "d_area", "name": "By area", "area_id": "a_room", "labels": []},
            {"id": "d_label", "name": "By label", "area_id": None, "labels": ["a_south"]},
            {"id": "d_tree", "name": "By tree", "area_id": None, "labels": []},
            {"id": "d_b", "name": "B device", "area_id": "b_room", "labels": []},
            {"id": "d_free", "name": "Unassigned", "area_id": "spare", "labels": []},
        ],
        "entities": [
            {"entity_id": "sensor.area_power", "device_id": "d_area", "area_id": None, "labels": []},
            {"entity_id": "sensor.label_power", "device_id": "d_label", "area_id": None, "labels": []},
            {"entity_id": "sensor.tree_power", "device_id": "d_tree", "area_id": None, "labels": []},
            {"entity_id": "sensor.b_power", "device_id": "d_b", "area_id": None, "labels": []},
            {"entity_id": "sensor.free_power", "device_id": "d_free", "area_id": None, "labels": []},
            {"entity_id": "automation.a_evening", "device_id": None, "area_id": "a_room", "labels": []},
            {"entity_id": "binary_sensor.a_rule", "device_id": None, "area_id": None, "labels": ["a_south"]},
            {"entity_id": "sensor.a_sum", "device_id": None, "area_id": None, "labels": []},
        ],
        "store": {
            "clients": {
                "a": {"id": "a", "name": "Alpha", "labels": ["a_north", "a_south"]},
                "b": {"id": "b", "name": "Beta", "labels": ["b_site"]},
            },
            "users": {"u1": {"client": "a", "role": "user", "locations": ["loc:a_south"]}},
            "trees": {
                "a": {
                    "places": [],
                    "placed": {"d_tree": "loc:a_north", "virt:a": "loc:a_north"},
                    "virtual": [{"id": "virt:a", "name": "A total"}],
                    "sums": {"virt:a": {"energy": {"entry": "e1", "entity": "sensor.a_sum"}}},
                    "prices": {"loc:a_north": {"mode": "fixed", "fixed": 0.2}},
                },
                "b": {"places": [], "placed": {}},
            },
        },
    }


class MigrationPlan(unittest.TestCase):
    def test_each_client_gets_a_floor_and_each_location_an_area(self) -> None:
        snap = snapshot()
        plan = migration.plan_migration(snap)
        self.assertEqual(plan["report"]["blockers"], [])
        floors = [op["name"] for op in plan["ops"] if op["op"] == "create_floor"]
        areas = {op["location"]: op["name"] for op in plan["ops"] if op["op"] == "create_area"}
        self.assertEqual(floors, ["Alpha", "Beta"])
        # Two clients both call a location "North"; HA area names must differ.
        self.assertEqual(areas, {"loc:a_north": "North", "loc:a_south": "South", "loc:b_site": "Beta – North"})
        moved = {op["device_id"]: op["area"] for op in plan["ops"] if op["op"] == "set_device_area"}
        self.assertEqual(
            moved,
            {"d_area": "area:loc:a_north", "d_tree": "area:loc:a_north", "d_label": "area:loc:a_south", "d_b": "area:loc:b_site"},
        )
        self.assertNotIn("d_free", moved)  # an unassigned device stays unassigned

    def test_nothing_changes_who_sees_what_except_foreign_sums(self) -> None:
        snap = snapshot()
        after = migration.apply_plan(snap, migration.plan_migration(snap))
        before, now = migration.visible_before(snap), migration.visible_after(after)
        self.assertEqual(now["loc:a_north"], {"sensor.area_power", "sensor.tree_power", "automation.a_evening", "sensor.a_sum"})
        self.assertEqual(now["loc:a_south"], {"sensor.label_power", "binary_sensor.a_rule"})
        self.assertEqual(now["loc:b_site"], {"sensor.b_power"})
        # The old model showed every sum of a client to all of its locations.
        self.assertEqual(before["loc:a_south"] - now["loc:a_south"], {"sensor.a_sum"})
        for location in now:
            self.assertEqual(now[location] - before[location], set(), location)

    def test_store_keeps_location_ids_groups_and_settings(self) -> None:
        snap = snapshot()
        after = migration.apply_plan(snap, migration.plan_migration(snap))
        store = after["store"]
        self.assertEqual(store["model"], "areas")
        self.assertEqual(store["clients"]["a"]["floor_id"], "alpha")
        tree = store["trees"]["a"]
        places = {p["id"]: p for p in tree["places"]}
        self.assertEqual(places["loc:a_north"]["area_id"], "north")
        self.assertEqual(places["area:a_room"]["kind"], "group")  # the old area lives on as a group
        self.assertEqual(tree["placed"], {"d_area": "area:a_room", "d_tree": "loc:a_north", "d_label": "loc:a_south", "virt:a": "loc:a_north"})
        self.assertEqual(tree["prices"], snap["store"]["trees"]["a"]["prices"])
        self.assertEqual(store["users"], snap["store"]["users"])
        # Old labels and areas are still there for a rollback.
        self.assertTrue({"a_room", "b_room", "spare"} <= {a["id"] for a in after["areas"]})
        self.assertEqual(after["labels"], snap["labels"])

    def test_running_it_twice_changes_nothing(self) -> None:
        snap = snapshot()
        first = migration.plan_migration(snap)
        self.assertEqual(first, migration.plan_migration(snap))
        again = migration.plan_migration(migration.apply_plan(snap, first))
        self.assertEqual(again["ops"], [])
        self.assertTrue(again["report"]["already_migrated"])

    def test_a_device_claimed_by_two_clients_blocks_the_migration(self) -> None:
        snap = snapshot()
        snap["store"]["trees"]["b"]["placed"] = {"d_area": "loc:b_site"}
        plan = migration.plan_migration(snap)
        self.assertEqual(len(plan["report"]["blockers"]), 1)
        self.assertIn("By area", plan["report"]["blockers"][0])

    def test_conflicting_sources_are_reported_and_the_area_wins(self) -> None:
        snap = snapshot()
        snap["store"]["trees"]["a"]["placed"]["d_area"] = "loc:a_south"
        plan = migration.plan_migration(snap)
        moved = {op["device_id"]: op["area"] for op in plan["ops"] if op["op"] == "set_device_area"}
        self.assertEqual(moved["d_area"], "area:loc:a_north")
        self.assertTrue(any("By area" in text for text in plan["report"]["warnings"]))


if __name__ == "__main__":
    unittest.main()
