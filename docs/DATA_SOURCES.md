# Data provenance and engineering limitations

## Verified public GIS sources

| Layer | Dataset and owner | Coverage and dates | Units / usage | Caveats |
|---|---|---|---|---|
| [Actual tax parcel polygons, **FeatureServer/1**](https://services6.arcgis.com/EbVsqZ18sv1kVJ3k/ArcGIS/rest/services/NYS_Tax_Parcels_Public/FeatureServer/1) | NYS Office of Information Technology Services Geospatial Services / county assessors | Albany is one of 38 participating NY counties; 2025 parcel assessments, published May 2026 | Polygon GeoJSON (WGS84); convert to EPSG:26918 (metres) to calculate acres | County coverage incomplete statewide; geometries and tax assessment attributes are not surveyed site boundaries |
| [Informational Freshwater Wetland Mapping, **FeatureServer/2**](https://services6.arcgis.com/DZHaqZm9cxOD4CWM/ArcGIS/rest/services/Informational_Freshwater_Wetland_Mapping/FeatureServer/2) | NYS Department of Environmental Conservation, ArcGIS hosted copy | Statewide informational wetlands; source last-edit 2026-09-17 | ArcGIS polygon intersection query against real parcel geometry; count flagged overlap | **Not regulatory.** Mapped boundaries neither establish jurisdiction nor exclude unmapped wetlands |
| [Esri World Imagery](https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer) | Esri and licensed aerial/satellite imagery providers | Varies by tile | Satellite basemap only | The basemap does **not** supply parcel geometries or screening measurements |

### Electric-grid feasibility sources inspected, not integrated

- [NYSERDA Integrated Energy Data Resource (IEDR)](https://iedr.nyserda.ny.gov/): statewide electric infrastructure, distributed energy resources, and hosting-capacity viewer. An interactive map and downloads are advertised, but direct machine-readable, geographically joinable data were **not verified for the MVP**.
- [New York Joint Utilities hosting-capacity portal](https://jointutilitiesofny.org/utility-specific-pages/hosting-capacity/): utility-specific hosting-capacity information. Coverage, values, limitations, and query interfaces vary by utility; not yet incorporated.

**Grid decision:** The UI shows **Not evaluated**, not a green score. Nearby lines or positive utility-hosting estimates alone would not demonstrate interconnection approval.

## Live GO/NO-GO proof (2026-11-21)

- Geographic query: western/rural Albany County bounding box, `[-74.18, 42.60, -73.85, 42.78]` in longitude/latitude, filtered by the actual county attribute.
- Parcel layer is **1**, not layer 0 (which represents county coverage footprints).
- Source returned **250** authentic parcel GeoJSON features.
- Python `Shapely` validated parcel polygons; `pyproj` calculated EPSG:26918 areas converted to acres. **141** met the 10-acre minimum.
- **25** returned parcel polygons were queried against the NYSDEC informational wetland service using ArcGIS server-side **polygon intersection**; **4** had mapped overlap.
- Runtime and JSON/GeoJSON proof: [GitHub Actions run](https://github.com/ritwiksi/gridplanner/actions/runs/44932471646). A later run committed `frontend/public/data/go_no_go.json` and `frontend/public/data/sample_candidates.geojson` to support demonstrations.
- The initial historic DEC `Wetlands/MapServer/0` query returned HTTP 404 from the runner. The current hosted NYSDEC informational layer was separately checked and succeeded. A third-party hosted wetland layer turned out to cover Putnam County only and was rejected.

## Live search limits

- Searches return at most 500 county-matched parcel features from the public service and carry a `query_limited` indicator if the cap is reached.
- Only up to 32 eligible parcels receive individual wetland queries per live search. The shortlist is ordered by distance to search center before wetland-screening, then by observed wetland overlap and distance. **This is not exhaustive land optimization.**
- Gross acreage is a first-pass heuristic, not area free of slopes, setbacks, built structures, existing uses, wetlands or conservation restrictions.
- The parcel attribute `ACRES` is used only as a loose source-side transfer filter, not as the final measured area. The engine recomputes polygon acres from GeoJSON.
- No numeric suitability score is emitted.

## Regulatory context

The NYSDEC informational wetlands layer states that the official determination for regulated wetlands requires NYSDEC review. A GIS overlay is a preliminary risk indicator only. Users must not use this prototype for acquisition, permitting, construction, or interconnection decisions without professional site diligence.
