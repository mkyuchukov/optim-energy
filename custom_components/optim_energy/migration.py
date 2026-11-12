"""Plan the move to "floor = client, area = location".

Until now a location is a Home Assistant label, a group is a Home Assistant
area, and a device belongs to a location through its area, its own label or
the stored tree. Afterwards a client is a floor, a location is one area on
that floor, and groups live only in the tenancy store.

Everything here is pure: plain dicts in, plain dicts out, no Home Assistant
imports. ``plan_migration`` decides, ``apply_plan`` carries a plan out on a
snapshot. The dry-run tool and the tests use both; the integration will run
the same plan against the live registries.

Location ids (``loc:...``) do not change, so users, prices, main devices and
schedules keep pointing at the same locations. Nothing is deleted: the old
labels and areas stay where they are.

Snapshot shape::

    {"store": <tenancy store data>,
     "labels":   [{"id", "name"}],
     "floors":   [{"id", "name"}],
     "areas":    [{"id", "name", "floor_id", "labels"}],
     "devices":  [{"id", "name", "area_id", "labels"}],
     "entities": [{"entity_id", "device_id", "area_id", "labels"}]}
"""

from __future__ import annotations

import copy
import re
from typing import Any

MODEL = "areas"


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_") or "x"


def _unique(name: str, taken: set[str], fallback: str) -> str:
    """Return name, or fallback, or a numbered fallback, whichever is free."""
    for candidate in (name, fallback):
        if candidate.casefold() not in taken:
            return candidate
    number = 2
    while f"{fallback} {number}".casefold() in taken:
        number += 1
    return f"{fallback} {number}"


def _native_places(client: dict[str, Any], tree: dict[str, Any], snap: dict[str, Any]) -> list[dict[str, Any]]:
    """Places as the portal shows them today: labels, floors and areas merged in."""
    assigned = set(client.get("labels") or [])
    labels = {x["id"]: x for x in snap["labels"]}
    floors = {x["id"]: x for x in snap["floors"]}
    area_loc = {
        a["id"]: next((x for x in a.get("labels") or [] if x in assigned), None)
        for a in snap["areas"]
    }
    floor_loc: dict[str, str] = {}
    for area in snap["areas"]:
        loc = area_loc[area["id"]]
        if loc and area.get("floor_id") and area["floor_id"] not in floor_loc:
            floor_loc[area["floor_id"]] = loc
    places = [
        copy.deepcopy(p)
        for p in tree.get("places") or []
        if isinstance(p, dict)
        and not str(p.get("id", "")).startswith(("area:", "floor:"))
        and not (str(p.get("id", "")).startswith("loc:") and str(p["id"])[4:] in labels)
    ]
    for label_id in sorted(assigned):
        if label_id in labels:
            places.append({"id": f"loc:{label_id}", "name": labels[label_id]["name"], "kind": "location", "parent": None})
    for floor_id, label_id in floor_loc.items():
        name = floors.get(floor_id, {}).get("name") or floor_id
        places.append({"id": f"floor:{floor_id}", "name": name, "kind": "group", "parent": f"loc:{label_id}"})
    for area in snap["areas"]:
        label_id = area_loc[area["id"]]
        if not label_id:
            continue
        on_floor = area.get("floor_id") and floor_loc.get(area["floor_id"]) == label_id
        parent = f"floor:{area['floor_id']}" if on_floor else f"loc:{label_id}"
        places.append({"id": f"area:{area['id']}", "name": area["name"], "kind": "group", "parent": parent})
    return places


def _location_of(places: dict[str, dict[str, Any]], place_id: str | None) -> str | None:
    seen: set[str] = set()
    while place_id and place_id not in seen:
        seen.add(place_id)
        place = places.get(place_id)
        if place is None:
            return None
        if place.get("kind") == "location":
            return place_id
        place_id = place.get("parent")
    return None


def plan_migration(snap: dict[str, Any]) -> dict[str, Any]:
    """Return the new store, the registry changes and a report. Changes nothing."""
    store = copy.deepcopy(snap["store"])
    report: dict[str, Any] = {"clients": [], "blockers": [], "warnings": [], "old_areas": [], "old_floors": []}
    if store.get("model") == MODEL:
        report["already_migrated"] = True
        return {"store": store, "ops": [], "report": report}

    ops: list[dict[str, Any]] = []
    floor_names = {f["name"].casefold() for f in snap["floors"]}
    area_names = {a["name"].casefold() for a in snap["areas"]}
    devices = {d["id"]: d for d in snap["devices"]}
    entities_of: dict[str, list[str]] = {}
    for entity in snap["entities"]:
        if entity.get("device_id"):
            entities_of.setdefault(entity["device_id"], []).append(entity["entity_id"])
    claimed: dict[str, str] = {}  # device or entity id -> "client / location"
    old_areas: set[str] = set()
    old_floors: set[str] = set()

    for client_id, client in store.get("clients", {}).items():
        tree = store["trees"].setdefault(client_id, {})
        place_list = _native_places(client, tree, snap)
        places = {str(p["id"]): p for p in place_list if p.get("id")}
        client_name = str(client.get("name") or client_id)
        assigned = set(client.get("labels") or [])
        placed_old = {str(k): str(v) for k, v in (tree.get("placed") or {}).items()}
        users = [u for u in store.get("users", {}).values() if u.get("client") == client_id]

        floor_name = _unique(client_name, floor_names, f"{client_name} (client)")
        floor_names.add(floor_name.casefold())
        floor_key = f"floor:{client_id}"
        ops.append({"op": "create_floor", "key": floor_key, "name": floor_name, "client": client_id})
        client["floor_id"] = floor_key

        # Where every device and loose entity is today, and by which rule.
        area_place = {
            a["id"]: f"area:{a['id']}"
            for a in snap["areas"]
            if f"area:{a['id']}" in places
        }
        old_areas.update(area_place)
        old_floors.update(p[6:] for p in places if p.startswith("floor:"))
        found: dict[str, dict[str, str | None]] = {}  # device id -> {loc, group, by}
        for device in snap["devices"]:
            sources: dict[str, tuple[str, str | None]] = {}
            if device.get("area_id") in area_place:
                group = area_place[device["area_id"]]
                loc = _location_of(places, group)
                if loc:
                    sources["area"] = (loc, group)
            own = sorted(x for x in device.get("labels") or [] if x in assigned)
            if len(own) > 1:
                report["blockers"].append(f"Device {device['name']} carries the labels of {len(own)} locations of {client_name}")
            if own and f"loc:{own[0]}" in places:
                sources["label"] = (f"loc:{own[0]}", None)
            if device["id"] in placed_old:
                place = placed_old[device["id"]]
                loc = _location_of(places, place)
                if loc:
                    sources["tree"] = (loc, None if place == loc else place)
                else:
                    report["warnings"].append(f"Device {device['name']} is placed in {place}, which no longer exists in {client_name}")
            if not sources:
                continue
            by = next(x for x in ("area", "label", "tree") if x in sources)
            loc, group = sources[by]
            if group is None and "tree" in sources and sources["tree"][0] == loc:
                group = sources["tree"][1]  # a labelled device keeps its tree group
            others = {x: s[0] for x, s in sources.items() if s[0] != loc}
            if others:
                report["warnings"].append(
                    f"Device {device['name']} is in {places[loc]['name']} by its {by}, but also in "
                    + ", ".join(f"{places[l]['name']} by its {x}" for x, l in others.items())
                    + f". It moves to {places[loc]['name']} only."
                )
            found[device["id"]] = {"loc": loc, "group": group, "by": by}

        loose: dict[str, str] = {}  # entity id -> location
        for entity in snap["entities"]:
            if entity.get("device_id"):
                if entity.get("area_id") in area_place and found.get(entity["device_id"], {}).get("loc") != _location_of(places, area_place[entity["area_id"]]):
                    report["warnings"].append(f"Entity {entity['entity_id']} has its own area, different from its device; left as it is")
                continue
            loc = None
            if entity.get("area_id") in area_place:
                loc = _location_of(places, area_place[entity["area_id"]])
            own = sorted(x for x in entity.get("labels") or [] if x in assigned)
            if not loc and own and f"loc:{own[0]}" in places:
                loc = f"loc:{own[0]}"
            if loc:
                loose[entity["entity_id"]] = loc
        for virtual_id, kinds in (tree.get("sums") or {}).items():
            loc = _location_of(places, placed_old.get(str(virtual_id)))
            for part in (kinds or {}).values() if isinstance(kinds, dict) else []:
                if isinstance(part, dict) and part.get("entity"):
                    if loc:
                        loose.setdefault(str(part["entity"]), loc)
                    else:
                        report["warnings"].append(f"Sum {part['entity']} belongs to a virtual device with no location; clients will not see it")

        # One new area per location that is in use.
        locations = [p for p in place_list if p.get("kind") == "location"]
        summary = {"client": client_id, "name": client_name, "floor": floor_name, "locations": []}
        kept_places: list[dict[str, Any]] = []
        for location in locations:
            loc = str(location["id"])
            its_devices = sorted(d for d, f in found.items() if f["loc"] == loc)
            its_entities = sorted(e for e, l in loose.items() if l == loc)
            its_users = [u for u in users if loc in (u.get("locations") or [u.get("location")])]
            in_use = bool(its_devices or its_entities or its_users or loc in (tree.get("prices") or {}) or len(locations) == 1)
            labelled = loc.startswith("loc:") and loc[4:] in assigned
            if not in_use and not labelled:
                report["warnings"].append(f"Empty placeholder location {location.get('name')} of {client_name} is dropped")
                continue
            name = str(location.get("name") or loc)
            area_name = _unique(name, area_names, f"{client_name} – {name}")
            area_names.add(area_name.casefold())
            area_key = f"area:{loc}"
            ops.append({"op": "create_area", "key": area_key, "name": area_name, "floor": floor_key, "location": loc, "client": client_id})
            kept_places.append({**copy.deepcopy(location), "area_id": area_key})
            for device_id in its_devices:
                where = f"{client_name} / {name}"
                if device_id in claimed:
                    report["blockers"].append(f"Device {devices[device_id]['name']} belongs to both {claimed[device_id]} and {where}")
                    continue
                claimed[device_id] = where
                ops.append({"op": "set_device_area", "device_id": device_id, "area": area_key, "was": devices[device_id].get("area_id")})
            for entity_id in its_entities:
                where = f"{client_name} / {name}"
                if entity_id in claimed:
                    report["blockers"].append(f"Entity {entity_id} belongs to both {claimed[entity_id]} and {where}")
                    continue
                claimed[entity_id] = where
                ops.append({"op": "set_entity_area", "entity_id": entity_id, "area": area_key})
            groups = [p for p in place_list if p.get("kind") != "location" and _location_of(places, str(p["id"])) == loc]
            used = {f["group"] for d, f in found.items() if f["loc"] == loc and f["group"]}
            used.update(str(a.get("place")) for a in tree.get("automations") or [] if isinstance(a, dict))
            parents = {str(g.get("parent")) for g in groups}
            summary["locations"].append(
                {
                    "id": loc,
                    "name": name,
                    "new_area": area_name,
                    "devices": len(its_devices),
                    "by": {x: sum(1 for d in its_devices if found[d]["by"] == x) for x in ("area", "label", "tree")},
                    "entities": sum(len(entities_of.get(d, [])) for d in its_devices) + len(its_entities),
                    "loose_entities": len(its_entities),
                    "users": len(its_users),
                    "groups": [str(g.get("name")) for g in groups],
                    "empty_groups": [str(g.get("name")) for g in groups if str(g["id"]) not in used and str(g["id"]) not in parents],
                }
            )

        kept_ids = {str(p["id"]) for p in kept_places}
        kept_places += [
            copy.deepcopy(p) for p in place_list
            if p.get("kind") != "location" and _location_of(places, str(p["id"])) in kept_ids
        ]
        tree["places"] = kept_places
        # A device's entry now only says which group it is in; its location is its area.
        tree["placed"] = {
            **{k: v for k, v in placed_old.items() if k not in devices and _location_of(places, v) in kept_ids},
            **{d: (f["group"] or f["loc"]) for d, f in found.items() if f["loc"] in kept_ids},
        }
        for user in users:
            gone = [x for x in (user.get("locations") or []) if x not in kept_ids]
            if gone:
                report["blockers"].append(f"A user of {client_name} is assigned to {', '.join(gone)}, which is not a location any more")
        report["clients"].append(summary)

    store["model"] = MODEL
    report["old_areas"] = sorted(old_areas)
    report["old_floors"] = sorted(old_floors)
    return {"store": store, "ops": ops, "report": report}


def apply_plan(snap: dict[str, Any], plan: dict[str, Any], ids: dict[str, str] | None = None) -> dict[str, Any]:
    """Return the snapshot after the plan. ``ids`` maps plan keys to real ids."""
    out = copy.deepcopy(snap)
    ids = dict(ids or {})
    devices = {d["id"]: d for d in out["devices"]}
    entities = {e["entity_id"]: e for e in out["entities"]}
    for op in plan["ops"]:
        if op["op"] == "create_floor":
            ids.setdefault(op["key"], _slug(op["name"]))
            out["floors"].append({"id": ids[op["key"]], "name": op["name"]})
        elif op["op"] == "create_area":
            ids.setdefault(op["key"], _slug(op["name"]))
            out["areas"].append({"id": ids[op["key"]], "name": op["name"], "floor_id": ids[op["floor"]], "labels": []})
        elif op["op"] == "set_device_area":
            devices[op["device_id"]]["area_id"] = ids[op["area"]]
        elif op["op"] == "set_entity_area":
            entities[op["entity_id"]]["area_id"] = ids[op["area"]]
    store = copy.deepcopy(plan["store"])
    for client in store.get("clients", {}).values():
        client["floor_id"] = ids.get(client.get("floor_id"), client.get("floor_id"))
    for tree in store.get("trees", {}).values():
        for place in tree.get("places") or []:
            if place.get("area_id"):
                place["area_id"] = ids.get(place["area_id"], place["area_id"])
    out["store"] = store
    return out


def visible_before(snap: dict[str, Any]) -> dict[str, set[str]]:
    """Entities each location's permission group covers under the old model."""
    out: dict[str, set[str]] = {}
    store = snap["store"]
    for client_id, client in store.get("clients", {}).items():
        tree = store["trees"].get(client_id, {})
        place_list = _native_places(client, tree, snap)
        places = {str(p["id"]): p for p in place_list}
        placed = {str(k): str(v) for k, v in (tree.get("placed") or {}).items()}
        sums = {
            str(part["entity"])
            for kinds in (tree.get("sums") or {}).values() if isinstance(kinds, dict)
            for part in kinds.values() if isinstance(part, dict) and part.get("entity")
        }
        for location in (p for p in place_list if p.get("kind") == "location"):
            loc = str(location["id"])
            label = loc[4:] if loc.startswith("loc:") else None
            areas = {a["id"] for a in snap["areas"] if label and label in (a.get("labels") or [])}
            allowed = {d for d, p in placed.items() if _location_of(places, p) == loc}
            for device in snap["devices"]:
                labels = device.get("labels") or []
                if device.get("area_id") in areas or (label in labels and not device.get("area_id")):
                    allowed.add(device["id"])
            seen = set(sums)
            for entity in snap["entities"]:
                if entity.get("device_id"):
                    if entity["device_id"] in allowed:
                        seen.add(entity["entity_id"])
                elif entity.get("area_id") in areas or (label and label in (entity.get("labels") or [])):
                    seen.add(entity["entity_id"])
            out[loc] = seen
    return out


def visible_after(snap: dict[str, Any]) -> dict[str, set[str]]:
    """Entities each location's area holds under the new model."""
    out: dict[str, set[str]] = {}
    device_area = {d["id"]: d.get("area_id") for d in snap["devices"]}
    for tree in snap["store"].get("trees", {}).values():
        for place in tree.get("places") or []:
            if place.get("kind") != "location" or not place.get("area_id"):
                continue
            area = place["area_id"]
            out[str(place["id"])] = {
                e["entity_id"]
                for e in snap["entities"]
                if (device_area.get(e["device_id"]) if e.get("device_id") else e.get("area_id")) == area
            }
    return out
