import { Injectable } from '@angular/core';
import { LngLat, Waypoint } from './geo';

const PHOTON_URL = 'https://photon.komoot.io';

export interface PlaceResult extends Waypoint {
  name: string;
  detail: string;
  /** true se l'utente ha scritto delle coordinate: il nome va cercato col geocoding inverso. */
  isCoords?: boolean;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

/** Riconosce "46.07, 11.12", "46.07 11.12" e "46.07N 11.12E". */
export function parseCoords(text: string): LngLat | null {
  const m = text.trim().match(/^(-?\d{1,2}(?:[.,]\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([EOW])?$/i);
  if (!m) return null;
  let lat = parseFloat(m[1].replace(',', '.'));
  let lon = parseFloat(m[3].replace(',', '.'));
  if (m[2]?.toUpperCase() === 'S') lat = -lat;
  if (m[4]?.toUpperCase() === 'W') lon = -lon;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lon, lat };
}

/** Ricerca luoghi e nome dei punti tramite Photon (geocoder open source su dati OSM). */
@Injectable({ providedIn: 'root' })
export class GeocodingService {
  async search(query: string, near: LngLat | null, signal?: AbortSignal): Promise<PlaceResult[]> {
    const coords = parseCoords(query);
    if (coords) {
      return [{ ...coords, name: `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}`, detail: 'Coordinate', isCoords: true }];
    }

    const params = new URLSearchParams({ q: query, limit: '8', lang: 'default' });
    if (near) {
      params.set('lat', near.lat.toFixed(4));
      params.set('lon', near.lon.toFixed(4));
    }
    const res = await fetch(`${PHOTON_URL}/api/?${params}`, { signal });
    if (!res.ok) throw new Error(`Ricerca luoghi: errore ${res.status}`);
    const body: { features: PhotonFeature[] } = await res.json();
    // Photon restituisce spesso più oggetti OSM con lo stesso nome nello stesso posto (fermate, civici…)
    const seen = new Set<string>();
    return body.features
      .map((f) => this.toResult(f))
      .filter((r) => {
        const key = `${r.name}|${r.detail}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  async reverse(p: LngLat): Promise<string | null> {
    const params = new URLSearchParams({ lat: p.lat.toFixed(5), lon: p.lon.toFixed(5), limit: '1', lang: 'default' });
    const res = await fetch(`${PHOTON_URL}/reverse?${params}`);
    if (!res.ok) return null;
    const body: { features: PhotonFeature[] } = await res.json();
    const f = body.features[0];
    if (!f) return null;
    const pr = f.properties;
    return pr['name'] ?? pr['street'] ?? pr['locality'] ?? pr['city'] ?? null;
  }

  private toResult(f: PhotonFeature): PlaceResult {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const name = p['name'] ?? p['street'] ?? p['city'] ?? 'Senza nome';
    const kind = KINDS[p['osm_value'] ?? ''] ?? '';
    const where = [p['city'] ?? p['locality'], p['county']].filter((x) => x && x !== name).join(', ');
    return { lon, lat, name, detail: [kind, where].filter(Boolean).join(' · ') };
  }
}

const KINDS: Record<string, string> = {
  alpine_hut: 'Rifugio',
  wilderness_hut: 'Bivacco',
  peak: 'Cima',
  saddle: 'Passo / forcella',
  volcano: 'Cima',
  lake: 'Lago',
  village: 'Paese',
  town: 'Città',
  city: 'Città',
  hamlet: 'Frazione',
  locality: 'Località',
  parking: 'Parcheggio',
  viewpoint: 'Punto panoramico',
  spring: 'Sorgente',
  waterfall: 'Cascata',
  place_of_worship: 'Chiesa',
};
