import { Injectable } from '@angular/core';

/**
 * Terrain Tiles (Mapzen, AWS Open Data): PNG in cui ogni pixel codifica una quota.
 * Fonti in Europa: EU-DEM (Copernicus) e SRTM, risoluzione ~30 m.
 */
const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const TILE_SIZE = 256;
const MAX_ZOOM = 12;
/** Oltre questo numero di tile (tracce di centinaia di km) si scende di zoom. */
const MAX_TILES = 64;
/** ~256 kB l'una decodificata: 120 tile ≈ 30 MB. */
const MAX_CACHED = 120;

export const TERRAIN_TILE_URL = TILE_URL;
export const TERRAIN_ATTRIBUTION =
  'Quote © <a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> (EU-DEM, SRTM)';

/** Quota in metri dal pixel RGB Terrarium. */
export function terrariumElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

export interface TileKey {
  z: number;
  x: number;
  y: number;
}

function worldPixel(lon: number, lat: number, z: number): [number, number] {
  const scale = TILE_SIZE * 2 ** z;
  const sin = Math.sin((lat * Math.PI) / 180);
  const x = ((lon + 180) / 360) * scale;
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
  return [x, y];
}

/** Quote lette direttamente dalle tile di elevazione, senza limiti di richieste. */
@Injectable({ providedIn: 'root' })
export class ElevationService {
  private tiles = new Map<string, Promise<ImageData>>();

  /** Completa la terza coordinata (quota) dove manca. */
  async fill(coords: number[][]): Promise<number[][]> {
    const missing = coords.some((c) => c.length < 3 || !Number.isFinite(c[2]));
    if (!missing || coords.length === 0) return coords;

    const z = this.chooseZoom(coords);
    const pixels = coords.map((c) => worldPixel(c[0], c[1], z));
    const sample = await this.sampler(pixels, z);

    return coords.map((c, k) => {
      if (c.length > 2 && Number.isFinite(c[2])) return c;
      // interpolazione bilineare tra i 4 pixel vicini
      const [px, py] = pixels[k];
      const x0 = Math.floor(px - 0.5);
      const y0 = Math.floor(py - 0.5);
      const fx = px - 0.5 - x0;
      const fy = py - 0.5 - y0;
      const top = sample(x0, y0) * (1 - fx) + sample(x0 + 1, y0) * fx;
      const bottom = sample(x0, y0 + 1) * (1 - fx) + sample(x0 + 1, y0 + 1) * fx;
      return [c[0], c[1], Math.round((top * (1 - fy) + bottom * fy) * 10) / 10];
    });
  }

  /**
   * Inclinazione del terreno (gradi) nei punti dati: metodo di Horn su finestra 3×3,
   * come la carta delle pendenze. Non è la pendenza del sentiero, ma quella del pendio attraversato.
   */
  async terrainSlopes(coords: number[][]): Promise<number[]> {
    if (!coords.length) return [];
    const z = this.chooseZoom(coords);
    const pixels = coords.map((c) => worldPixel(c[0], c[1], z));
    const sample = await this.sampler(pixels, z);

    return coords.map((c, k) => {
      const px = Math.floor(pixels[k][0]);
      const py = Math.floor(pixels[k][1]);
      const cell = (40075016.686 * Math.cos((c[1] * Math.PI) / 180)) / (TILE_SIZE * 2 ** z);
      const e = (dx: number, dy: number) => sample(px + dx, py + dy);
      const dzdx = (e(1, -1) + 2 * e(1, 0) + e(1, 1) - (e(-1, -1) + 2 * e(-1, 0) + e(-1, 1))) / (8 * cell);
      const dzdy = (e(-1, 1) + 2 * e(0, 1) + e(1, 1) - (e(-1, -1) + 2 * e(0, -1) + e(1, -1))) / (8 * cell);
      return (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
    });
  }

  /**
   * Carica le tile che coprono i pixel dati (più un pixel di margine in ogni direzione, per
   * interpolazione e finestre 3×3) e restituisce una funzione quota(x, y) in pixel del mondo.
   */
  private async sampler(pixels: [number, number][], z: number): Promise<(x: number, y: number) => number> {
    const keys = new Map<string, TileKey>();
    for (const [px, py] of pixels) {
      for (const dx of [-1, 0, 1]) {
        for (const dy of [-1, 0, 1]) {
          const x = Math.floor((px + dx) / TILE_SIZE);
          const y = Math.floor((py + dy) / TILE_SIZE);
          keys.set(`${x}/${y}`, { z, x, y });
        }
      }
    }
    const loaded = new Map<string, ImageData>();
    await Promise.all([...keys].map(async ([k, t]) => loaded.set(k, await this.tile(t))));

    return (x: number, y: number) => {
      const tx = Math.floor(x / TILE_SIZE);
      const ty = Math.floor(y / TILE_SIZE);
      const d = loaded.get(`${tx}/${ty}`)!.data;
      const i = ((y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE)) * 4;
      return terrariumElevation(d[i], d[i + 1], d[i + 2]);
    };
  }

  private chooseZoom(coords: number[][]): number {
    for (let z = MAX_ZOOM; z > 6; z--) {
      const set = new Set(
        coords.map((c) => {
          const [x, y] = worldPixel(c[0], c[1], z);
          return `${Math.floor(x / TILE_SIZE)}/${Math.floor(y / TILE_SIZE)}`;
        }),
      );
      if (set.size <= MAX_TILES) return z;
    }
    return 6;
  }

  /** Tile di elevazione decodificata (RGBA); le ultime MAX_CACHED restano in memoria. */
  tile(t: TileKey): Promise<ImageData> {
    const key = `${t.z}/${t.x}/${t.y}`;
    let p = this.tiles.get(key);
    if (p) {
      // LRU: la sposto in fondo alla Map
      this.tiles.delete(key);
    } else {
      p = this.loadTile(t);
      p.catch(() => this.tiles.delete(key));
    }
    this.tiles.set(key, p);
    if (this.tiles.size > MAX_CACHED) this.tiles.delete(this.tiles.keys().next().value!);
    return p;
  }

  private async loadTile({ z, x, y }: TileKey): Promise<ImageData> {
    const url = TILE_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Servizio quote: errore ${res.status}`);
    const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE, { colorSpace: 'srgb' });
  }
}
