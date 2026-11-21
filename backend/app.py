"""GridSeeker HTTP API. All search results are calculated from live public GIS.

Run: uvicorn backend.app:app --reload
The included 25-parcel verified demo snapshot is for presentation when offline,
not silently substituted for a failed live search.
"""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.core import (
    bounds_for_radius, parcel_area_acres, parcel_distance_miles,
    required_acres, sort_candidates,
)
from scripts.go_no_go import PARCELS, WETLANDS, api_get, esri_polygon, wetland_intersections

SOURCE_FIELDS = "OBJECTID,COUNTY_NAME,PRINT_KEY,SBL,SWIS,ACRES,PARCEL_ADDR,MUNI_NAME"
BATCH_LIMIT = 500
ENVIRONMENT_LIMIT = 32
DC_AC_RATIO = 1.3  # Illustrative only. No usable-area or generation estimate.

app = FastAPI(title="GridSeeker", version="0.1.0",
              description="Exploratory solar parcel screening using authentic New York State GIS.")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

class SearchRequest(BaseModel):
    capacity_mw_ac: float = Field(default=2, ge=0.1, le=20)
    center_lat: float = Field(default=42.6526, ge=42.40, le=43.0)
    center_lon: float = Field(default=-73.7562, ge=-74.45, le=-73.3)
    radius_miles: float = Field(default=30, ge=1, le=30)
    minimum_acres: float | None = Field(default=None, ge=0.5, le=2000)

@app.get("/api/health")
def health():
    return {"status": "ok", "service": "GridSeeker", "region": "Albany County, New York",
            "grid_screening": "not evaluated"}

@app.post("/api/search")
def search_sites(search: SearchRequest):
    min_acres = required_acres(search.capacity_mw_ac, search.minimum_acres)
    west, south, east, north = bounds_for_radius(
        search.center_lon, search.center_lat, search.radius_miles
    )
    # Attribute ACRES only reduces network load. Final filtering always uses actual
    # projected polygon area; the looser threshold minimizes false exclusions.
    where = f"COUNTY_NAME = 'Albany' AND ACRES >= {max(1, min_acres * 0.5):.3f}"
    params = {
        "f": "geojson", "where": where,
        "geometry": f"{west},{south},{east},{north}",
        "geometryType": "esriGeometryEnvelope", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects", "outSR": 4326,
        "outFields": SOURCE_FIELDS, "returnGeometry": "true",
        "orderByFields": "OBJECTID ASC",
        "resultRecordCount": BATCH_LIMIT,
    }
    try:
        geo = api_get(PARCELS, params)
    except (requests.RequestException, RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"Public NYS parcel service unavailable: {str(exc)[:200]}") from exc
    if geo.get("type") != "FeatureCollection":
        raise HTTPException(status_code=502, detail="Parcel service returned an unexpected format")

    eligible = []
    invalid_count = 0
    for feature in geo.get("features", []):
        attrs = feature.get("properties") or {}
        geometry = feature.get("geometry")
        if geometry is None or attrs.get("OBJECTID") is None:
            invalid_count += 1
            continue
        try:
            acres = parcel_area_acres(geometry)
            distance = parcel_distance_miles(
                geometry, search.center_lon, search.center_lat
            )
        except (ValueError, TypeError):
            invalid_count += 1
            continue
        if acres < min_acres or distance > search.radius_miles:
            continue
        eligible.append({
            "parcel_id": str(attrs["OBJECTID"]),
            "print_key": attrs.get("PRINT_KEY") or attrs.get("SBL"),
            "address": attrs.get("PARCEL_ADDR") or None,
            "municipality": attrs.get("MUNI_NAME") or None,
            "gross_acres": round(acres, 2),
            "distance_miles": round(distance, 2),
            "wetland_flag": None,
            "mapped_wetland_intersections": None,
            "geometry": geometry,
        })
    eligible.sort(key=lambda x: (x["distance_miles"], -x["gross_acres"], x["parcel_id"]))
    shortlist = eligible[:ENVIRONMENT_LIMIT]
    # A failed wetlands query is an error, not evidence of no wetlands.
    if shortlist:
        try:
            with ThreadPoolExecutor(max_workers=8) as pool:
                counts = list(pool.map(
                    lambda entry: wetland_intersections_from_geojson(entry["geometry"]),
                    shortlist,
                ))
        except (requests.RequestException, RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=502, detail=f"NYSDEC wetlands verification failed: {str(exc)[:200]}") from exc
        for site, count in zip(shortlist, counts):
            site["mapped_wetland_intersections"] = count
            site["wetland_flag"] = count > 0

    ranked = sort_candidates(shortlist)
    features = []
    for index, site in enumerate(ranked, 1):
        props = {k: v for k, v in site.items() if k != "geometry"}
        props.update({
            "rank": index,
            "estimated_usable_acres": None,
            "grid_status": "Not evaluated",
            "screening_basis": "Gross parcel area and NYSDEC informational wetland polygon intersection",
        })
        features.append({"type": "Feature", "id": site["parcel_id"],
                         "properties": props, "geometry": site["geometry"]})
    return {
        "mode": "live",
        "type": "FeatureCollection",
        "features": features,
        "query": search.model_dump(),
        "project": {"capacity_mw_ac": search.capacity_mw_ac,
                    "illustrative_dc_mw": round(DC_AC_RATIO * search.capacity_mw_ac, 2),
                    "assumed_dc_ac_ratio": DC_AC_RATIO,
                    "gross_parcel_screening_acres": round(min_acres, 2),
                    "land_assumption_acres_per_mw_ac": 7.0},
        "summary": {
            "retrieved": len(geo["features"]),
            "above_area_and_within_radius": len(eligible),
            "wetlands_screened": len(features),
            "wetland_flags": sum(bool(f["properties"]["wetland_flag"]) for f in features),
            "invalid_geometries": invalid_count,
            "query_limited": bool(geo.get("exceededTransferLimit")) or len(geo["features"]) >= BATCH_LIMIT,
        },
        "sources": {"parcels": PARCELS, "informational_wetlands": WETLANDS},
        "limitations": [
            "Results are a query-limited shortlist in Albany County, not an exhaustive search.",
            "Wetland intersections are screening flags, not regulatory determinations.",
            "Gross area is not developable area; setbacks, terrain, zoning, and ownership remain unevaluated.",
            "Hosting capacity and interconnection are not evaluated.",
        ],
    }

def wetland_intersections_from_geojson(geometry: dict) -> int:
    from shapely.geometry import shape
    return wetland_intersections(shape(geometry))

DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"
if DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=str(DIST / "assets")), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        candidate = (DIST / path).resolve()
        if candidate.is_file() and candidate.is_relative_to(DIST.resolve()):
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")
