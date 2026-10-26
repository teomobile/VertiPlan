import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';
import { AVALANCHE_ATTRIBUTION, Bulletin, DANGER_LEVELS } from '../core/avalanche.service';

export const AVALANCHE_SOURCE: SourceSpecification = {
  type: 'geojson',
  data: { type: 'FeatureCollection', features: [] },
  attribution: AVALANCHE_ATTRIBUTION,
};

const fillColor = [
  'match',
  ['get', 'level'],
  ...DANGER_LEVELS.flatMap((d) => [d.level, d.color]),
  'rgba(0,0,0,0)',
] as unknown as string;

export const AVALANCHE_LAYERS: LayerSpecification[] = [
  {
    id: 'avalanche-fill',
    type: 'fill',
    source: 'avalanche',
    layout: { visibility: 'none' },
    paint: { 'fill-color': fillColor, 'fill-opacity': 0.4 },
  },
  {
    id: 'avalanche-line',
    type: 'line',
    source: 'avalanche',
    layout: { visibility: 'none' },
    paint: { 'line-color': '#495057', 'line-width': 0.8, 'line-opacity': 0.6 },
  },
  {
    id: 'avalanche-highlight',
    type: 'line',
    source: 'avalanche',
    layout: { visibility: 'none' },
    filter: ['==', ['get', 'id'], ''],
    paint: { 'line-color': '#212529', 'line-width': 2.5 },
  },
];

export const AVALANCHE_LAYER_IDS = AVALANCHE_LAYERS.map((l) => l.id);

/** Microzone con il grado di pericolo massimo del bollettino come proprietà "level". */
export function colorRegions(regions: GeoJSON.FeatureCollection, bulletin: Bulletin): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: regions.features.map((f) => {
      const id = f.properties?.['id'] as string;
      return { ...f, properties: { id, level: bulletin.regions.get(id)?.maxLevel ?? 0 } };
    }),
  };
}
