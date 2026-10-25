import { Injectable } from '@angular/core';

const API = 'https://hiking.waymarkedtrails.org/api/v1';

/** Importanza della rete: internazionale, nazionale, regionale, locale (tag OSM network iwn/nwn/rwn/lwn). */
export type RouteGroup = 'INT' | 'NAT' | 'REG' | 'LOC';

export const ROUTE_GROUPS: { id: RouteGroup; label: string }[] = [
  { id: 'INT', label: 'Internazionali' },
  { id: 'NAT', label: 'Nazionali' },
  { id: 'REG', label: 'Regionali' },
  { id: 'LOC', label: 'Locali' },
];

export interface RouteSummary {
  id: number;
  ref: string;
  name: string;
  group: RouteGroup;
  symbolUrl: string | null;
  itinerary: string[];
}

export interface RouteDetails extends RouteSummary {
  lengthKm: number;
  operator: string;
  website: string | null;
  difficulty: string | null;
  roundtrip: boolean;
  description: string;
  from: string;
  to: string;
  /** Tutti i tratti (anche varianti e diramazioni), per il disegno in mappa. */
  lines: number[][][];
  /** Percorso principale in ordine, per "Usa come percorso". */
  path: number[][];
  bbox: [number, number, number, number];
  url: string;
}

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

// --- conversioni Web Mercator (EPSG:3857), usato dall'API -----------------

const R = 6378137;
const toMercator = (lon: number, lat: number) => [
  (lon * Math.PI * R) / 180,
  R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
];
const toLonLat = ([x, y]: number[]) => [
  +((x / R) * (180 / Math.PI)).toFixed(6),
  +((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)).toFixed(6),
];

// --- struttura del percorso restituita dall'API ----------------------------

interface ApiWay {
  geometry: { type: string; coordinates: number[][] };
}

interface ApiNode {
  route_type: 'route' | 'linear' | 'split' | 'base';
  main?: ApiNode[];
  appendices?: ApiNode[];
  ways?: ApiWay[];
  forward?: ApiNode[];
  backward?: ApiNode[];
}

/** Ogni tratto della relazione, varianti comprese. */
function collectLines(node: ApiNode, out: number[][][] = []): number[][][] {
  for (const w of node.ways ?? []) out.push(w.geometry.coordinates.map(toLonLat));
  for (const k of ['main', 'appendices', 'forward', 'backward'] as const) node[k]?.forEach((c) => collectLines(c, out));
  return out;
}

/** Percorso principale: i tratti dell'API sono già orientati, basta concatenarli; nelle biforcazioni prendo l'andata. */
function collectPath(node: ApiNode, out: number[][] = []): number[][] {
  if (node.route_type === 'split') {
    node.forward?.forEach((c) => collectPath(c, out));
    return out;
  }
  for (const w of node.ways ?? []) {
    const coords = w.geometry.coordinates.map(toLonLat);
    const last = out[out.length - 1];
    // il primo punto di un tratto coincide con l'ultimo del precedente
    out.push(...(last && last[0] === coords[0][0] && last[1] === coords[0][1] ? coords.slice(1) : coords));
  }
  node.main?.forEach((c) => collectPath(c, out));
  return out;
}

const symbolUrl = (id: string | undefined) => (id ? `${API}/symbols/id/${id}.svg` : null);

/** Percorsi escursionistici segnati di OpenStreetMap, tramite l'API di Waymarked Trails. */
@Injectable({ providedIn: 'root' })
export class RecommendedRoutesService {
  private details = new Map<number, Promise<RouteDetails>>();

  async listByArea(b: Bounds, signal?: AbortSignal): Promise<RouteSummary[]> {
    const [x1, y1] = toMercator(b.west, b.south);
    const [x2, y2] = toMercator(b.east, b.north);
    const params = new URLSearchParams({ bbox: [x1, y1, x2, y2].map(Math.round).join(','), limit: '60' });
    const res = await fetch(`${API}/list/by_area?${params}`, { signal });
    if (!res.ok) throw new Error(`Percorsi: errore ${res.status}`);
    const body: { results: Record<string, unknown>[] } = await res.json();
    return body.results
      .filter((r) => r['type'] === 'relation')
      .map((r) => ({
        id: r['id'] as number,
        ref: (r['ref'] as string) ?? '',
        name: (r['name'] as string) ?? (r['ref'] as string) ?? 'Senza nome',
        group: r['group'] as RouteGroup,
        symbolUrl: symbolUrl(r['symbol_id'] as string),
        itinerary: (r['itinerary'] as string[]) ?? [],
      }));
  }

  get(id: number): Promise<RouteDetails> {
    let p = this.details.get(id);
    if (!p) {
      p = this.fetchDetails(id);
      this.details.set(id, p);
      p.catch(() => this.details.delete(id));
    }
    return p;
  }

  private async fetchDetails(id: number): Promise<RouteDetails> {
    const res = await fetch(`${API}/details/relation/${id}`);
    if (!res.ok) throw new Error(`Percorso ${id}: errore ${res.status}`);
    const d = await res.json();
    const tags: Record<string, string> = d.tags ?? {};
    const [sw, ne] = [toLonLat([d.bbox[0], d.bbox[1]]), toLonLat([d.bbox[2], d.bbox[3]])];
    const itinerary: string[] = d.itinerary ?? [];

    return {
      id,
      ref: d.ref ?? '',
      name: d.name ?? d.ref ?? 'Senza nome',
      group: d.group,
      symbolUrl: symbolUrl(d.symbol_id),
      itinerary,
      lengthKm: (d.route?.length ?? 0) / 1000,
      operator: d.operator ?? tags['operator'] ?? '',
      website: tags['website'] ?? null,
      difficulty: tags['cai_scale'] ?? tags['sac_scale'] ?? null,
      roundtrip: tags['roundtrip'] === 'yes',
      description: tags['description:it'] ?? tags['description'] ?? '',
      from: tags['from'] ?? itinerary[0] ?? '',
      to: tags['to'] ?? itinerary[itinerary.length - 1] ?? '',
      lines: collectLines(d.route),
      path: collectPath(d.route),
      bbox: [sw[0], sw[1], ne[0], ne[1]],
      url: `https://hiking.waymarkedtrails.org/#route?id=${id}&type=relation`,
    };
  }
}
