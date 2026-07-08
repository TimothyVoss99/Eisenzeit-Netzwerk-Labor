"""Download and spatially filter the open Itiner-e route-segment export."""

from __future__ import annotations

import json
import math
import sys
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "itinere_central_europe.geojson"
SOURCE = "https://itiner-e.org/route-segments/download"
# Site extent plus a small context margin.
BBOX = (1.5, 42.5, 18.7, 53.0)  # min lon, min lat, max lon, max lat


def flatten_coordinates(geometry: dict) -> list[list[float]]:
    coordinates = geometry.get("coordinates") or []
    if geometry.get("type") == "LineString":
        return coordinates
    if geometry.get("type") == "MultiLineString":
        return [point for line in coordinates for point in line]
    return []


def intersects_bbox(points: list[list[float]]) -> bool:
    if not points:
        return False
    min_lon, min_lat, max_lon, max_lat = BBOX
    point_min_lon = min(point[0] for point in points)
    point_max_lon = max(point[0] for point in points)
    point_min_lat = min(point[1] for point in points)
    point_max_lat = max(point[1] for point in points)
    return not (
        point_max_lon < min_lon
        or point_min_lon > max_lon
        or point_max_lat < min_lat
        or point_min_lat > max_lat
    )


def perpendicular_distance(
    point: list[float], start: list[float], end: list[float]
) -> float:
    if start == end:
        return math.hypot(point[0] - start[0], point[1] - start[1])
    x, y = point
    x1, y1 = start
    x2, y2 = end
    numerator = abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1)
    denominator = math.hypot(y2 - y1, x2 - x1)
    return numerator / denominator


def simplify(points: list[list[float]], tolerance: float = 0.0025) -> list[list[float]]:
    """Small Douglas-Peucker simplifier (~200 m in this latitude range)."""
    if len(points) <= 2:
        return points
    max_distance = 0.0
    index = 0
    for current in range(1, len(points) - 1):
        distance = perpendicular_distance(points[current], points[0], points[-1])
        if distance > max_distance:
            index = current
            max_distance = distance
    if max_distance <= tolerance:
        return [points[0], points[-1]]
    left = simplify(points[: index + 1], tolerance)
    right = simplify(points[index:], tolerance)
    return left[:-1] + right


def simplify_geometry(geometry: dict) -> dict:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates") or []
    if geometry_type == "LineString":
        return {"type": geometry_type, "coordinates": simplify(coordinates)}
    if geometry_type == "MultiLineString":
        return {
            "type": geometry_type,
            "coordinates": [simplify(line) for line in coordinates],
        }
    return geometry


def main() -> int:
    request = urllib.request.Request(
        SOURCE,
        headers={"User-Agent": "IronAgeNetworkResearchPrototype/0.1"},
    )
    features = []
    total = 0
    type_counts: Counter[str] = Counter()
    with urllib.request.urlopen(request, timeout=120) as response:
        for raw_line in response:
            total += 1
            try:
                feature = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            geometry = feature.get("geometry") or {}
            points = flatten_coordinates(geometry)
            if not intersects_bbox(points):
                continue

            properties = feature.get("properties") or {}
            route_type = str(properties.get("type") or "Unknown")
            type_counts[route_type] += 1
            features.append(
                {
                    "type": "Feature",
                    "id": feature.get("id"),
                    "properties": {
                        "name": properties.get("name"),
                        "type": route_type,
                        "lowerDate": properties.get("lowerDate"),
                        "upperDate": properties.get("upperDate"),
                        "constructionPeriod": properties.get("constructionPeriod"),
                        "segmentCertainty": properties.get("segmentCertainty"),
                        "passability": properties.get("passability"),
                        "lengthKm": properties.get("_lengthInKm"),
                        "sourceUri": f"https://itiner-e.org/route-segment/{feature.get('id')}",
                    },
                    "geometry": simplify_geometry(geometry),
                }
            )
            if total % 10_000 == 0:
                print(
                    f"{total} source segments, {len(features)} retained",
                    file=sys.stderr,
                )

    payload = {
        "type": "FeatureCollection",
        "name": "Itiner-e route segments in the project extent",
        "source": SOURCE,
        "license": "CC BY 4.0",
        "retrievedUtc": datetime.now(timezone.utc).isoformat(),
        "bbox": list(BBOX),
        "routeTypeCounts": dict(type_counts),
        "features": features,
    }
    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "output": str(OUTPUT),
                "source_segments": total,
                "retained": len(features),
                "types": dict(type_counts),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
