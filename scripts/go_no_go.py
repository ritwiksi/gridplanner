#!/usr/bin/env python3
"""Mandatory GridSeeker GO/NO-GO: authentic Albany parcels + wetland intersection.

FAIL CLOSED: No simulated parcels, no cached fallback, no silently skipped sources.
Outputs are evidence for the MVP, not a declaration of buildable solar sites.
"""
from __future__ import annotations
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import requests
from pyproj import Transformer
from shapely.geometry import shape
from shapely.geometry.polygon import orient
from shapely.ops import transform

PARCELS = "https://services6.arcgis.com/EbVsqZ18sv1kVJ3k/ArcGIS/rest/services/NYS_Tax_Parcels_Public/FeatureServer/1/query"
WETLANDS = "https://services6.arcgis.com/DZHaqZm9cxOD4CWM/ArcGIS/rest/services/Informational_Freshwater_Wetland_Mapping/FeatureServer/2/query"
# Rural/western Albany County; Albany-specific WHERE clause avoids other counties.
BBOX = (-74.18, 42.60, -73.85, 42.78)
ACRE_M2 = 4046.8564224
PROJECTED_CRS = "EPSG:26918"  # NAD83 / UTM zone 18N, metres

def api_get(url, params):
    r = (requests.post(url, data=params, timeout=40, headers={"User-Agent": "GridSeeker research prototype (source-attributed)"})
         if url == WETLANDS else requests.get(url, params=params, timeout=40, headers={"User-Agent": "GridSeeker research prototype (source-attributed)"}))
    r.raise_for_status()
    data = r.json()
    if not isinstance(data, dict) or "error" in data:
        raise RuntimeError(f"ArcGIS error from {url}: {str(data)[:500]}")
    return data

def read_parcels(limit=250):
    params = {
        "f": "geojson",
        "where": "COUNTY_NAME = 'Albany' AND ACRES >= 5",
        "geometry": ",".join(map(str, BBOX)),
        "geometryType": "esriGeometryEnvelope",
        "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
        "outSR": 4326,
        "outFields": "OBJECTID,COUNTY_NAME,PRINT_KEY,SBL,SWIS,ACRES,PARCEL_ADDR,MUNI_NAME",
        "orderByFields": "OBJECTID ASC",
        "returnGeometry": "true",
        "resultRecordCount": limit,
    }
    data = api_get(PARCELS, params)
    if data.get("type") != "FeatureCollection":
        raise RuntimeError("Parcel endpoint did not return a GeoJSON FeatureCollection")
    if len(data.get("features", [])) < 20:
        raise RuntimeError(f"Only {len(data.get('features', []))} parcels retrieved: require >=20")
    return data["features"]

def esri_polygon(geometry):
    """Correct Esri outer/inner ring orientation for spatial queries."""
    parts = [geometry] if geometry.geom_type == "Polygon" else list(geometry.geoms)
    rings = []
    for part in parts:
        oriented = orient(part, sign=-1.0)
        rings.append([list(x) for x in oriented.exterior.coords])
        for hole in oriented.interiors:
            rings.append([list(x) for x in hole.coords])
    return {"rings": rings, "spatialReference": {"wkid": 4326}}

def wetland_intersections(geometry):
    # ArcGIS server executes a true polygon intersection, not a bounding-box proxy.
    params = {
        "f": "json", "where": "1=1",
        "geometry": json.dumps(esri_polygon(geometry), separators=(",", ":")),
        "geometryType": "esriGeometryPolygon",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "returnCountOnly": "true",
    }
    result = api_get(WETLANDS, params)
    count = result.get("count")
    if not isinstance(count, int) or count < 0:
        raise RuntimeError(f"Wetland count was not valid: {str(result)[:400]}")
    return count

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--min-acres", type=float, default=10.0)
    parser.add_argument("--check-count", type=int, default=25)
    args = parser.parse_args()
    if args.min_acres <= 0 or args.check_count < 20:
        parser.error("--min-acres must be positive; --check-count must be at least 20")
    all_parcels = read_parcels()
    transformer = Transformer.from_crs("EPSG:4326", PROJECTED_CRS, always_xy=True)
    verified = []
    skipped = 0
    for feature in all_parcels:
        prop = feature.get("properties") or {}
        if prop.get("OBJECTID") is None or not feature.get("geometry"):
            skipped += 1
            continue
        polygon = shape(feature["geometry"])
        if polygon.geom_type not in ("Polygon", "MultiPolygon") or polygon.is_empty or not polygon.is_valid:
            skipped += 1
            continue
        area = transform(transformer.transform, polygon).area / ACRE_M2
        if not (0 < area < 100_000):
            skipped += 1
            continue
        if area < args.min_acres:
            continue
        verified.append((feature, polygon, area))
    if len(verified) < 20:
        raise RuntimeError(f"Only {len(verified)} valid parcels >= {args.min_acres} acres; require 20. Skipped invalid={skipped}")
    candidates = []
    for feature, poly, acres in verified[:args.check_count]:
        wetland_count = wetland_intersections(poly)
        props = feature["properties"]
        candidates.append({
            "parcel_id": str(props["OBJECTID"]),
            "print_key": props.get("PRINT_KEY") or props.get("SBL"),
            "address": props.get("PARCEL_ADDR"),
            "municipality": props.get("MUNI_NAME"),
            "gross_acres": round(acres, 3),
            "mapped_wetland_intersections": wetland_count,
            "wetland_flag": wetland_count > 0,
            "geometry": feature["geometry"],
        })
    if len(candidates) < 20:
        raise RuntimeError("Less than 20 independently screened parcels")
    result = {
        "status": "GO",
        "verified_at_utc": datetime.now(timezone.utc).isoformat(),
        "parcel_source": PARCELS,
        "environmental_source": WETLANDS,
        "parcel_feature_layer": 1,
        "bbox_wgs84": BBOX,
        "projected_crs": PROJECTED_CRS,
        "area_units": "acres",
        "minimum_acres": args.min_acres,
        "retrieved_count": len(all_parcels),
        "valid_area_filtered_count": len(verified),
        "wetland_screened_count": len(candidates),
        "wetland_flagged_count": sum(x["wetland_flag"] for x in candidates),
        "invalid_or_incomplete_count": skipped,
        "grid_data": "NOT EVALUATED",
        "limitations": [
            "NYS DEC informational wetland mapping is not regulatory; overlap is a risk flag, not a jurisdictional determination.",
            "Gross area is not estimated usable acreage or evidence of sufficient interconnection capacity.",
            "The source is a query-limited sample, not an exhaustive county-wide site search.",
        ],
        "candidates": [{k: v for k,v in c.items() if k != "geometry"} for c in candidates],
    }
    output = Path("outputs")
    output.mkdir(exist_ok=True)
    (output / "go_no_go.json").write_text(json.dumps(result, indent=2) + "\n")
    features = [
        {"type": "Feature", "geometry": c["geometry"],
         "properties": {k: v for k,v in c.items() if k != "geometry"}}
        for c in candidates
    ]
    (output / "sample_candidates.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    print(json.dumps({k:v for k,v in result.items() if k != "candidates"}, indent=2))
    print("GO: real polygons, projected acres, area filtering, and authoritative wetland spatial intersection verified.")

if __name__ == "__main__":
    main()
