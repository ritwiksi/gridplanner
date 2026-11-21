"""Deterministic, unit-tested GIS calculations for GridSeeker."""
from __future__ import annotations

from pyproj import Geod, Transformer
from shapely.geometry import shape
from shapely.ops import transform

ACRE_M2 = 4046.8564224
CRS = "EPSG:26918"
GEOD = Geod(ellps="WGS84")
TRANSFORMER = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
LAND_ACRES_PER_MW_AC = 7.0  # Conservative preliminary gross-parcel screening heuristic.

def required_acres(capacity_mw_ac: float, explicit_min_acres: float | None = None) -> float:
    if not 0.1 <= capacity_mw_ac <= 20:
        raise ValueError("Capacity must be between 0.1 and 20 MW AC")
    return max(LAND_ACRES_PER_MW_AC * capacity_mw_ac, explicit_min_acres or 0)

def bounds_for_radius(lon: float, lat: float, radius_miles: float) -> tuple[float, float, float, float]:
    if not 1 <= radius_miles <= 30:
        raise ValueError("Search radius must be between 1 and 30 miles")
    meters = radius_miles * 1609.344
    east, _lat, _ = GEOD.fwd(lon, lat, 90, meters)
    west, _lat, _ = GEOD.fwd(lon, lat, 270, meters)
    _lon, north, _ = GEOD.fwd(lon, lat, 0, meters)
    _lon, south, _ = GEOD.fwd(lon, lat, 180, meters)
    return west, south, east, north

def parcel_area_acres(geometry: dict) -> float:
    polygon = shape(geometry)
    if polygon.is_empty or polygon.geom_type not in {"Polygon", "MultiPolygon"} or not polygon.is_valid:
        raise ValueError("Invalid parcel polygon")
    return transform(TRANSFORMER.transform, polygon).area / ACRE_M2

def parcel_distance_miles(geometry: dict, lon: float, lat: float) -> float:
    polygon = shape(geometry)
    center = polygon.centroid
    _bearing, _reverse, meters = GEOD.inv(lon, lat, center.x, center.y)
    return meters / 1609.344

def sort_candidates(candidates: list[dict]) -> list[dict]:
    # This is an ordering, not an invented 'suitability percentage'.
    return sorted(
        candidates,
        key=lambda p: (
            bool(p["wetland_flag"]),
            round(float(p["distance_miles"]), 6),
            -float(p["gross_acres"]),
            str(p["parcel_id"]),
        ),
    )
