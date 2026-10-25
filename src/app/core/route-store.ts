import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { ElevationService } from './elevation.service';
import { GeocodingService } from './geocoding.service';
import { Bounds, RouteDetails } from './recommended-routes.service';
import { buildTrack, computeStats, LngLat, sliceTrack, TrackPoint, Waypoint } from './geo';
import { buildGpx, downloadText, parseGpx } from './gpx';
import { RoutingProfile, RoutingService, straightLine } from './routing.service';

/** 'plan' = percorso a tappe modificabile, 'track' = traccia importata da GPX. */
export type RouteMode = 'plan' | 'track';

export interface Hover {
  dist: number;
  source: 'map' | 'chart';
}

export interface Range {
  from: number;
  to: number;
}

const STORAGE_KEY = 'crinalia.route.v1';

interface Saved {
  name: string;
  profile: RoutingProfile;
  waypoints: Waypoint[];
}

/** Stato condiviso tra mappa, profilo altimetrico e pannello laterale. */
@Injectable({ providedIn: 'root' })
export class RouteStore {
  private routing = inject(RoutingService);
  private elevation = inject(ElevationService);
  private geocoding = inject(GeocodingService);

  readonly mode = signal<RouteMode>('plan');
  readonly name = signal('Nuovo percorso');
  readonly profile = signal<RoutingProfile>('hiking-mountain');
  readonly waypoints = signal<Waypoint[]>([]);
  readonly track = signal<TrackPoint[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly hover = signal<Hover | null>(null);
  readonly selection = signal<Range | null>(null);
  /** Incrementato quando la mappa deve inquadrare tutta la traccia. */
  readonly fitRequest = signal(0);
  /** Punto su cui centrare la mappa (es. luogo scelto dalla ricerca). */
  readonly flyRequest = signal<LngLat | null>(null);
  /** Centro della mappa, usato per dare priorità ai risultati di ricerca vicini. */
  readonly mapCenter = signal<LngLat | null>(null);
  /** Area inquadrata, per elencare i percorsi consigliati visibili. */
  readonly mapBounds = signal<Bounds | null>(null);
  /** Area da inquadrare (es. un percorso consigliato scelto dalla lista). */
  readonly fitBoundsRequest = signal<[number, number, number, number] | null>(null);
  /** Percorso consigliato evidenziato in mappa. */
  readonly recommended = signal<RouteDetails | null>(null);

  readonly stats = computed(() => computeStats(this.track()));
  readonly selectionStats = computed(() => {
    const sel = this.selection();
    return sel ? computeStats(sliceTrack(this.track(), sel.from, sel.to)) : null;
  });
  readonly hasElevation = computed(() => this.track().some((p) => p.ele != null));

  private calcToken = 0;

  constructor() {
    this.restore();

    effect(() => {
      const wps = this.waypoints();
      const profile = this.profile();
      if (this.mode() !== 'plan') return;
      untracked(() => this.recalculate(wps, profile));
    });

    effect(() => {
      if (this.mode() !== 'plan') return;
      const saved: Saved = { name: this.name(), profile: this.profile(), waypoints: this.waypoints() };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      } catch {
        /* storage non disponibile: pazienza */
      }
    });
  }

  // --- tappe -------------------------------------------------------------

  /** Aggiunge una tappa in fondo. Senza nome (clic sulla mappa) lo cerca col geocoding inverso. */
  addWaypoint(p: Waypoint): void {
    this.ensurePlanMode();
    this.waypoints.update((w) => [...w, p]);
    if (!p.name) this.autoName(p);
  }

  /** Sostituisce una tappa (es. scelta da una ricerca testuale). */
  replaceWaypoint(i: number, p: Waypoint): void {
    this.waypoints.update((w) => w.map((x, k) => (k === i ? p : x)));
    if (!p.name) this.autoName(p);
  }

  /** Spostamento col trascinamento: il vecchio nome non vale più. */
  moveWaypoint(i: number, p: LngLat): void {
    this.replaceWaypoint(i, { lon: p.lon, lat: p.lat });
  }

  removeWaypoint(i: number): void {
    this.waypoints.update((w) => w.filter((_, k) => k !== i));
  }

  /** Scambia una tappa con la precedente (dir -1) o la successiva (dir 1). */
  shiftWaypoint(i: number, dir: -1 | 1): void {
    const j = i + dir;
    this.waypoints.update((w) => {
      if (j < 0 || j >= w.length) return w;
      const copy = [...w];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }

  flyTo(p: LngLat): void {
    this.flyRequest.set({ ...p });
  }

  undo(): void {
    this.waypoints.update((w) => w.slice(0, -1));
  }

  reverse(): void {
    if (this.mode() === 'plan') this.waypoints.update((w) => [...w].reverse());
    else this.setTrack([...this.track()].reverse().map((p) => [p.lon, p.lat, p.ele ?? NaN]));
  }

  clear(): void {
    this.mode.set('plan');
    this.name.set('Nuovo percorso');
    this.waypoints.set([]);
    this.track.set([]);
    this.error.set(null);
    this.selection.set(null);
    this.hover.set(null);
  }

  // --- GPX ---------------------------------------------------------------

  async importGpx(file: File): Promise<void> {
    try {
      const parsed = parseGpx(await file.text(), file.name.replace(/\.gpx$/i, ''));
      await this.loadTrack(parsed.name, parsed.coords);
    } catch (e) {
      this.error.set((e as Error).message);
    }
  }

  /** Carica una traccia non modificabile (GPX, percorso consigliato), completando le quote mancanti. */
  async loadTrack(name: string, raw: number[][]): Promise<void> {
    this.error.set(null);
    this.loading.set(true);
    try {
      const coords = await this.elevation.fill(raw).catch((e) => {
        this.error.set(`Quote non disponibili: ${e.message}`);
        return raw;
      });
      this.mode.set('track');
      this.waypoints.set([]);
      this.name.set(name);
      this.setTrack(coords);
      this.fitRequest.update((n) => n + 1);
    } finally {
      this.loading.set(false);
    }
  }

  exportGpx(): void {
    const name = this.name().trim() || 'percorso';
    const gpx = buildGpx(name, this.track(), this.mode() === 'plan' ? this.waypoints() : []);
    const safe = name.replace(/[^\p{L}\p{N}_-]+/gu, '_');
    downloadText(`${safe}.gpx`, gpx, 'application/gpx+xml');
  }

  // --- interni -----------------------------------------------------------

  private ensurePlanMode(): void {
    if (this.mode() === 'plan') return;
    this.mode.set('plan');
    this.name.set('Nuovo percorso');
    this.track.set([]);
  }

  private setTrack(coords: number[][]): void {
    this.track.set(buildTrack(coords));
    this.selection.set(null);
    this.hover.set(null);
  }

  private async autoName(wp: Waypoint): Promise<void> {
    const name = await this.geocoding.reverse(wp).catch(() => null);
    if (!name) return;
    // la tappa potrebbe essere stata spostata o eliminata nel frattempo: la riconosco per identità
    this.waypoints.update((w) => (w.includes(wp) ? w.map((x) => (x === wp ? { ...x, name } : x)) : w));
  }

  private async recalculate(wps: LngLat[], profile: RoutingProfile): Promise<void> {
    const token = ++this.calcToken;
    if (wps.length < 2) {
      this.track.set([]);
      this.loading.set(false);
      return;
    }

    this.loading.set(true);
    this.error.set(null);
    let failed = 0;
    const segments = await Promise.all(
      wps.slice(1).map((b, i) =>
        this.routing.segment(wps[i], b, profile).catch(() => {
          failed++;
          return straightLine(wps[i], b);
        }),
      ),
    );

    let coords = segments.flatMap((s, i) => (i === 0 ? s : s.slice(1)));
    coords = await this.elevation.fill(coords).catch(() => coords);
    if (token !== this.calcToken) return;

    if (failed) this.error.set(`${failed} tratto/i senza sentiero: uso la linea retta`);
    this.setTrack(coords);
    this.loading.set(false);
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved: Saved = JSON.parse(raw);
      this.name.set(saved.name);
      this.profile.set(saved.profile);
      this.waypoints.set(saved.waypoints ?? []);
    } catch {
      /* dati salvati illeggibili: si riparte da zero */
    }
  }
}
