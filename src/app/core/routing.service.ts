import { Injectable } from '@angular/core';
import { haversineKm, LngLat } from './geo';

export type RoutingProfile = 'hiking-mountain' | 'hiking-beta' | 'trekking' | 'straight';

export const ROUTING_PROFILES: { id: RoutingProfile; label: string }[] = [
  { id: 'hiking-mountain', label: 'Escursionismo (montagna)' },
  { id: 'hiking-beta', label: 'Escursionismo (facile)' },
  { id: 'trekking', label: 'Trekking / bici' },
  { id: 'straight', label: 'Linea retta (fuori sentiero)' },
];

const BROUTER_URL = 'https://brouter.de/brouter';

/** Linea retta densificata ogni ~50 m, così il profilo altimetrico ha abbastanza punti. */
export function straightLine(a: LngLat, b: LngLat): number[][] {
  const n = Math.max(1, Math.ceil(haversineKm(a, b) / 0.05));
  const out: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t]);
  }
  return out;
}

/**
 * Calcolo del percorso a piedi tramite il server pubblico di BRouter.
 * Ogni tratto tra due tappe è calcolato e messo in cache separatamente,
 * così spostare una tappa ricalcola solo i due tratti adiacenti.
 */
@Injectable({ providedIn: 'root' })
export class RoutingService {
  private cache = new Map<string, Promise<number[][]>>();

  segment(a: LngLat, b: LngLat, profile: RoutingProfile): Promise<number[][]> {
    if (profile === 'straight') return Promise.resolve(straightLine(a, b));

    const key = `${profile}|${a.lon.toFixed(6)},${a.lat.toFixed(6)}|${b.lon.toFixed(6)},${b.lat.toFixed(6)}`;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.fetchSegment(a, b, profile);
      this.cache.set(key, pending);
      // un errore non deve restare in cache
      pending.catch(() => this.cache.delete(key));
    }
    return pending;
  }

  private async fetchSegment(a: LngLat, b: LngLat, profile: RoutingProfile): Promise<number[][]> {
    const params = new URLSearchParams({
      lonlats: `${a.lon},${a.lat}|${b.lon},${b.lat}`,
      profile,
      alternativeidx: '0',
      format: 'geojson',
    });
    const res = await fetch(`${BROUTER_URL}?${params}`);
    const text = await res.text();
    if (!res.ok) throw new Error(text.trim() || `BRouter: errore ${res.status}`);
    const geo = JSON.parse(text);
    const coords: number[][] | undefined = geo?.features?.[0]?.geometry?.coordinates;
    if (!coords?.length) throw new Error('BRouter: nessun percorso trovato');
    return coords;
  }
}
