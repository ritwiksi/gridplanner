import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import {
  ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronRight, Database,
  Download, ExternalLink, Info, Layers, MapPin, RefreshCw, Search,
  SlidersHorizontal, Sun, X, GitCompareArrows, AlertTriangle, Compass,
} from 'lucide-react';

type SiteProperties = {
  parcel_id: string;
  print_key: string | null;
  address: string | null;
  municipality: string | null;
  gross_acres: number;
  distance_miles?: number;
  wetland_flag: boolean | null;
  mapped_wetland_intersections: number | null;
  grid_status?: string;
  rank?: number;
} & Record<string, unknown>;
type Site = Feature<Geometry, SiteProperties>;
type SearchResponse = {
  type: 'FeatureCollection';
  features: Site[];
  summary: { retrieved: number; above_area_and_within_radius: number;
    wetlands_screened: number; wetland_flags: number; query_limited: boolean };
};
type SearchMode = 'sample' | 'live';
const ALBANY: [number, number] = [42.6526, -73.7562];
// GitHub Pages serves only the explicitly labeled, independently verified sample.
const STATIC_DEMO = import.meta.env.BASE_URL !== '/' && !import.meta.env.VITE_API_URL;
const LAND_PER_MW_AC = 7;

function centroid(site: Site): [number, number] {
  const g = site.geometry;
  const ring = g.type === 'Polygon' ? g.coordinates[0] :
    g.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
  if (!ring?.length) return ALBANY;
  let twiceArea = 0; let cx = 0; let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]; const b = ring[i + 1];
    const cross = a[0] * b[1] - b[0] * a[1];
    twiceArea += cross;
    cx += (a[0] + b[0]) * cross; cy += (a[1] + b[1]) * cross;
  }
  if (Math.abs(twiceArea) < 1e-12) return [ring[0][1], ring[0][0]];
  return [cy / (3 * twiceArea), cx / (3 * twiceArea)];
}

function milesBetween(a: [number, number], b: [number, number]): number {
  const toRadian = (n: number) => n * Math.PI / 180;
  const dLat = toRadian(a[0] - b[0]); const dLon = toRadian(a[1] - b[1]);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadian(a[0])) * Math.cos(toRadian(b[0])) * Math.sin(dLon / 2) ** 2;
  return 3958.7613 * 2 * Math.asin(Math.min(1, Math.sqrt(x)));
}

function titleOf(site: Site): string {
  return site.properties.address?.trim() ||
    ('Parcel ' + (site.properties.print_key || site.properties.parcel_id));
}

function downloadAssessment(site: Site, projectMW: number, mode: SearchMode) {
  const p = site.properties;
  const report = {
    tool: 'GridSeeker', category: 'Preliminary screening only',
    origin: mode === 'sample' ? 'Verified 25-parcel NYSDEC/NYS tax parcel snapshot' : 'Live public GIS queries',
    parcel: { id: p.parcel_id, print_key: p.print_key, address: p.address,
      municipality: p.municipality, gross_acres: p.gross_acres },
    proposed_project: { capacity_mw_ac: projectMW,
      assumed_dc_ac_ratio: 1.3, illustrative_dc_capacity_mw: projectMW * 1.3,
      assumed_gross_acres_per_mw_ac: LAND_PER_MW_AC },
    mapped_wetland_intersections: p.mapped_wetland_intersections,
    environmental_note: 'Informational NYSDEC mapped overlap; not a regulatory determination.',
    grid_status: 'Not evaluated',
    unassessed: ['Site acquisition and land rights', 'Zoning and permits',
      'Detailed wetland delineation', 'Setbacks and usable land',
      'Terrain and geotechnical conditions', 'Grid interconnection and queue'],
    sources: {
      parcels: 'https://services6.arcgis.com/EbVsqZ18sv1kVJ3k/ArcGIS/rest/services/NYS_Tax_Parcels_Public/FeatureServer/1',
      wetlands: 'https://services6.arcgis.com/DZHaqZm9cxOD4CWM/ArcGIS/rest/services/Informational_Freshwater_Wetland_Mapping/FeatureServer/2',
    },
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url;
  link.download = 'gridseeker-parcel-' + p.parcel_id + '.json'; link.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const mapElement = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const overlays = useRef<L.GeoJSON | null>(null);
  const originMarker = useRef<L.CircleMarker | null>(null);
  const onMapSelect = useRef<(id: string) => void>(() => {});

  const [capacity, setCapacity] = useState(2);
  const [radius, setRadius] = useState(30);
  const [extraMin, setExtraMin] = useState('');
  const [center, setCenter] = useState<[number, number]>(ALBANY);
  const [sample, setSample] = useState<Site[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [mode, setMode] = useState<SearchMode>('sample');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comparison, setComparison] = useState<string[]>([]);
  const [showComparison, setShowComparison] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<SearchResponse['summary'] | null>(null);
  const [sampleDate, setSampleDate] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  const required = Math.max(capacity * LAND_PER_MW_AC, Number(extraMin) || 0);
  const selected = useMemo(() => sites.find(s => s.properties.parcel_id === selectedId) ?? null, [sites, selectedId]);
  const compared = useMemo(() => comparison.map(id => sites.find(s => s.properties.parcel_id === id)).filter((x): x is Site => Boolean(x)), [sites, comparison]);

  useEffect(() => {
    if (!mapElement.current || map.current) return;
    const instance = L.map(mapElement.current, {
      zoomControl: false, scrollWheelZoom: true, preferCanvas: true,
    }).setView([42.69, -73.88], 11);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community',
    }).addTo(instance);
    L.control.zoom({ position: 'bottomright' }).addTo(instance);
    instance.on('click', e => setCenter([e.latlng.lat, e.latlng.lng]));
    map.current = instance;
    window.setTimeout(() => instance.invalidateSize(), 150);
    return () => { instance.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    if (!map.current) return;
    originMarker.current?.remove();
    originMarker.current = L.circleMarker(center, {
      radius: 6, weight: 2.5, color: '#ffffff', fillColor: '#18d7be',
      fillOpacity: 1,
    }).addTo(map.current).bindTooltip('Project search center — click map to move', { direction: 'top' });
  }, [center]);

  useEffect(() => {
    const controller = new AbortController();
    const base = import.meta.env.BASE_URL;
    Promise.all([
      fetch(base + 'data/sample_candidates.geojson', { signal: controller.signal }).then(r => {
        if (!r.ok) throw new Error('Verified sample unavailable'); return r.json();
      }),
      fetch(base + 'data/go_no_go.json', { signal: controller.signal }).then(r => r.ok ? r.json() : null),
    ]).then(([geo, audit]: [FeatureCollection<Geometry, SiteProperties>, { verified_at_utc?: string } | null]) => {
      const features = geo.features.filter(f => Boolean(f.geometry && f.properties?.parcel_id)) as Site[];
      setSample(features); setSampleDate(audit?.verified_at_utc ?? null);
      // Show verified geography on first visit. This is NOT a live query.
      setSites(features); setSummary(null);
    }).catch(e => { if (e.name !== 'AbortError') setError('The verified demonstration sample could not be loaded.'); });
    return () => controller.abort();
  }, []);

  onMapSelect.current = setSelectedId;
  useEffect(() => {
    if (!map.current) return;
    overlays.current?.remove();
    const displayed = L.geoJSON({
      type: 'FeatureCollection', features: sites,
    } as FeatureCollection<Geometry, SiteProperties>, {
      style: feature => {
        const id = String(feature?.properties?.parcel_id ?? '');
        const risk = Boolean(feature?.properties?.wetland_flag);
        const active = id === selectedId;
        return {
          color: active ? '#ffffff' : risk ? '#f2bb74' : '#26e2c4',
          fillColor: active ? '#21e7c9' : risk ? '#e7a957' : '#13bda7',
          weight: active ? 3.2 : 1.8, opacity: 1,
          fillOpacity: active ? 0.42 : risk ? 0.19 : 0.24,
        };
      },
      onEachFeature: (feature, layer) => {
        const props = feature.properties as SiteProperties;
        layer.bindTooltip(
          (props.print_key || ('Parcel ' + props.parcel_id)) +
          ' · ' + Number(props.gross_acres).toFixed(1) + ' ac',
          { sticky: true, direction: 'top' },
        );
        layer.on('click', e => {
          L.DomEvent.stopPropagation(e);
          onMapSelect.current(props.parcel_id);
        });
      },
    }).addTo(map.current);
    overlays.current = displayed;
    return () => { displayed.remove(); };
  }, [sites, selectedId]);

  useEffect(() => {
    if (!selected || !map.current) return;
    const target = L.geoJSON(selected);
    const bounds = target.getBounds();
    if (bounds.isValid()) map.current.flyToBounds(bounds.pad(0.7), { duration: 0.8, maxZoom: 15 });
  }, [selected]);

  function useVerifiedSample() {
    const min = Math.max(capacity * LAND_PER_MW_AC, Number(extraMin) || 0);
    const filtered = sample.map(s => {
      const distance = milesBetween(centroid(s), center);
      return {
        ...s, properties: { ...s.properties, distance_miles: Math.round(distance * 100) / 100 },
      };
    }).filter(s => s.properties.gross_acres >= min && (s.properties.distance_miles ?? Infinity) <= radius)
      .sort((a, b) => Number(a.properties.wetland_flag) - Number(b.properties.wetland_flag) ||
        (a.properties.distance_miles ?? 0) - (b.properties.distance_miles ?? 0) ||
        b.properties.gross_acres - a.properties.gross_acres);
    setSites(filtered.map((s, i) => ({ ...s, properties: { ...s.properties, rank: i + 1 } })));
    setMode('sample'); setSummary({
      retrieved: sample.length, above_area_and_within_radius: filtered.length,
      wetlands_screened: filtered.length,
      wetland_flags: filtered.filter(s => s.properties.wetland_flag).length,
      query_limited: true,
    });
    setSelectedId(null); setComparison([]); setError(''); setStarted(true);
    if (filtered.length && map.current) {
      map.current.flyToBounds(L.geoJSON({ type: 'FeatureCollection', features: filtered } as FeatureCollection<Geometry, SiteProperties>).getBounds().pad(0.15), { duration: 0.7, maxZoom: 13 });
    }
  }

  async function findSites() {
    setLoading(true); setError(''); setSelectedId(null); setStarted(true);
    try {
      const url = (import.meta.env.VITE_API_URL as string | undefined) || '/api/search';
      const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capacity_mw_ac: capacity, center_lat: center[0], center_lon: center[1],
          radius_miles: radius,
          minimum_acres: extraMin ? Number(extraMin) : null,
        }),
      });
      if (!response.ok) {
        let detail = 'The live GIS service could not complete this request.';
        try { const failure = await response.json(); detail = failure.detail || detail; } catch { /* non-JSON response */ }
        throw new Error(detail);
      }
      const result = await response.json() as SearchResponse;
      if (result.type !== 'FeatureCollection' || !Array.isArray(result.features)) throw new Error('Unexpected live GIS response.');
      setSites(result.features); setMode('live'); setSummary(result.summary); setComparison([]);
      if (result.features.length && map.current) {
        const bounds = L.geoJSON(result as FeatureCollection).getBounds();
        if (bounds.isValid()) map.current.flyToBounds(bounds.pad(0.12), { duration: 0.8, maxZoom: 13 });
      }
    } catch (err) {
      // A failed live query is never silently replaced with cached data.
      setError(err instanceof Error ? err.message : 'Live screening failed.');
    } finally { setLoading(false); }
  }

  function toggleCompare(id: string) {
    setComparison(prev => prev.includes(id) ? prev.filter(x => x !== id) :
      prev.length < 3 ? [...prev, id] : prev);
  }

  return <div className="app-shell">
    <div className="map-viewport" ref={mapElement} aria-label="Interactive satellite parcel map" />
    <div className="map-wash" aria-hidden="true" />

    <aside className="sidebar">
      <div className="brand-line">
        <div className="brand-symbol"><Compass size={21} strokeWidth={2.2} /></div>
        <div><strong className="brand-name">gridseeker<span>.</span></strong><div className="brand-tagline">SITE INTELLIGENCE</div></div>
        <span className="v-chip">BETA</span>
      </div>

      <div className="hero-copy">
        <div className="eyebrow"><span className="pulse-dot" /> GIS-POWERED SITING</div>
        <h1>Good projects<br/>start with <em>good land.</em></h1>
        <p>Find a starting point for your next solar project with real parcels and transparent environmental screening.</p>
      </div>

      <div className="project-heading"><span><SlidersHorizontal size={15} /> PROJECT PARAMETERS</span><span className="step-counter">01 / 02</span></div>
      <div className="config-card">
        <label htmlFor="capacity">Project capacity <span>MW AC</span></label>
        <div className="value-layout"><input id="capacity" type="number" min="0.1" max="20" step="0.5"
          value={capacity} onChange={e => setCapacity(Math.min(20, Math.max(0.1, Number(e.target.value) || 0.1)))} />
          <div className="solar-icon"><Sun size={20}/></div></div>
        <div className="input-footnote">Ground-mounted solar PV · Approx. {(capacity * 1.3).toFixed(2)} MW DC</div>
        <div className="config-divider" />
        <div className="slider-top"><label htmlFor="radius">Search radius</label><strong>{radius} <small>mi</small></strong></div>
        <input id="radius" className="range-input" type="range" min="1" max="30" step="1" value={radius} onChange={e => setRadius(Number(e.target.value))}/>
        <div className="slider-bound"><span>1 mile</span><span>30 miles</span></div>
        <div className="config-divider" />
        <label htmlFor="minimum">Minimum parcel area <span>Optional · acres</span></label>
        <input id="minimum" className="numeric-input" type="number" min="0.5" max="2000"
          placeholder={'Auto · ' + required.toFixed(1) + ' acres'}
          value={extraMin} onChange={e => setExtraMin(e.target.value)} />
        <div className="input-footnote">Using {LAND_PER_MW_AC} gross acres per MW AC for initial screening. Not usable acreage.</div>
      </div>

      <div className="location-info"><MapPin size={15}/><div><strong>Albany County, NY</strong><small>Click anywhere on the map to move search center</small></div>
        <button className="icon-button" title="Reset search center to Albany" onClick={() => setCenter(ALBANY)}><RefreshCw size={15}/></button></div>

      <button className="primary-action" disabled={loading || (STATIC_DEMO && sample.length === 0)} onClick={STATIC_DEMO ? useVerifiedSample : findSites}>
        {loading ? <><span className="loader"/> Screening real parcels…</> : <><Search size={18}/> {STATIC_DEMO ? 'Screen verified sample' : 'Find sites'} <ArrowRight size={18} className="action-arrow"/></>}
      </button>
      <div className="project-footnote"><Info size={13}/> Initial screening only · Not an interconnection or permitting decision</div>

      <div className="results-header">
        <div className="results-title"><span>SEARCH RESULTS</span><span className="step-counter">02 / 02</span></div>
        <div className="results-meta">
          <strong>{sites.length} <small>sites in view</small></strong>
          <span className={mode === 'live' ? 'source-chip live' : 'source-chip'}>{mode === 'live' ? 'LIVE GIS' : 'VERIFIED SAMPLE'}</span>
        </div>
      </div>

      {error && <div className="error-note"><AlertTriangle size={17}/><div><strong>Live search incomplete</strong><p>{error}</p>{sample.length > 0 && <button onClick={useVerifiedSample}>Explore the verified sample <ArrowUpRight size={14}/></button>}</div></div>}
      {mode === 'sample' && <div className="sample-note"><Database size={14}/><span>Showing a limited, verified 25-parcel snapshot—not an exhaustive search. {sampleDate ? 'Checked ' + new Date(sampleDate).toLocaleDateString() + '.' : ''}</span></div>}
      {summary?.query_limited && mode === 'live' && <div className="sample-note"><Info size={14}/><span>Results were sampled from a larger GIS dataset; not exhaustive.</span></div>}

      <div className="candidate-list">
        {sites.length === 0 ? <div className="empty-results">No parcels in this view meet the current filter. Adjust capacity, radius, or search center.</div> :
          sites.map((site, i) => <button key={site.properties.parcel_id}
            className={'candidate-row ' + (selectedId === site.properties.parcel_id ? 'is-selected' : '')}
            onClick={() => setSelectedId(site.properties.parcel_id)}>
            <div className="candidate-index">{String(i + 1).padStart(2, '0')}</div>
            <div className="candidate-main"><strong>{titleOf(site)}</strong>
              <span>{site.properties.gross_acres.toFixed(1)} acres <span className="middot">·</span> {site.properties.distance_miles != null ? site.properties.distance_miles.toFixed(1) + ' mi' : (site.properties.municipality || 'Albany County')}</span>
              <span className={site.properties.wetland_flag ? 'status-flag warning' : 'status-flag'}>
                <span className="flag-dot"/>{site.properties.wetland_flag ? 'Mapped wetland overlap' : 'No mapped overlap'}
              </span></div><ChevronRight size={17} className="chevron"/></button>)
        }
      </div>
      <div className="sidebar-footer"><span><Layers size={13}/> NYS parcels + NYSDEC wetlands</span><a href="https://github.com/ritwiksi/gridplanner" target="_blank" rel="noreferrer">SOURCE <ExternalLink size={12}/></a></div>
    </aside>

    <div className="map-topbar"><span className="map-location"><MapPin size={14}/> ALBANY COUNTY <span>/</span> NEW YORK</span>
      <span className="map-topbar-status"><span className="pulse-dot"/> PUBLIC GIS DATA</span></div>
    <div className="map-guidance">CLICK MAP TO ADJUST SEARCH CENTER</div>
    <div className="map-legend">
      <span className="legend-heading">SCREENING LEGEND</span>
      <span><i className="legend-swatch pass"/> No mapped wetland overlap</span>
      <span><i className="legend-swatch risk"/> Mapped wetland overlap</span>
      <span><i className="legend-swatch center"/> Search center</span>
    </div>

    {selected && <section className="assessment" aria-label="Parcel assessment">
      <div className="assessment-top"><span className="assessment-eyebrow">PRELIMINARY PARCEL ASSESSMENT</span>
        <button className="icon-button" aria-label="Close assessment" onClick={() => setSelectedId(null)}><X size={18}/></button></div>
      <h2>{titleOf(selected)}</h2>
      <p className="parcel-reference">Tax parcel {selected.properties.print_key || selected.properties.parcel_id} · {selected.properties.municipality || 'Albany County'}</p>
      <div className="assessment-metrics"><div><small>GROSS LAND AREA</small><strong>{selected.properties.gross_acres.toFixed(1)} <em>ac</em></strong></div>
        <div><small>FROM SEARCH CENTER</small><strong>{selected.properties.distance_miles?.toFixed(1) ?? '—'} <em>mi</em></strong></div></div>
      <div className="assessment-divider"/>
      <div className="assessment-list">
        <div><CheckCircle2 className="ok-icon" size={18}/><span><strong>Gross area threshold passed</strong><small>Minimum {required.toFixed(1)} acres based on current project</small></span></div>
        <div>{selected.properties.wetland_flag ? <AlertTriangle className="warn-icon" size={18}/> : <CheckCircle2 className="ok-icon" size={18}/>}
          <span><strong>{selected.properties.wetland_flag ? 'Mapped wetland overlap detected' : 'No overlap in mapped wetlands'}</strong>
          <small>NYSDEC informational mapping · not a jurisdictional determination</small></span></div>
        <div><Info className="neutral-icon" size={18}/><span><strong>Grid connection not evaluated</strong><small>Hosting capacity and feeder constraints still unknown</small></span></div>
        <div><Info className="neutral-icon" size={18}/><span><strong>Developable land area unknown</strong><small>Setbacks, terrain, zoning, ownership require review</small></span></div>
      </div>
      <div className="assessment-actions">
        <button className="report-button" onClick={() => downloadAssessment(selected, capacity, mode)}><Download size={15}/> Export assessment</button>
        <button className={'compare-button ' + (comparison.includes(selected.properties.parcel_id) ? 'active' : '')}
          onClick={() => toggleCompare(selected.properties.parcel_id)} disabled={!comparison.includes(selected.properties.parcel_id) && comparison.length >= 3}>
          {comparison.includes(selected.properties.parcel_id) ? <Check size={15}/> : <GitCompareArrows size={15}/>}
          {comparison.includes(selected.properties.parcel_id) ? 'Selected' : 'Compare'}
        </button>
      </div>
      <p className="assessment-disclaimer">Screening evidence, not a declaration of site feasibility or available land.</p>
    </section>}

    {comparison.length > 1 && !showComparison && <button className="floating-compare" onClick={() => setShowComparison(true)}><GitCompareArrows size={17}/> Compare {comparison.length} parcels <ArrowRight size={16}/></button>}
    {showComparison && <div className="compare-backdrop" onClick={() => setShowComparison(false)}><div className="compare-modal" onClick={e => e.stopPropagation()}>
      <div className="compare-head"><div><span className="assessment-eyebrow">SIDE-BY-SIDE</span><h2>Compare candidates</h2></div><button className="icon-button" onClick={() => setShowComparison(false)}><X size={18}/></button></div>
      <div className="compare-table"><div className="compare-column labels"><span>Site</span><span>Gross acreage</span><span>Distance</span><span>Wetland overlap</span><span>Grid / permits</span></div>
        {compared.map(s => <div className="compare-column" key={s.properties.parcel_id}>
          <strong>{titleOf(s)}</strong><strong>{s.properties.gross_acres.toFixed(1)} ac</strong>
          <span>{s.properties.distance_miles?.toFixed(1) ?? '—'} mi</span>
          <span>{s.properties.wetland_flag ? 'Flagged' : 'Not mapped'}</span><span>Not evaluated</span>
        </div>)}</div><p className="compare-note"><Info size={14}/> This comparison uses only measured screening attributes; it does not predict development viability.</p>
      </div></div>}
  </div>;
}
