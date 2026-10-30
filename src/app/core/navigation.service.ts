import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { lineString, point } from '@turf/helpers';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import { computeStats, sliceTrack, TrackStats } from './geo';
import { LocationService } from './location.service';
import { RouteStore } from './route-store';

/** Oltre questa distanza dalla traccia si è "fuori percorso" (m). */
const OFF_ROUTE_M = 50;
/** Letture consecutive fuori percorso prima dell'avviso: un solo fix impreciso non basta. */
const OFF_ROUTE_FIXES = 2;

export interface NavStatus {
  /** Distanza percorsa lungo la traccia (km), dal punto della traccia più vicino. */
  along: number;
  /** Distanza dalla traccia (m). */
  offsetM: number;
  remaining: TrackStats;
  /** Avanzamento 0..1. */
  progress: number;
}

/** Navigazione lungo il percorso caricato: dove sei sulla traccia, cosa manca, avviso fuori percorso. */
@Injectable({ providedIn: 'root' })
export class NavigationService {
  private location = inject(LocationService);
  private store = inject(RouteStore);

  readonly active = signal(false);
  readonly offRoute = signal(false);
  private offCount = 0;

  readonly status = computed<NavStatus | null>(() => {
    const fix = this.location.fix();
    const track = this.store.track();
    if (!this.active() || !fix || track.length < 2) return null;

    const line = lineString(track.map((p) => [p.lon, p.lat]));
    const near = nearestPointOnLine(line, point([fix.lon, fix.lat]), { units: 'kilometers' });
    const start = track[0].dist;
    const end = track[track.length - 1].dist;
    const along = start + near.properties.location;
    return {
      along,
      offsetM: near.properties.dist * 1000,
      remaining: computeStats(sliceTrack(track, along, end)),
      progress: end > start ? (along - start) / (end - start) : 0,
    };
  });

  constructor() {
    effect(() => {
      const s = this.status();
      if (!s) return;
      untracked(() => {
        // nel conteggio non entrano i fix con precisione peggiore della soglia stessa
        const accuracy = this.location.fix()?.accuracy ?? 0;
        if (s.offsetM > OFF_ROUTE_M && accuracy < OFF_ROUTE_M) this.offCount++;
        else if (s.offsetM <= OFF_ROUTE_M) this.offCount = 0;
        const off = this.offCount >= OFF_ROUTE_FIXES;
        if (off && !this.offRoute()) navigator.vibrate?.([300, 150, 300]);
        this.offRoute.set(off);
      });
    });
  }

  async start(): Promise<void> {
    if (this.store.track().length < 2) return;
    this.offCount = 0;
    this.offRoute.set(false);
    this.active.set(true);
    await this.location.acquire('navigazione');
  }

  async stop(): Promise<void> {
    this.active.set(false);
    this.offRoute.set(false);
    await this.location.release('navigazione');
  }
}
