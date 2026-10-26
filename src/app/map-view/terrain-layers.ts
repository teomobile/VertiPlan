import maplibregl, { LayerSpecification, SourceSpecification } from 'maplibre-gl';
import {
  ElevationService,
  TERRAIN_ATTRIBUTION,
  TERRAIN_TILE_URL,
  terrariumElevation,
} from '../core/elevation.service';
import { SLOPE_ANGLE_CLASSES } from '../core/geo';

const TILE = 256;

const demSource = (attribution?: string): SourceSpecification => ({
  type: 'raster-dem',
  tiles: [TERRAIN_TILE_URL],
  encoding: 'terrarium',
  tileSize: TILE,
  maxzoom: 15,
  ...(attribution ? { attribution } : {}),
});

/** Due sorgenti distinte per ombreggiatura e 3D, come raccomanda MapLibre. */
export const TERRAIN_SOURCES: Record<string, SourceSpecification> = {
  dem: demSource(TERRAIN_ATTRIBUTION),
  'dem-3d': demSource(),
  slope: {
    type: 'raster',
    tiles: ['slope://{z}/{x}/{y}'],
    tileSize: TILE,
    // sotto lo zoom 12 i pixel sono troppo grandi (>40 m) e le pendenze risulterebbero sottostimate
    minzoom: 12,
    maxzoom: 14,
  },
};

export const HILLSHADE_LAYER: LayerSpecification = {
  id: 'hillshade',
  type: 'hillshade',
  source: 'dem',
  paint: {
    'hillshade-exaggeration': 0.35,
    'hillshade-shadow-color': '#2b2b2b',
    'hillshade-highlight-color': '#ffffff',
    'hillshade-accent-color': '#4a4a4a',
  },
};

export const SLOPE_LAYER: LayerSpecification = {
  id: 'slope',
  type: 'raster',
  source: 'slope',
  minzoom: 12,
  layout: { visibility: 'none' },
  paint: { 'raster-opacity': 0.6, 'raster-resampling': 'linear' },
};

export const SLOPE_LEGEND = SLOPE_ANGLE_CLASSES.map((c) => ({ label: c.label, color: c.color }));

let registered = false;

/**
 * Protocollo "slope://z/x/y": calcola l'inclinazione del terreno (metodo di Horn, finestra 3×3)
 * dalla tile di elevazione corrispondente e restituisce un PNG colorato per classi.
 */
export function registerSlopeProtocol(elevation: ElevationService): void {
  if (registered) return;
  registered = true;

  maplibregl.addProtocol('slope', async (params) => {
    const m = params.url.match(/^slope:\/\/(\d+)\/(\d+)\/(\d+)/);
    if (!m) throw new Error(`URL non valido: ${params.url}`);
    const [z, x, y] = m.slice(1).map(Number);
    const dem = await elevation.tile({ z, x, y });

    const ele = new Float32Array(TILE * TILE);
    for (let i = 0; i < ele.length; i++) {
      ele[i] = terrariumElevation(dem.data[i * 4], dem.data[i * 4 + 1], dem.data[i * 4 + 2]);
    }

    // dimensione del pixel in metri alla latitudine del centro della tile
    const n = Math.PI - (2 * Math.PI * (y + 0.5)) / 2 ** z;
    const lat = Math.atan(Math.sinh(n));
    const cell = (40075016.686 * Math.cos(lat)) / (TILE * 2 ** z);

    const at = (px: number, py: number) =>
      ele[Math.min(TILE - 1, Math.max(0, py)) * TILE + Math.min(TILE - 1, Math.max(0, px))];

    const out = new ImageData(TILE, TILE);
    for (let py = 0; py < TILE; py++) {
      for (let px = 0; px < TILE; px++) {
        const a = at(px - 1, py - 1), b = at(px, py - 1), c = at(px + 1, py - 1);
        const d = at(px - 1, py), f = at(px + 1, py);
        const g = at(px - 1, py + 1), h = at(px, py + 1), k = at(px + 1, py + 1);
        const dzdx = (c + 2 * f + k - (a + 2 * d + g)) / (8 * cell);
        const dzdy = (g + 2 * h + k - (a + 2 * b + c)) / (8 * cell);
        const deg = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;

        let cls: (typeof SLOPE_ANGLE_CLASSES)[number] | undefined;
        for (const s of SLOPE_ANGLE_CLASSES) if (deg >= s.min) cls = s;
        if (!cls) continue;
        const o = (py * TILE + px) * 4;
        out.data[o] = cls.rgb[0];
        out.data[o + 1] = cls.rgb[1];
        out.data[o + 2] = cls.rgb[2];
        out.data[o + 3] = 255;
      }
    }

    const canvas = new OffscreenCanvas(TILE, TILE);
    canvas.getContext('2d')!.putImageData(out, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { data: await blob.arrayBuffer() };
  });
}
