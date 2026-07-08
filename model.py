"""Data loading and graph construction for the Iron Age network prototype."""

from __future__ import annotations

import csv
import json
import math
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parent
SITES_CSV = ROOT / "export_Immovables_15.4.2026-tchi1_Fundorte_Geonames_Link.csv"
COINS_CSV = (
    ROOT / "export_Numismatic object_14.4.2026-numisdata4_Muenzen_Fundort_Kontext.csv"
)
GEOCACHE = ROOT / "data" / "geonames_cache.json"
ITINERE = ROOT / "data" / "itinere_central_europe.geojson"

FINDSPOT_ALIASES = {
    "Kehlheim": "Kelheim",
}

TRANSPORT_MODES = {
    "foot": {
        "label": "Zu Fuß",
        "speedKmh": 4.0,
        "costFactor": 1.0,
        "capacity": 1.0,
        "slopePenalty": 1.0,
        "color": "#c08457",
        "lineStyle": "solid",
        "evidence": "Itiner-e Vergleichswert: 4 km/h",
    },
    "pack_animal": {
        "label": "Packtier",
        "speedKmh": 4.5,
        "costFactor": 0.82,
        "capacity": 2.0,
        "slopePenalty": 1.15,
        "color": "#f59e0b",
        "lineStyle": "solid",
        "evidence": "Itiner-e Vergleichswert: 4,5 km/h",
    },
    "ox_cart": {
        "label": "Ochsenkarren",
        "speedKmh": 2.0,
        "costFactor": 0.9,
        "capacity": 5.0,
        "slopePenalty": 1.8,
        "color": "#ef8354",
        "lineStyle": "dashed",
        "evidence": "Itiner-e Vergleichswert: 2 km/h",
    },
    "horse": {
        "label": "Pferd / Kurier",
        "speedKmh": 6.0,
        "costFactor": 0.75,
        "capacity": 1.5,
        "slopePenalty": 1.2,
        "color": "#f97316",
        "lineStyle": "dashed",
        "evidence": "Itiner-e Vergleichswert: 6 km/h; für Eisenzeit als Hypothese",
    },
    "river_boat": {
        "label": "Flussboot",
        "speedKmh": 5.0,
        "costFactor": 0.42,
        "capacity": 9.0,
        "slopePenalty": 0.1,
        "color": "#38bdf8",
        "lineStyle": "solid",
        "evidence": "Kapazitäts-/Kostenhypothese; Richtung und Saison sind nicht modelliert",
    },
    "lake_boat": {
        "label": "See-/Küstenboot",
        "speedKmh": 6.0,
        "costFactor": 0.36,
        "capacity": 11.0,
        "slopePenalty": 0.0,
        "color": "#22d3ee",
        "lineStyle": "solid",
        "evidence": "Editierbare Modellannahme",
    },
}


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle, delimiter=";"))


def slug(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text).strip("-") or "site"


def haversine_km(a: dict, b: dict) -> float:
    radius = 6371.0088
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    d_lat = lat2 - lat1
    d_lon = math.radians(b["lon"] - a["lon"])
    h = (
        math.sin(d_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(d_lon / 2) ** 2
    )
    return 2 * radius * math.asin(math.sqrt(h))


def polyline_distance_km(points: list[list[float]]) -> float:
    total = 0.0
    for index in range(1, len(points)):
        a = {"lat": points[index - 1][0], "lon": points[index - 1][1]}
        b = {"lat": points[index][0], "lon": points[index][1]}
        total += haversine_km(a, b)
    return total


def infer_size(contexts: Counter[str], coin_total: int) -> tuple[float, str]:
    context_text = " | ".join(contexts).lower()
    if "oppidum" in context_text:
        return 10.0, "Kontext-Heuristik: Oppidum"
    if "production" in context_text or "distribution" in context_text:
        return 8.0, "Kontext-Heuristik: Produktions-/Distributionszentrum"
    if "settlement" in context_text:
        return 6.0, "Kontext-Heuristik: Siedlung"
    if "viereckschanze" in context_text or "cult site" in context_text:
        return 4.0, "Kontext-Heuristik: Sonder-/Kultplatz"
    if coin_total:
        return 3.0, "Kontext-Heuristik: Fundort ohne Größenangabe"
    return 2.0, "Fallback ohne archäologische Größenangabe"


def coin_metrics(
    source_counts: dict[str, int], target_counts: dict[str, int]
) -> dict[str, float | int]:
    shared = set(source_counts).intersection(target_counts)
    shared_minimum = sum(
        min(source_counts[coin_type], target_counts[coin_type])
        for coin_type in shared
    )
    source_total = sum(source_counts.values())
    target_total = sum(target_counts.values())
    denominator = math.sqrt(source_total * target_total)
    proxy = shared_minimum / denominator if denominator else 0.0
    return {
        "sharedTypeCount": len(shared),
        "sharedCoinMinimum": shared_minimum,
        "coinProxy": round(proxy, 6),
    }


def _flatten_geometry(geometry: dict) -> list[list[float]]:
    if geometry.get("type") == "LineString":
        return geometry.get("coordinates") or []
    if geometry.get("type") == "MultiLineString":
        return [
            point
            for line in geometry.get("coordinates") or []
            for point in line
        ]
    return []


def _point_to_segment_km(
    lat: float,
    lon: float,
    a_lon: float,
    a_lat: float,
    b_lon: float,
    b_lat: float,
) -> float:
    reference_lat = math.radians(lat)
    scale_x = 111.32 * math.cos(reference_lat)
    scale_y = 110.57
    px, py = lon * scale_x, lat * scale_y
    ax, ay = a_lon * scale_x, a_lat * scale_y
    bx, by = b_lon * scale_x, b_lat * scale_y
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    parameter = max(
        0.0,
        min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)),
    )
    closest_x = ax + parameter * dx
    closest_y = ay + parameter * dy
    return math.hypot(px - closest_x, py - closest_y)


def _nearest_polyline_point(node: dict, points: list[list[float]]) -> tuple[float, int]:
    if len(points) == 1:
        distance = haversine_km(
            node, {"lat": points[0][1], "lon": points[0][0]}
        )
        return distance, 0
    best_distance = float("inf")
    best_index = 0
    for index in range(len(points) - 1):
        distance = _point_to_segment_km(
            node["lat"],
            node["lon"],
            points[index][0],
            points[index][1],
            points[index + 1][0],
            points[index + 1][1],
        )
        if distance < best_distance:
            best_distance = distance
            best_index = index
    return best_distance, best_index


def load_itinere() -> dict:
    if not ITINERE.exists():
        return {"type": "FeatureCollection", "features": []}
    return json.loads(ITINERE.read_text(encoding="utf-8"))


def water_access(nodes: list[dict], itinere: dict) -> tuple[dict, dict]:
    rivers = {}
    for feature in itinere.get("features", []):
        if feature.get("properties", {}).get("type") != "River":
            continue
        points = _flatten_geometry(feature.get("geometry") or {})
        if len(points) < 2:
            continue
        rivers[str(feature.get("id"))] = {
            "id": str(feature.get("id")),
            "name": feature.get("properties", {}).get("name") or "Unbenannter Fluss",
            "points": points,
            "sourceUri": feature.get("properties", {}).get("sourceUri"),
        }

    access: dict[str, list[dict]] = {}
    for node in nodes:
        nearby = []
        for river_id, river in rivers.items():
            distance, index = _nearest_polyline_point(node, river["points"])
            if distance <= 18.0:
                nearby.append(
                    {
                        "riverId": river_id,
                        "distanceKm": round(distance, 3),
                        "nearestIndex": index,
                        "name": river["name"],
                    }
                )
        access[node["id"]] = sorted(
            nearby, key=lambda item: item["distanceKm"]
        )[:5]
    return access, rivers


def load_nodes() -> tuple[list[dict], list[dict]]:
    site_rows = read_csv(SITES_CSV)
    coin_rows = read_csv(COINS_CSV)
    geocache = json.loads(GEOCACHE.read_text(encoding="utf-8"))["sites"]

    grouped_sites: dict[str, list[dict]] = defaultdict(list)
    for row in site_rows:
        name = row["Name"].strip()
        if name:
            grouped_sites[name].append(row)

    coin_counts: dict[str, Counter[str]] = defaultdict(Counter)
    coin_totals: Counter[str] = Counter()
    contexts: dict[str, Counter[str]] = defaultdict(Counter)
    type_totals: Counter[str] = Counter()
    type_sites: dict[str, set[str]] = defaultdict(set)
    for row in coin_rows:
        findspot = FINDSPOT_ALIASES.get(
            row["Findspot | Name"].strip(), row["Findspot | Name"].strip()
        )
        if not findspot:
            continue
        coin_totals[findspot] += 1
        context = row["Archeological context"].strip()
        if context:
            contexts[findspot][context] += 1
        coin_type = row["Type | Code"].strip()
        if coin_type:
            coin_counts[findspot][coin_type] += 1
            type_totals[coin_type] += 1
            type_sites[coin_type].add(findspot)

    nodes = []
    used_ids: Counter[str] = Counter()
    for name, rows in sorted(grouped_sites.items()):
        location = geocache.get(name)
        if not location:
            continue
        base_id = f"n-{slug(name)}"
        used_ids[base_id] += 1
        node_id = (
            base_id
            if used_ids[base_id] == 1
            else f"{base_id}-{used_ids[base_id]}"
        )
        size, size_basis = infer_size(contexts[name], coin_totals[name])
        uri_values = [row["URI"].strip() for row in rows if row["URI"].strip()]
        nodes.append(
            {
                "id": node_id,
                "sourceIds": [row["Id"] for row in rows],
                "name": name,
                "lat": location["lat"],
                "lon": location["lon"],
                "elevationM": location.get("elevation_m"),
                "country": location.get("country"),
                "coordinateSource": location.get("coordinate_source"),
                "coordinateQuality": location.get("coordinate_quality"),
                "sourceUris": uri_values,
                "size": size,
                "sizeBasis": size_basis,
                "coinFindCount": coin_totals[name],
                "distinctCoinTypes": len(coin_counts[name]),
                "typeCounts": dict(coin_counts[name].most_common()),
                "contexts": dict(contexts[name].most_common()),
                "initialCoins": 0.0,
            }
        )

    coin_types = [
        {
            "type": coin_type,
            "coinCount": type_totals[coin_type],
            "siteCount": len(type_sites[coin_type]),
            "startYear": None,
            "endYear": None,
        }
        for coin_type in sorted(type_totals)
    ]
    return nodes, coin_types


class UnionFind:
    def __init__(self, ids: Iterable[str]):
        self.parent = {item: item for item in ids}
        self.rank = {item: 0 for item in ids}

    def find(self, item: str) -> str:
        while self.parent[item] != item:
            self.parent[item] = self.parent[self.parent[item]]
            item = self.parent[item]
        return item

    def union(self, left: str, right: str) -> bool:
        left_root, right_root = self.find(left), self.find(right)
        if left_root == right_root:
            return False
        if self.rank[left_root] < self.rank[right_root]:
            left_root, right_root = right_root, left_root
        self.parent[right_root] = left_root
        if self.rank[left_root] == self.rank[right_root]:
            self.rank[left_root] += 1
        return True


def _river_route(
    source: dict,
    target: dict,
    source_access: list[dict],
    target_access: list[dict],
    rivers: dict,
) -> dict | None:
    target_by_river = {item["riverId"]: item for item in target_access}
    candidates = [
        (item["distanceKm"] + target_by_river[item["riverId"]]["distanceKm"], item)
        for item in source_access
        if item["riverId"] in target_by_river
    ]
    if not candidates:
        return None
    _, source_item = min(candidates, key=lambda value: value[0])
    target_item = target_by_river[source_item["riverId"]]
    river = rivers[source_item["riverId"]]
    start_index, end_index = (
        source_item["nearestIndex"],
        target_item["nearestIndex"],
    )
    low, high = sorted((start_index, end_index))
    river_slice = river["points"][low : high + 2]
    if start_index > end_index:
        river_slice.reverse()
    route = [[source["lat"], source["lon"]]]
    route.extend([[point[1], point[0]] for point in river_slice])
    route.append([target["lat"], target["lon"]])
    direct = haversine_km(source, target)
    routed = polyline_distance_km(route)
    if routed > max(10.0, direct * 2.2):
        return None
    return {
        "name": river["name"],
        "route": route,
        "distanceKm": routed,
        "sourceUri": river.get("sourceUri"),
        "accessDistanceKm": round(
            source_item["distanceKm"] + target_item["distanceKm"], 3
        ),
    }


def build_edges(
    nodes: list[dict],
    k_neighbors: int = 3,
    max_distance_km: float = 180.0,
    itinere: dict | None = None,
) -> list[dict]:
    itinere = itinere or load_itinere()
    node_by_id = {node["id"]: node for node in nodes}
    pairs = []
    for left_index, source in enumerate(nodes):
        for target in nodes[left_index + 1 :]:
            pairs.append((haversine_km(source, target), source["id"], target["id"]))
    pairs.sort()

    knn_pairs: set[tuple[str, str]] = set()
    by_node: dict[str, list[tuple[float, str]]] = defaultdict(list)
    for distance, source_id, target_id in pairs:
        by_node[source_id].append((distance, target_id))
        by_node[target_id].append((distance, source_id))
    for source_id, candidates in by_node.items():
        selected = [
            candidate
            for candidate in candidates
            if candidate[0] <= max_distance_km
        ][: max(1, k_neighbors)]
        for _, target_id in selected:
            knn_pairs.add(tuple(sorted((source_id, target_id))))

    union_find = UnionFind(node_by_id)
    mst_pairs: set[tuple[str, str]] = set()
    for _, source_id, target_id in pairs:
        if union_find.union(source_id, target_id):
            mst_pairs.add(tuple(sorted((source_id, target_id))))
        if len(mst_pairs) == len(nodes) - 1:
            break

    selected_pairs = knn_pairs.union(mst_pairs)
    distance_lookup = {
        tuple(sorted((source_id, target_id))): distance
        for distance, source_id, target_id in pairs
    }
    access, rivers = water_access(nodes, itinere)

    edges = []
    for source_id, target_id in sorted(
        selected_pairs,
        key=lambda pair: (distance_lookup[pair], pair[0], pair[1]),
    ):
        source = node_by_id[source_id]
        target = node_by_id[target_id]
        direct_distance = distance_lookup[(source_id, target_id)]
        water_route = _river_route(
            source,
            target,
            access[source_id],
            access[target_id],
            rivers,
        )
        distance = water_route["distanceKm"] if water_route else direct_distance
        route = (
            water_route["route"]
            if water_route
            else [[source["lat"], source["lon"]], [target["lat"], target["lon"]]]
        )
        mode = "river_boat" if water_route else "pack_animal"
        relief = 0.0
        if source["elevationM"] is not None and target["elevationM"] is not None:
            relief = abs(source["elevationM"] - target["elevationM"])
        endpoint_slope = relief / max(direct_distance * 1000.0, 1.0)
        terrain_factor = 1.0 + min(1.5, endpoint_slope * 12.0)
        metrics = coin_metrics(source["typeCounts"], target["typeCounts"])
        pair_kind = (
            "kNN+MST"
            if (source_id, target_id) in knn_pairs
            and (source_id, target_id) in mst_pairs
            else "kNN"
            if (source_id, target_id) in knn_pairs
            else "MST-Brücke"
        )
        edge = {
            "id": f"e-{source_id[2:]}--{target_id[2:]}",
            "source": source_id,
            "target": target_id,
            "enabled": True,
            "mode": mode,
            "strength": 5.0,
            "distanceKm": round(distance, 3),
            "directDistanceKm": round(direct_distance, 3),
            "terrainFactor": round(terrain_factor, 5),
            "terrainMethod": "Endpunkthöhen-Proxy; kein vollständiges DEM-LCP",
            "route": route,
            "routeBasis": (
                "Itiner-e-Flusskorridor"
                if water_route
                else f"Nicht-römische Netz-Hypothese ({pair_kind})"
            ),
            "evidenceUri": water_route.get("sourceUri") if water_route else None,
            "waterway": water_route.get("name") if water_route else None,
            "waterAccessDistanceKm": (
                water_route.get("accessDistanceKm") if water_route else None
            ),
            **metrics,
        }
        edges.append(edge)
    return edges


def bootstrap(k_neighbors: int = 3, max_distance_km: float = 180.0) -> dict:
    nodes, coin_types = load_nodes()
    itinere = load_itinere()
    edges = build_edges(nodes, k_neighbors, max_distance_km, itinere)
    total_coin_rows = sum(node["coinFindCount"] for node in nodes)
    return {
        "nodes": nodes,
        "edges": edges,
        "coinTypes": coin_types,
        "transportModes": TRANSPORT_MODES,
        "metadata": {
            "siteCount": len(nodes),
            "edgeCount": len(edges),
            "coinRowCount": total_coin_rows,
            "coinTypeCount": len(coin_types),
            "defaultStartYear": -250,
            "durationYears": 200,
            "stepYears": 25,
            "kNeighbors": k_neighbors,
            "maxDistanceKm": max_distance_km,
            "methodNotes": [
                "Fundorte aus der beigefügten CSV; Koordinaten aus den verknüpften GeoNames-RDF-Datensätzen.",
                "Nicht-römische Kanten: k-nächste Nachbarn plus minimaler Spannbaum; abstrakte Verbindungshypothesen.",
                "Flusskanten: gemeinsame Nähe zu einem Itiner-e-Flusssegment; kein Nachweis einer konkreten eisenzeitlichen Fahrt.",
                "Siedlungsgrößen: aus Kontextbegriffen abgeleitete, vollständig editierbare Startwerte.",
                "Münzproxy: exakte Übereinstimmung von 'Type | Code'; undatierte Typen können separat ein-/ausgeschlossen werden.",
            ],
        },
    }
