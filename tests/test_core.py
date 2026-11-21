"""Local deterministic tests; synthetic polygons are test fixtures only."""
import importlib
import json
from pathlib import Path

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from backend.core import (
    bounds_for_radius, parcel_area_acres, parcel_distance_miles,
    required_acres, sort_candidates,
)
from backend.app import SearchRequest

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "frontend/public/data/sample_candidates.geojson"
PROOF = ROOT / "frontend/public/data/go_no_go.json"

def test_land_hectares_and_minimum_area():
    assert required_acres(2) == 14
    assert required_acres(2, 19) == 19
    assert required_acres(2, 4) == 14
    with pytest.raises(ValueError):
        required_acres(-2)

def test_projected_polygon_acres():
    polygon = {"type": "Polygon", "coordinates": [[
        [-73.9, 42.7], [-73.89, 42.7],
        [-73.89, 42.71], [-73.9, 42.71], [-73.9, 42.7],
    ]]}
    area = parcel_area_acres(polygon)
    assert 180 < area < 300  # NY projected area, not raw geographic degrees
    assert parcel_distance_miles(polygon, -73.895, 42.705) < 0.1

def test_invalid_geometry_is_rejected():
    with pytest.raises(ValueError):
        parcel_area_acres({"type": "Point", "coordinates": [-73.9, 42.7]})

def test_radius_is_geographic_not_raw_degrees():
    west, south, east, north = bounds_for_radius(-73.7562, 42.6526, 30)
    assert west < -73.7562 < east
    assert south < 42.6526 < north
    with pytest.raises(ValueError):
        bounds_for_radius(-73.75, 42.65, 100)

def test_explainable_deterministic_ranking():
    items = [
        {"parcel_id": "3", "wetland_flag": True, "distance_miles": 1.0, "gross_acres": 100},
        {"parcel_id": "2", "wetland_flag": False, "distance_miles": 2.0, "gross_acres": 40},
        {"parcel_id": "1", "wetland_flag": False, "distance_miles": 2.0, "gross_acres": 50},
    ]
    assert [p["parcel_id"] for p in sort_candidates(items)] == ["1", "2", "3"]

def test_public_snapshot_is_real_proof_not_mocked_results():
    assert SAMPLE.exists(), "CI must commit a verified public-data sample"
    assert PROOF.exists()
    proof = json.loads(PROOF.read_text())
    sample = json.loads(SAMPLE.read_text())
    assert proof["status"] == "GO"
    assert proof["retrieved_count"] >= 20
    assert proof["valid_area_filtered_count"] >= 20
    assert proof["wetland_screened_count"] >= 20
    assert len(sample["features"]) == proof["wetland_screened_count"]
    ids = [f["properties"]["parcel_id"] for f in sample["features"]]
    assert len(ids) == len(set(ids))
    for site in sample["features"]:
        prop = site["properties"]
        assert site["geometry"]["type"] in ("Polygon", "MultiPolygon")
        assert prop["gross_acres"] >= proof["minimum_acres"]
        assert prop["wetland_flag"] == (prop["mapped_wetland_intersections"] > 0)
    assert sum(f["properties"]["wetland_flag"] for f in sample["features"]) == proof["wetland_flagged_count"]

def test_bad_user_input_rejected():
    with pytest.raises(ValidationError):
        SearchRequest(capacity_mw_ac=-1)
    with pytest.raises(ValidationError):
        SearchRequest(radius_miles=60)

def test_unavailable_api_fails_closed(monkeypatch):
    backend = importlib.import_module("backend.app")
    def fail(*args, **kwargs):
        raise RuntimeError("simulated upstream outage — test fixture only")
    monkeypatch.setattr(backend, "api_get", fail)
    with pytest.raises(HTTPException) as error:
        backend.search_sites(SearchRequest())
    assert error.value.status_code == 502
