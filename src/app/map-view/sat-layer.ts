import type { FilterSpecification, LayerSpecification, SourceSpecification } from 'maplibre-gl';

/** Sentieri SAT generati da scripts/build-sat.mjs. */
export const SAT_DATA_URL = 'data/sat-sentieri.geojson';
export const SAT_ATTRIBUTION =
  'Sentieri SAT © <a href="https://www.sat.tn.it/sentieri/mappa-sentieri/">SAT</a> (ODbL)';

/** Font per le etichette: il resto della mappa è raster e non ne ha. */
export const GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

export const SAT_DIFFICULTIES = [
  { id: 'T', label: 'T · turistico', color: '#2f9e44' },
  { id: 'E', label: 'E · escursionistico', color: '#e03131' },
  { id: 'EE', label: 'EE · per esperti', color: '#862e9c' },
  { id: 'EEA', label: 'EEA · attrezzato / ferrata', color: '#1a1a1a' },
];

const EEA_GRADES: Record<string, string> = { F: 'facile', PD: 'poco difficile', D: 'difficile', MD: 'molto difficile' };

const color = [
  'match',
  ['slice', ['get', 'difficolta'], 0, 3],
  'EEA', '#1a1a1a',
  [
    'match',
    ['get', 'difficolta'],
    'T', '#2f9e44',
    'EE', '#862e9c',
    '#e03131',
  ],
] as unknown as string;

const isEEA: FilterSpecification = ['==', ['slice', ['get', 'difficolta'], 0, 3], 'EEA'];
const isEE: FilterSpecification = ['==', ['get', 'difficolta'], 'EE'];
const isPlain: FilterSpecification = ['all', ['!', isEEA], ['!', isEE]];

const width = ['interpolate', ['linear'], ['zoom'], 10, 1.2, 13, 2.2, 16, 3.5] as unknown as number;

export const SAT_SOURCE: SourceSpecification = {
  type: 'geojson',
  data: { type: 'FeatureCollection', features: [] },
  attribution: SAT_ATTRIBUTION,
  // ricalcolato per tile: tiene bassa la memoria con 1000+ linee
  tolerance: 0.6,
};

export const SAT_LAYERS: LayerSpecification[] = [
  {
    id: 'sat-casing',
    type: 'line',
    source: 'sat',
    minzoom: 9,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-opacity': 0.8,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 13, 4, 16, 6],
    },
  },
  {
    id: 'sat-plain',
    type: 'line',
    source: 'sat',
    minzoom: 9,
    filter: isPlain,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': color, 'line-width': width },
  },
  {
    id: 'sat-ee',
    type: 'line',
    source: 'sat',
    minzoom: 9,
    filter: isEE,
    layout: { 'line-join': 'round' },
    paint: { 'line-color': color, 'line-width': width, 'line-dasharray': [3, 1.5] },
  },
  {
    id: 'sat-eea',
    type: 'line',
    source: 'sat',
    minzoom: 9,
    filter: isEEA,
    layout: { 'line-join': 'round' },
    paint: { 'line-color': color, 'line-width': width, 'line-dasharray': [1, 1.2] },
  },
  {
    id: 'sat-highlight',
    type: 'line',
    source: 'sat',
    filter: ['==', ['get', 'numero'], ''],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#fab005', 'line-width': 7, 'line-opacity': 0.75 },
  },
  {
    id: 'sat-labels',
    type: 'symbol',
    source: 'sat',
    minzoom: 12,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 350,
      'text-field': ['get', 'ref'],
      'text-font': ['Noto Sans Bold'],
      'text-size': 11,
      'text-keep-upright': true,
    },
    paint: { 'text-color': color, 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
  },
  // linea invisibile larga per il passaggio del mouse
  {
    id: 'sat-hit',
    type: 'line',
    source: 'sat',
    minzoom: 9,
    paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 12 },
  },
];

export const SAT_LAYER_IDS = SAT_LAYERS.map((l) => l.id);

export interface SatProps {
  numero: string;
  ref: string;
  nome: string;
  difficolta: string;
  da: string;
  a: string;
  quota_min: number | null;
  quota_max: number | null;
  lunghezza_m: number | null;
  t_andata: string | null;
  t_ritorno: string | null;
  gruppo: string;
}

const esc = (s: unknown) => String(s ?? '').replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

function difficultyLabel(d: string): { label: string; color: string } {
  if (d.startsWith('EEA')) {
    const grade = EEA_GRADES[d.split('-')[1] ?? ''];
    return { label: `EEA${grade ? ' · ferrata ' + grade : ''}`, color: SAT_DIFFICULTIES[3].color };
  }
  return SAT_DIFFICULTIES.find((x) => x.id === d) ?? SAT_DIFFICULTIES[1];
}

/** Ore "02:40" -> "2 h 40" */
const time = (t: string | null) => (t ? t.replace(/^0?(\d+):(\d+)$/, (_, h, m) => (+h ? `${+h} h ${m}` : `${+m} min`)) : null);

export function satTooltipHtml(p: SatProps): string {
  const diff = difficultyLabel(p.difficolta);
  const facts = [
    p.lunghezza_m ? `${(p.lunghezza_m / 1000).toFixed(1)} km` : null,
    p.quota_min != null && p.quota_max != null ? `${p.quota_min}–${p.quota_max} m` : null,
    time(p.t_andata) ? `andata ${time(p.t_andata)}` : null,
    time(p.t_ritorno) ? `ritorno ${time(p.t_ritorno)}` : null,
  ].filter(Boolean);

  return `
    <div class="sat-head">
      <span class="sat-num" style="border-color:${diff.color};color:${diff.color}">${esc(p.ref)}</span>
      <span class="sat-diff" style="background:${diff.color}">${esc(diff.label)}</span>
    </div>
    ${p.nome ? `<div class="sat-name">${esc(p.nome)}</div>` : ''}
    <div class="sat-route">${esc(p.da)} → ${esc(p.a)}</div>
    <div class="sat-facts">${facts.map(esc).join(' · ')}</div>
    ${p.gruppo ? `<div class="sat-group">${esc(p.gruppo)}</div>` : ''}`;
}
