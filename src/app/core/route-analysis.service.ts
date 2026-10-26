import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { AvalancheService, EUREGIO_BBOX, levelAtElevation, TREELINE_M } from './avalanche.service';
import { ElevationService } from './elevation.service';
import { pointAtDistance, SLOPE_ANGLE_CLASSES, TrackPoint } from './geo';
import { RouteStore } from './route-store';

/** Campionamento lungo la traccia: fitto, ma senza superare MAX_SAMPLES punti. */
const STEP_KM = 0.025;
const MAX_SAMPLES = 2000;
const DEBOUNCE_MS = 300;

export interface TerrainSample {
  dist: number;
  lon: number;
  lat: number;
  ele: number | null;
  /** Inclinazione del pendio attraversato, in gradi. */
  deg: number;
}

export interface ZoneCrossing {
  regionId: string;
  name: string;
  /** Grado massimo alle quote a cui il percorso attraversa la zona. */
  level: number;
  km: number;
  minEle: number | null;
  maxEle: number | null;
}

export interface DangerSummary {
  maxLevel: number;
  zones: ZoneCrossing[];
  usesTreeline: boolean;
}

/**
 * Analisi del percorso per la stagione invernale: inclinazione del terreno attraversato
 * (dalle tile di elevazione) e grado di pericolo del bollettino Euregio alle quote del percorso.
 * È un aiuto alla pianificazione: non sostituisce la valutazione sul posto.
 */
@Injectable({ providedIn: 'root' })
export class RouteAnalysisService {
  private store = inject(RouteStore);
  private elevation = inject(ElevationService);
  private avalanche = inject(AvalancheService);

  readonly samples = signal<TerrainSample[]>([]);
  readonly loading = signal(false);

  readonly maxDeg = computed(() => Math.max(0, ...this.samples().map((s) => s.deg)));

  /** Km di percorso su terreno di ogni classe di inclinazione (≥30°, ≥35°, ≥40°, ≥45°). */
  readonly kmAbove = computed(() => {
    const s = this.samples();
    return SLOPE_ANGLE_CLASSES.map((c) => ({
      min: c.min,
      color: c.color,
      km: s.reduce((acc, x, i) => (i && x.deg >= c.min ? acc + (x.dist - s[i - 1].dist) : acc), 0),
    }));
  });

  /** Il percorso tocca l'area del bollettino Euregio? */
  readonly inEuregio = computed(() => {
    const [w, s, e, n] = EUREGIO_BBOX;
    return this.samples().some((p) => p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n);
  });

  readonly danger = computed<DangerSummary | null>(() => {
    const bulletin = this.avalanche.current();
    this.avalanche.regionShapes(); // ricalcola quando arrivano le microzone
    const samples = this.samples();
    if (!bulletin || !samples.length || !this.inEuregio()) return null;

    const zones = new Map<string, ZoneCrossing>();
    let usesTreeline = false;
    samples.forEach((p, i) => {
      const id = this.avalanche.regionAt(p.lon, p.lat);
      const region = id ? bulletin.regions.get(id) : undefined;
      if (!region) return;
      usesTreeline ||= region.ratings.some((r) => r.usesTreeline);
      const level = levelAtElevation(region, p.ele);
      const z = zones.get(region.regionId) ?? {
        regionId: region.regionId,
        name: region.name,
        level: 0,
        km: 0,
        minEle: null,
        maxEle: null,
      };
      z.level = Math.max(z.level, level);
      if (i) z.km += p.dist - samples[i - 1].dist;
      if (p.ele != null) {
        z.minEle = Math.min(z.minEle ?? p.ele, p.ele);
        z.maxEle = Math.max(z.maxEle ?? p.ele, p.ele);
      }
      zones.set(region.regionId, z);
    });
    const list = [...zones.values()];
    return { maxLevel: Math.max(0, ...list.map((z) => z.level)), zones: list, usesTreeline };
  });

  readonly treelineM = TREELINE_M;

  private timer?: ReturnType<typeof setTimeout>;
  private token = 0;

  constructor() {
    effect(() => {
      const track = this.store.track();
      clearTimeout(this.timer);
      untracked(() => {
        if (track.length < 2 || !track.some((p) => p.ele != null)) {
          this.samples.set([]);
          return;
        }
        this.timer = setTimeout(() => this.analyse(track), DEBOUNCE_MS);
      });
    });

    // il bollettino serve solo se il percorso passa per Trentino, Alto Adige o Tirolo
    effect(() => {
      if (this.inEuregio()) this.avalanche.ensureLoaded();
    });
  }

  private async analyse(track: TrackPoint[]): Promise<void> {
    const token = ++this.token;
    this.loading.set(true);
    try {
      const start = track[0].dist;
      const total = track[track.length - 1].dist - start;
      const n = Math.max(1, Math.min(MAX_SAMPLES, Math.round(total / STEP_KM)));
      const points = Array.from({ length: n + 1 }, (_, i) => pointAtDistance(track, start + (total * i) / n)!);
      const degs = await this.elevation.terrainSlopes(points.map((p) => [p.lon, p.lat]));
      if (token !== this.token) return;
      this.samples.set(points.map((p, i) => ({ dist: p.dist, lon: p.lon, lat: p.lat, ele: p.ele, deg: degs[i] })));
    } catch {
      if (token === this.token) this.samples.set([]);
    } finally {
      if (token === this.token) this.loading.set(false);
    }
  }
}
