"""Build a reproducible coordinate cache from the GeoNames links in the site CSV."""

from __future__ import annotations

import csv
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SITES_CSV = ROOT / "export_Immovables_15.4.2026-tchi1_Fundorte_Geonames_Link.csv"
OUTPUT = ROOT / "data" / "geonames_cache.json"
GEONAMES_ID = re.compile(r"geonames\.org/(\d+)", re.IGNORECASE)
GEONAMES_MAP = re.compile(
    r"geonames\.org/maps/google_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)\.html",
    re.IGNORECASE,
)

NAMESPACES = {
    "gn": "http://www.geonames.org/ontology#",
    "wgs84": "http://www.w3.org/2003/01/geo/wgs84_pos#",
}

# The two source rows without GeoNames links are kept explicit and auditable.
MANUAL_OVERRIDES = {
    "Kürnbergerwald": {
        "lat": 48.3020243,
        "lon": 14.21834,
        "elevation_m": None,
        "country": "AT",
        "feature_code": "OSM:landuse=forest",
        "geonames_id": None,
        "coordinate_source": "OpenStreetMap Nominatim, way 96803718",
        "coordinate_quality": "regional-centroid",
    },
    "Between Frankfurt-Höchst, -Sossenheim and Eschborn, Main-Taunus-Kreis": {
        "lat": 50.1244463,
        "lon": 8.5564932,
        "elevation_m": None,
        "country": "DE",
        "feature_code": "manual-centroid",
        "geonames_id": None,
        "coordinate_source": "Centroid of OSM results for Höchst, Sossenheim and Eschborn",
        "coordinate_quality": "approximate-centroid",
    },
}


def text(element: ET.Element, path: str) -> str | None:
    value = element.findtext(path, namespaces=NAMESPACES)
    return value.strip() if value else None


def fetch_geoname(geoname_id: str) -> dict:
    url = f"https://sws.geonames.org/{geoname_id}/about.rdf"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "IronAgeNetworkResearchPrototype/0.1"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        root = ET.fromstring(response.read())

    feature = root.find("gn:Feature", NAMESPACES)
    if feature is None:
        raise ValueError(f"GeoNames feature missing for {geoname_id}")

    lat = text(feature, "wgs84:lat")
    lon = text(feature, "wgs84:long")
    if lat is None or lon is None:
        raise ValueError(f"Coordinates missing for GeoNames {geoname_id}")

    feature_code_element = feature.find("gn:featureCode", NAMESPACES)
    feature_code = None
    if feature_code_element is not None:
        resource = feature_code_element.attrib.get(
            "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}resource", ""
        )
        feature_code = resource.rsplit("#", 1)[-1] or None

    altitude = text(feature, "wgs84:alt")
    return {
        "lat": float(lat),
        "lon": float(lon),
        "elevation_m": float(altitude) if altitude else None,
        "country": text(feature, "gn:countryCode"),
        "feature_code": feature_code,
        "geonames_id": geoname_id,
        "geonames_name": text(feature, "gn:name"),
        "coordinate_source": url,
        "coordinate_quality": "linked-gazetteer-place",
    }


def main() -> int:
    with SITES_CSV.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle, delimiter=";"))

    site_to_ids: dict[str, list[str]] = {}
    site_to_map_coords: dict[str, tuple[float, float]] = {}
    for row in rows:
        name = row["Name"].strip()
        if not name:
            continue
        site_to_ids.setdefault(name, [])
        site_to_ids[name].extend(GEONAMES_ID.findall(row["URI"]))
        map_match = GEONAMES_MAP.search(row["URI"])
        if map_match:
            site_to_map_coords[name] = (
                float(map_match.group(1)),
                float(map_match.group(2)),
            )

    existing = {}
    if OUTPUT.exists():
        existing = json.loads(OUTPUT.read_text(encoding="utf-8")).get("sites", {})

    results: dict[str, dict] = {}
    errors: dict[str, str] = {}
    for index, (name, ids) in enumerate(site_to_ids.items(), start=1):
        unique_ids = list(dict.fromkeys(ids))
        if name in MANUAL_OVERRIDES:
            results[name] = MANUAL_OVERRIDES[name]
        elif name in site_to_map_coords:
            lat, lon = site_to_map_coords[name]
            results[name] = {
                "lat": lat,
                "lon": lon,
                "elevation_m": None,
                "country": None,
                "feature_code": "GeoNames-map-coordinate",
                "geonames_id": None,
                "coordinate_source": "GeoNames map URL embedded in source CSV",
                "coordinate_quality": "linked-map-coordinate",
            }
        elif name in existing and existing[name].get("geonames_id") in unique_ids:
            results[name] = existing[name]
        elif unique_ids:
            try:
                results[name] = fetch_geoname(unique_ids[0])
                time.sleep(0.05)
            except Exception as exc:  # keep the remaining cache useful
                errors[name] = str(exc)
        else:
            errors[name] = "No GeoNames link and no manual override"

        if index % 25 == 0 or index == len(site_to_ids):
            print(f"{index}/{len(site_to_ids)} sites processed", file=sys.stderr)

    payload = {
        "source_csv": SITES_CSV.name,
        "method": "GeoNames Semantic Web RDF from linked IDs; explicit overrides for 2 rows",
        "sites": dict(sorted(results.items())),
        "errors": dict(sorted(errors.items())),
    }
    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "output": str(OUTPUT),
                "sites": len(results),
                "errors": len(errors),
            },
            ensure_ascii=False,
        )
    )
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
