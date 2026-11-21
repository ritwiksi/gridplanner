/** Live GIS screening in the browser, so GitHub Pages needs no backend.
 *  Every geometry and wetland flag comes from public ArcGIS services.
 *  Result bounds and omitted checks are disclosed; NEVER synthesize parcels.
 */
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import proj4 from 'proj4';

export const PARCEL_SOURCE = 'https://services6.arcgis.com/EbVsqZ18sv1kVJ3k/ArcGIS/rest/services/NYS_Tax_Parcels_Public/FeatureServer/1/query';
export const WETLAND_SOURCE = 'https://services6.arcgis.com/DZHaqZm9cxOD4CWM/ArcGIS/rest/services/Informational_Freshwater_Wetland_Mapping/FeatureServer/2/query';
proj4.defs('NAD83-UTM18', '+proj=utm +zone=18 +datum=NAD83 +units=m +no_defs +type=crs');

export type SearchInput = {
  capacity_mw_ac: number;
  center_lat: number;
  center_lon: number;
  radius_miles: number;
  minimum_acres: number | null;
};
export type SiteProps = {
  parcel_id: string; print_key: string | null; address: string | null;
  municipality: string | null; gross_acres: number; distance_miles: number;
  wetland_flag: boolean | null; mapped_wetland_intersections: number | null;
  grid_status: string; rank?: number;
} & Record<string, unknown>;
export type Candidate = Feature<Geometry, SiteProps>;
type ArcFeature = Feature<Geometry, Record<string, unknown>>;
type ArcCollection = FeatureCollection<Geometry, Record<string, unknown>>;
const ACRE_M2 = 4046.8564224;
const MI_TO_M = 1609.344;
const TILE_COLS = 3;
const TILE_ROWS = 3;
const TILE_MAX = 275;
const ENV_MAX = 32;

function assertArcGIS(data: unknown, endpoint: string): Record<string, unknown> {
  if (!data || typeof data !== 'object') throw new Error('Invalid response from ' + endpoint);
  const x = data as Record<string, unknown>;
  if (x.error) throw new Error(endpoint + ': ' + JSON.stringify(x.error).slice(0, 300));
  return x;
}

async function request(url: string, params: URLSearchParams, post = false): Promise<Record<string, unknown>> {
  // Urlencoded form POST is a simple CORS request and avoids long polygon URLs.
  const response = await fetch(post ? url : url + '?' + params.toString(), {
    method: post ? 'POST' : 'GET',
    ...(post ? {headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: params} : {}),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error('Public GIS HTTP ' + response.status + ' at ' + new URL(url).hostname);
  return assertArcGIS(await response.json(), new URL(url).hostname);
}

function latLonBounds(lon: number, lat: number, miles: number): [number, number, number, number] {
  const dlat = miles / 69.05;
  const dlon = miles / (69.05 * Math.max(0.25, Math.cos(lat * Math.PI / 180)));
  return [lon - dlon, lat - dlat, lon + dlon, lat + dlat];
}

function rings(geometry: Geometry): number[][][][] {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}
function utmRingArea(ring: number[][]): number {
  if (ring.length < 4) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = proj4('EPSG:4326', 'NAD83-UTM18', ring[i]);
    const b = proj4('EPSG:4326', 'NAD83-UTM18', ring[i+1]);
    sum += a[0]*b[1] - b[0]*a[1];
  }
  return Math.abs(sum / 2);
}
function areaAcres(geometry: Geometry): number {
  return rings(geometry).reduce((sum, polygon) => (
    sum + Math.max(0, utmRingArea(polygon[0]) -
      polygon.slice(1).reduce((holes, ring) => holes + utmRingArea(ring), 0))
  ), 0) / ACRE_M2;
}
function centroid(geometry: Geometry): [number, number] {
  const primary = rings(geometry)[0]?.[0];
  if (!primary?.length) return [0, 0];
  const points = primary.slice(0, -1);
  // Use the polygon's geographic area-weighted centroid (not its bbox center).
  let signed = 0; let x = 0; let y = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i+1)%points.length];
    const cross = a[0]*b[1] - b[0]*a[1];
    signed += cross; x += (a[0] + b[0])*cross; y += (a[1] + b[1])*cross;
  }
  if (Math.abs(signed) < 1e-12) return points[0] as [number, number];
  return [x/(3*signed), y/(3*signed)];
}
function distanceMiles(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const rad = Math.PI / 180, dlat = (lat2-lat1)*rad, dlon = (lon2-lon1)*rad;
  const a = Math.sin(dlat/2)**2 + Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin(dlon/2)**2;
  return 3958.7613 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
function signedRingArea(ring: number[][]): number {
  let n=0;
  for (let i=0;i<ring.length-1;i++) n += ring[i][0]*ring[i+1][1]-ring[i+1][0]*ring[i][1];
  return n/2;
}
function toEsriPolygon(geometry: Geometry): Record<string, unknown> {
  const converted: number[][][] = [];
  for (const polygon of rings(geometry)) {
    polygon.forEach((ring, i) => {
      const isCCW = signedRingArea(ring) > 0;
      const wantCCW = i > 0; // ArcGIS rings: exterior clockwise, interior counterclockwise
      converted.push(isCCW === wantCCW ? ring : [...ring].reverse());
    });
  }
  return {rings: converted, spatialReference: {wkid: 4326}};
}

async function parcelTile(bounds: [number, number, number, number], minAcres: number): Promise<ArcCollection> {
  const q = new URLSearchParams({
    f: 'geojson', where: "COUNTY_NAME = 'Albany' AND ACRES >= " + Math.max(1, minAcres * 0.5).toFixed(3),
    geometry: bounds.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', outSR: '4326',
    outFields: 'OBJECTID,COUNTY_NAME,PRINT_KEY,SBL,SWIS,ACRES,PARCEL_ADDR,MUNI_NAME',
    orderByFields: 'OBJECTID ASC', returnGeometry: 'true', resultRecordCount: String(TILE_MAX),
  });
  const data = await request(PARCEL_SOURCE, q);
  if (data.type !== 'FeatureCollection' || !Array.isArray(data.features))
    throw new Error('Parcel service did not return GeoJSON features.');
  return data as unknown as ArcCollection;
}

async function wetlandCount(geometry: Geometry): Promise<number> {
  const params = new URLSearchParams({
    f: 'json', where: '1=1', geometry: JSON.stringify(toEsriPolygon(geometry)),
    geometryType: 'esriGeometryPolygon', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', returnCountOnly: 'true',
  });
  const data = await request(WETLAND_SOURCE, params, true);
  if (!Number.isInteger(data.count) || Number(data.count) < 0)
    throw new Error('NYSDEC wetland query did not return a valid intersection count.');
  return Number(data.count);
}

export type LiveResponse = {
  type: 'FeatureCollection'; mode: 'live'; features: Candidate[];
  summary: { retrieved: number; above_area_and_within_radius: number;
    wetlands_screened: number; wetland_flags: number; query_limited: boolean; tiles_checked: number; };
  sources: { parcels: string; informational_wetlands: string };
  limitations: string[];
};

export async function searchPublicGIS(input: SearchInput): Promise<LiveResponse> {
  if (!(input.capacity_mw_ac > 0 && input.capacity_mw_ac <= 20) ||
      !(input.radius_miles > 0 && input.radius_miles <= 30))
    throw new Error('Invalid solar project capacity or radius.');
  const minAcres = Math.max(input.capacity_mw_ac * 7, input.minimum_acres || 0);
  const [west, south, east, north] = latLonBounds(input.center_lon, input.center_lat, input.radius_miles);
  const tileBbox: [number, number, number, number][] = [];
  for (let row = 0; row < TILE_ROWS; row++) for (let col = 0; col < TILE_COLS; col++) {
    tileBbox.push([
      west + (east - west)*col/TILE_COLS,
      south + (north - south)*row/TILE_ROWS,
      west + (east - west)*(col+1)/TILE_COLS,
      south + (north - south)*(row+1)/TILE_ROWS,
    ]);
  }
  // Tiling avoids selecting only the first 500 alphabetically/ID-sorted county parcels.
  const batches = await Promise.all(tileBbox.map(box => parcelTile(box, minAcres)));
  const raw = new Map<string, ArcFeature>();
  let capped = false;
  for (const batch of batches) {
    if (batch.features.length >= TILE_MAX || Boolean((batch as unknown as Record<string, unknown>).exceededTransferLimit)) capped = true;
    for (const feature of batch.features) {
      const id = feature.properties?.OBJECTID;
      if (id !== undefined && id !== null && feature.geometry && !raw.has(String(id)))
        raw.set(String(id), feature);
    }
  }

  const eligible: Candidate[] = [];
  for (const feature of raw.values()) {
    try {
      const gross = areaAcres(feature.geometry);
      if (!(gross >= minAcres) || !Number.isFinite(gross) || gross > 100000) continue;
      const [lon, lat] = centroid(feature.geometry);
      const dist = distanceMiles(input.center_lon, input.center_lat, lon, lat);
      if (dist > input.radius_miles || !Number.isFinite(dist)) continue;
      const p = feature.properties;
      eligible.push({
        type: 'Feature', id: String(p.OBJECTID), geometry: feature.geometry,
        properties: {
          parcel_id: String(p.OBJECTID),
          print_key: String(p.PRINT_KEY || p.SBL || '') || null,
          address: String(p.PARCEL_ADDR || '') || null,
          municipality: String(p.MUNI_NAME || '') || null,
          gross_acres: Math.round(gross*100)/100,
          distance_miles: Math.round(dist*100)/100,
          wetland_flag: null, mapped_wetland_intersections: null, grid_status: 'Not evaluated',
        },
      });
    } catch { /* Broken geometry is omitted, never replaced or fabricated. */ }
  }
  // Initial ranking uses distance and actual land size; do not claim this is a final suitability grade.
  eligible.sort((a, b) =>
    a.properties.distance_miles - b.properties.distance_miles ||
    b.properties.gross_acres - a.properties.gross_acres ||
    a.properties.parcel_id.localeCompare(b.properties.parcel_id));
  const shortlist = eligible.slice(0, ENV_MAX);

  // Run independent wetland intersection queries, with only 6 requests in flight.
  let index = 0;
  async function screenWorker() {
    while (index < shortlist.length) {
      const i = index++;
      const count = await wetlandCount(shortlist[i].geometry);
      shortlist[i].properties.mapped_wetland_intersections = count;
      shortlist[i].properties.wetland_flag = count > 0;
    }
  }
  await Promise.all(Array.from({length: Math.min(6, shortlist.length)}, () => screenWorker()));
  shortlist.sort((a, b) =>
    Number(Boolean(a.properties.wetland_flag)) - Number(Boolean(b.properties.wetland_flag)) ||
    a.properties.distance_miles - b.properties.distance_miles ||
    b.properties.gross_acres - a.properties.gross_acres);
  shortlist.forEach((site, i) => { site.properties.rank = i+1; });
  return {
    type: 'FeatureCollection', mode: 'live', features: shortlist,
    summary: {
      retrieved: raw.size, above_area_and_within_radius: eligible.length,
      wetlands_screened: shortlist.length,
      wetland_flags: shortlist.filter(x => x.properties.wetland_flag).length,
      query_limited: capped || eligible.length > ENV_MAX, tiles_checked: tileBbox.length,
    },
    sources: {parcels: PARCEL_SOURCE, informational_wetlands: WETLAND_SOURCE},
    limitations: [
      'Search uses nine bounded geographic tiles and screens the 32 closest qualifying properties for mapped wetlands.',
      'Large or dense tiles may hit parcel query limits; a result is a preliminary shortlist, not a county-wide inventory.',
      'Gross area is not usable or buildable land; setbacks, zoning, ownership, and terrain remain unevaluated.',
      'NYSDEC wetlands map is informational only; grid interconnection and capacity are not evaluated.',
    ],
  };
}
