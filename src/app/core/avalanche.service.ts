import { effect, Injectable, signal, untracked } from '@angular/core';

/**
 * Bollettino valanghe Euregio (Tirolo, Alto Adige, Trentino) in formato CAAML v6.
 * Dati © Euregio / avalanche.report, licenza CC BY 4.0. Microzone © EAWS, CC0.
 */
const LATEST_URL = 'https://avalanche.report/bulletins/latest/EUREGIO_it_CAAMLv6.json';
const ARCHIVE_URL = (d: string) => `https://avalanche.report/bulletins/${d}/${d}_EUREGIO_it_CAAMLv6.json`;
const REGION_FILES = ['IT-32-TN', 'IT-32-BZ', 'AT-07'].map(
  (id) => `https://regions.avalanches.org/micro-regions/${id}_micro-regions.geojson.json`,
);

export const AVALANCHE_ATTRIBUTION =
  'Bollettino valanghe © <a href="https://avalanche.report">Euregio</a> (CC BY 4.0)';

/** Scala europea del pericolo valanghe (EAWS). */
export const DANGER_LEVELS = [
  { level: 1, key: 'low', label: 'Debole', color: '#ccff66' },
  { level: 2, key: 'moderate', label: 'Moderato', color: '#ffff00' },
  { level: 3, key: 'considerable', label: 'Marcato', color: '#ff9900' },
  { level: 4, key: 'high', label: 'Forte', color: '#ff0000' },
  { level: 5, key: 'very_high', label: 'Molto forte', color: '#8b0000' },
];

const PROBLEMS: Record<string, string> = {
  new_snow: 'Neve fresca',
  wind_slab: 'Neve ventata',
  persistent_weak_layers: 'Strati deboli persistenti',
  wet_snow: 'Neve bagnata',
  gliding_snow: 'Valanghe di slittamento',
  cornices: 'Cornici',
  no_distinct_avalanche_problem: 'Nessun problema evidente',
  favourable_situation: 'Situazione favorevole',
};

const PERIODS: Record<string, string> = { earlier: 'mattino', later: 'pomeriggio' };

/**
 * Il bollettino usa spesso "limite del bosco" come confine di quota: non ha un valore fisso,
 * per i calcoli lungo il percorso lo stimo a 2000 m (e lo dichiaro nell'interfaccia).
 */
export const TREELINE_M = 2000;

export interface DangerRating {
  level: number;
  /** Limiti di quota in metri ("limite del bosco" = TREELINE_M). */
  lower?: number;
  upper?: number;
  usesTreeline: boolean;
  /** Es. "sopra 2600 m", "sotto 2600 m", "" se vale per tutte le quote. */
  elevation: string;
  /** "mattino" / "pomeriggio" se il pericolo cambia nella giornata. */
  period: string;
}

export interface AvalancheProblem {
  label: string;
  elevation: string;
  aspects: string[];
  period: string;
}

export interface RegionBulletin {
  regionId: string;
  name: string;
  maxLevel: number;
  ratings: DangerRating[];
  problems: AvalancheProblem[];
  highlights: string;
}

export interface Bulletin {
  publicationTime: Date;
  validFrom: Date;
  validTo: Date;
  regions: Map<string, RegionBulletin>;
}

interface CaamlElevation {
  lowerBound?: string;
  upperBound?: string;
}

function elevationText(e?: CaamlElevation): string {
  const fmt = (v: string) => (v === 'treeline' ? 'limite del bosco' : `${v} m`);
  if (e?.lowerBound && e?.upperBound) return `${fmt(e.lowerBound)}–${fmt(e.upperBound)}`;
  if (e?.lowerBound) return `sopra ${fmt(e.lowerBound)}`;
  if (e?.upperBound) return `sotto ${fmt(e.upperBound)}`;
  return '';
}

function indexRegion(f: GeoJSON.Feature): IndexedRegion {
  const g = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
  const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of polygons) {
    for (const [x, y] of poly[0]) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
  }
  return { id: f.properties?.['id'] as string, bbox: [w, s, e, n], polygons };
}

function boundMeters(v?: string): number | undefined {
  if (!v) return undefined;
  return v === 'treeline' ? TREELINE_M : Number(v);
}

/** Grado di pericolo a una data quota (il massimo tra mattino e pomeriggio). */
export function levelAtElevation(r: RegionBulletin, ele: number | null): number {
  if (ele == null) return r.maxLevel;
  const matching = r.ratings.filter((x) => (x.lower == null || ele >= x.lower) && (x.upper == null || ele < x.upper));
  return matching.length ? Math.max(...matching.map((x) => x.level)) : r.maxLevel;
}

export function dangerLevel(key: string): number {
  return DANGER_LEVELS.find((d) => d.key === key)?.level ?? 0;
}

/** Area coperta dal bollettino Euregio (ovest, sud, est, nord). */
export const EUREGIO_BBOX: [number, number, number, number] = [10.0, 45.6, 13.0, 47.8];

interface IndexedRegion {
  id: string;
  bbox: [number, number, number, number];
  polygons: number[][][][];
}

function ringContains(ring: number[][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

@Injectable({ providedIn: 'root' })
export class AvalancheService {
  private regions?: Promise<GeoJSON.FeatureCollection>;

  // --- stato condiviso tra il layer in mappa e l'analisi del percorso ---------

  /** "" = ultimo bollettino pubblicato, altrimenti "AAAA-MM-GG". */
  readonly date = signal('');
  readonly current = signal<Bulletin | null>(null);
  readonly regionShapes = signal<GeoJSON.FeatureCollection | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  private readonly requested = signal(false);
  private index: IndexedRegion[] = [];
  private token = 0;

  constructor() {
    effect(() => {
      if (!this.requested()) return;
      const date = this.date();
      untracked(() => this.load(date));
    });
  }

  /** Chiede di caricare il bollettino (una volta sola; poi si ricarica al cambio di data). */
  ensureLoaded(): void {
    this.requested.set(true);
  }

  /** Id della microzona che contiene il punto, se le microzone sono caricate. */
  regionAt(lon: number, lat: number): string | null {
    for (const r of this.index) {
      const [w, s, e, n] = r.bbox;
      if (lon < w || lon > e || lat < s || lat > n) continue;
      for (const poly of r.polygons) {
        if (ringContains(poly[0], lon, lat) && !poly.slice(1).some((hole) => ringContains(hole, lon, lat))) return r.id;
      }
    }
    return null;
  }

  private async load(date: string): Promise<void> {
    const token = ++this.token;
    this.loading.set(true);
    this.error.set(null);
    try {
      const [shapes, bulletin] = await Promise.all([this.microRegions(), this.bulletin(date || undefined)]);
      if (token !== this.token) return;
      if (this.regionShapes() !== shapes) {
        this.index = shapes.features.map((f) => indexRegion(f));
        this.regionShapes.set(shapes);
      }
      this.current.set(bulletin);
    } catch (e) {
      if (token !== this.token) return;
      this.current.set(null);
      this.error.set((e as Error).message);
    } finally {
      if (token === this.token) this.loading.set(false);
    }
  }

  /** date: "AAAA-MM-GG" per un bollettino archiviato, altrimenti l'ultimo pubblicato. */
  async bulletin(date?: string): Promise<Bulletin> {
    const res = await fetch(date ? ARCHIVE_URL(date) : LATEST_URL);
    if (res.status === 404) throw new Error(`Nessun bollettino per il ${date}`);
    if (!res.ok) throw new Error(`Bollettino valanghe: errore ${res.status}`);
    const body = await res.json();

    const regions = new Map<string, RegionBulletin>();
    let publication = 0;
    let from = Infinity;
    let to = 0;

    for (const b of body.bulletins ?? []) {
      publication = Math.max(publication, Date.parse(b.publicationTime));
      from = Math.min(from, Date.parse(b.validTime.startTime));
      to = Math.max(to, Date.parse(b.validTime.endTime));

      const ratings: DangerRating[] = (b.dangerRatings ?? []).map(
        (r: { mainValue: string; elevation?: CaamlElevation; validTimePeriod?: string }) => ({
          level: dangerLevel(r.mainValue),
          lower: boundMeters(r.elevation?.lowerBound),
          upper: boundMeters(r.elevation?.upperBound),
          usesTreeline: r.elevation?.lowerBound === 'treeline' || r.elevation?.upperBound === 'treeline',
          elevation: elevationText(r.elevation),
          period: PERIODS[r.validTimePeriod ?? ''] ?? '',
        }),
      );
      const problems: AvalancheProblem[] = (b.avalancheProblems ?? []).map(
        (p: { problemType: string; elevation?: CaamlElevation; aspects?: string[]; validTimePeriod?: string }) => ({
          label: PROBLEMS[p.problemType] ?? p.problemType,
          elevation: elevationText(p.elevation),
          aspects: (p.aspects ?? []).map((a) => a.replace('W', 'O')),
          period: PERIODS[p.validTimePeriod ?? ''] ?? '',
        }),
      );
      const maxLevel = Math.max(0, ...ratings.map((r) => r.level));
      const highlights: string = b.avalancheActivity?.highlights ?? '';

      for (const r of b.regions ?? []) {
        regions.set(r.regionID, { regionId: r.regionID, name: r.name, maxLevel, ratings, problems, highlights });
      }
    }

    return { publicationTime: new Date(publication), validFrom: new Date(from), validTo: new Date(to), regions };
  }

  /** Confini delle microzone (Trentino, Alto Adige, Tirolo), uniti in un'unica collezione. */
  microRegions(): Promise<GeoJSON.FeatureCollection> {
    this.regions ??= Promise.all(REGION_FILES.map((u) => fetch(u).then((r) => r.json()))).then((parts) => {
      const all = parts.flatMap((p: GeoJSON.FeatureCollection) => p.features);
      const ids = all.map((f) => f.properties?.['id'] as string);
      // i file contengono sia le zone "madri" (IT-32-BZ-01) sia le sottozone (IT-32-BZ-01-01…),
      // sovrapposte; il bollettino usa le sottozone, quindi tengo solo le zone senza figlie
      const leaves = all.filter((f, i) => !ids.some((other) => other.startsWith(`${ids[i]}-`)));
      return { type: 'FeatureCollection', features: leaves };
    });
    this.regions.catch(() => (this.regions = undefined));
    return this.regions;
  }
}
