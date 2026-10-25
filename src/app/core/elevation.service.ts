import { Injectable } from '@angular/core';

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/elevation';
const BATCH = 100;
const MAX_SAMPLES = 1000;

/**
 * Quote dal modello del terreno Copernicus (via Open-Meteo), usate per le tracce
 * GPX che non hanno il tag <ele>.
 */
@Injectable({ providedIn: 'root' })
export class ElevationService {
  /** Completa la terza coordinata (quota) dove manca. Campiona e interpola le tracce lunghe. */
  async fill(coords: number[][]): Promise<number[][]> {
    const missing = coords.some((c) => c.length < 3 || !Number.isFinite(c[2]));
    if (!missing || coords.length === 0) return coords;

    const step = Math.max(1, Math.ceil(coords.length / MAX_SAMPLES));
    const idx: number[] = [];
    for (let i = 0; i < coords.length; i += step) idx.push(i);
    if (idx[idx.length - 1] !== coords.length - 1) idx.push(coords.length - 1);

    const sampled: number[] = [];
    for (let i = 0; i < idx.length; i += BATCH) {
      const chunk = idx.slice(i, i + BATCH);
      const params = new URLSearchParams({
        latitude: chunk.map((k) => coords[k][1].toFixed(5)).join(','),
        longitude: chunk.map((k) => coords[k][0].toFixed(5)).join(','),
      });
      const res = await fetch(`${OPEN_METEO_URL}?${params}`);
      if (!res.ok) throw new Error(`Servizio quote: errore ${res.status}`);
      const body: { elevation: number[] } = await res.json();
      sampled.push(...body.elevation);
    }

    return coords.map((c, i) => {
      const j = Math.min(Math.floor(i / step), idx.length - 2);
      const i0 = idx[j];
      const i1 = idx[j + 1] ?? i0;
      const t = i1 === i0 ? 0 : (i - i0) / (i1 - i0);
      const ele = sampled[j] + ((sampled[j + 1] ?? sampled[j]) - sampled[j]) * t;
      return [c[0], c[1], Math.round(ele * 10) / 10];
    });
  }
}
