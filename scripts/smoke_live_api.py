#!/usr/bin/env python3
"""End-to-end live public GIS smoke test. Never substitute invented GIS data."""
import json
import sys
from fastapi.testclient import TestClient
from backend.app import app

def main():
    with TestClient(app) as client:
        response = client.post("/api/search", json={
            "capacity_mw_ac": 2.0,
            "center_lat": 42.69,
            "center_lon": -73.88,
            "radius_miles": 12,
            "minimum_acres": 10,
        }, timeout=180)
        print("HTTP status:", response.status_code)
        if response.status_code != 200:
            print("GIS response:",response.text[:1000])
            sys.exit(1)
        data = response.json()
        summary = data["summary"]
        print("Live screening summary:",json.dumps(summary, indent=2))
        assert data["type"] == "FeatureCollection"
        assert data["features"], "Live GIS returned no eligible parcels"
        assert 0 < len(data["features"]) <= 32
        assert summary["wetlands_screened"] == len(data["features"])
        for feature in data["features"]:
            prop = feature["properties"]
            assert prop["gross_acres"] >= 14, "Capacity threshold missed"
            assert prop["wetland_flag"] is not None, "Environment not evaluated"
            assert prop["mapped_wetland_intersections"] >= 0
            assert prop["grid_status"] == "Not evaluated"
        print("PASS: real backend route -> parcel geometry -> wetland GIS -> GeoJSON output")

if __name__ == "__main__":
    main()
