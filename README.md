# GridSeeker

**Find the right land for clean energy.** A map-first, geospatial screening tool for ground-mounted solar developers.

GridSeeker helps you enter a preliminary project specification, query **real tax parcel geometry**, check mapped environmental constraints and investigate a shortlist of candidate parcels. It is an **early research tool**. No parcel is claimed to be buildable, for sale, permitted, or interconnectable.

## Verified GIS GO/NO-GO

The mandatory live-data feasibility run **passed on 2026-11-21**:

| Check | Executed result |
|---|---:|
| Authentic Albany-area NYS parcel polygons retrieved | 250 |
| Valid polygons meeting 10-acre projected-area filter | 141 |
| Parcel polygons checked against statewide NYSDEC informational wetlands | 25 |
| Parcels with a mapped wetland overlap | 4 |
| Coordinate system for geometry area | EPSG:26918, square metres converted to acres |

**[Inspect the successful GitHub Actions run](https://github.com/ritwiksi/gridplanner/actions/runs/44932471646).**

The verification script is `scripts/go_no_go.py`. The `frontend/public/data/` snapshot contains **actual observed** sample geometries and metadata generated from that test, rather than invented or simulated parcels. See [Data sources and limits](docs/DATA_SOURCES.md).

## Run locally

Requires Python 3.11+ and Node.js 20+.

```bash
git clone https://github.com/ritwiksi/gridplanner.git
cd gridplanner
python -m venv .venv
# Activate your venv first (Windows: .venv\\Scripts\\activate, macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
uvicorn backend.app:app --reload --port 8000
```

In **a second terminal**:

```bash
cd gridplanner/frontend
npm install
npm run dev
```

Open **http://localhost:5173**. Vite proxies `/api` to FastAPI at `http://127.0.0.1:8000`.

For a **single-server deployment**, use the included Dockerfile. Alternatively, run `npm run build` inside `frontend`, then start `uvicorn backend.app:app --host 0.0.0.0 --port 8000`; FastAPI serves the compiled frontend from `frontend/dist`.

## Product workflow

1. Define a proposed solar project in **MW AC**; the default is 2 MW AC.
2. Click on the map to move the search center, choose a search radius of 1–30 miles, and optionally set a minimum parcel area.
3. Select **Find sites** for a **live** backend query. GridSeeker fetches NYS tax parcel polygons from the state feature layer, calculates actual polygon areas in EPSG:26918, filters by gross acreage and distance, and executes wetland polygon intersection queries against a separate NYSDEC dataset.
4. Examine authentic parcel outlines, click a result, and review its area, mapped wetlands, grid-data uncertainty and unresolved development risks.
5. Compare up to three candidates or export a preliminary assessment as JSON.

If the live GIS query fails, the app **reports the failure**. It never silently invents or substitutes sites.

### Verified sample mode

The frontend contains a reproducible **25-parcel proof snapshot**, including 4 parcels flagged for mapped wetland overlap. This is helpful if external GIS services fail during a demo.

On local dev, the snapshot is initially visible and labeled **VERIFIED SAMPLE**; the Find sites button still requests fresh data. In a static GitHub Pages build (`GITHUB_PAGES=true npm run build`), the main button is labeled **Screen verified sample** and applies the active filters to only those 25 independently verified parcels. It never claims to search the entire county.

## Architecture

- **UI:** React, TypeScript, Vite, Leaflet; map-first satellite interface, polygon selection, assessments, and comparisons.
- **API:** FastAPI and Python; live NYS parcel query, geometry validation, NAD83 UTM projected acreage, geodesic radius filtering, and separate NYSDEC wetland spatial-intersection requests.
- **Offline presentation data:** Cached, genuine GeoJSON generated only after a successful GitHub Actions real-data test.
- **Tests:** Pytest checks for area calculations, geodesic bounds, ordering, input validation, error handling, and snapshot provenance; Playwright tests the browser workflow from project configuration through candidate selection and assessment.

```bash
python -m pytest tests -q
cd frontend
npm install
npm run build
npx playwright install chromium
npm run test:e2e
```

## Engineering assumptions and boundaries

- **Geographic scope:** Albany County, New York, only. The live search center and radius refine the query, not the underlying county coverage. The live endpoint returns a **sampled shortlist**, not an exhaustive county-wide inventory; its bounded results may omit parcels.
- **Land requirement:** Default gross-area screening heuristic of **7 acres per MW AC**. This is not an estimate of usable acreage. Parcel area is calculated from the geometry, not assumed from tax attributes.
- **Solar power:** A display-only **DC/AC ratio of 1.3**, with no generation or system efficiency forecast.
- **Wetlands:** Real polygon overlap with NYSDEC **informational**, non-regulatory wetlands mapping. No mapped overlap is not proof of wetland absence, and a mapped overlap does not settle permitting. A jurisdictional determination requires regulatory review.
- **Grid:** NYSERDA IEDR and Joint Utilities publishing portals are documented, but hosting capacity has **not been geographically integrated**. Nearby infrastructure and electrical availability are **not inferred**.
- **Not analyzed:** Parcel acquisition, zoning, conservation easements, setbacks, road access, terrain, geotechnical conditions, generation yield, utility interconnection queue, and project economics.

## Two-minute demo

Begin on the satellite map with a 2 MW AC solar project. Choose a 30-mile radius; run a search or explicitly filter the verified sample in a static build. Show authentic parcel boundaries, open an assessment and explain which screening facts are known versus unknown. Export one parcel report. The pitch is **reducing the time to a defensible early shortlist**, not certifying a construction-ready site.

---

Developed for a climate-and-energy hackathon. No user accounts, no fabricated 92%-suitable scores, and no generative feasibility claims.
