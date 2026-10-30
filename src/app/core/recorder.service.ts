import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { buildTrack, computeStats, haversineKm } from './geo';
import { GeoFix, LocationService } from './location.service';
import { RouteStore } from './route-store';

export type RecorderState = 'idle' | 'recording' | 'paused';

/** Punto registrato: [lon, lat, quota GPS, istante in ms]. */
type RecPoint = [number, number, number, number];

const STORAGE_KEY = 'vertiplan.recording.v1';
/** Fix meno precisi di così vengono scartati (m). */
const MAX_ACCURACY_M = 35;
/** Distanza minima tra due punti registrati (m): filtra il "tremolio" del GPS da fermi. */
const MIN_STEP_M = 5;

interface Saved {
  state: RecorderState;
  points: RecPoint[];
  startedAt: number;
  /** Millisecondi di registrazione effettiva (le pause non contano). */
  activeMs: number;
  /** Inizio dell'ultimo tratto attivo, se in registrazione. */
  resumedAt: number | null;
}

/** Registrazione della traccia percorsa. Lo stato sopravvive a una chiusura dell'app. */
@Injectable({ providedIn: 'root' })
export class RecorderService {
  private location = inject(LocationService);
  private store = inject(RouteStore);

  readonly state = signal<RecorderState>('idle');
  readonly points = signal<RecPoint[]>([]);
  private startedAt = 0;
  private activeMs = 0;
  private resumedAt: number | null = null;
  /** Orologio per aggiornare il tempo trascorso a schermo. */
  readonly now = signal(Date.now());
  private ticker?: ReturnType<typeof setInterval>;

  readonly track = computed(() => buildTrack(this.points().map(([lon, lat, ele]) => [lon, lat, ele])));
  readonly stats = computed(() => computeStats(this.track(), 8));
  readonly elapsedMs = computed(() => {
    this.now();
    return this.activeMs + (this.resumedAt ? Date.now() - this.resumedAt : 0);
  });

  constructor() {
    this.restore();

    effect(() => {
      const fix = this.location.fix();
      if (fix && this.state() === 'recording') untracked(() => this.add(fix));
    });
  }

  async start(): Promise<void> {
    this.points.set([]);
    this.startedAt = Date.now();
    this.activeMs = 0;
    this.resumedAt = Date.now();
    this.state.set('recording');
    this.startTicker();
    this.persist();
    await this.location.acquire('registrazione');
  }

  pause(): void {
    if (this.state() !== 'recording') return;
    this.activeMs += Date.now() - (this.resumedAt ?? Date.now());
    this.resumedAt = null;
    this.state.set('paused');
    this.persist();
  }

  async resume(): Promise<void> {
    if (this.state() !== 'paused') return;
    this.resumedAt = Date.now();
    this.state.set('recording');
    this.persist();
    await this.location.acquire('registrazione');
  }

  /** Termina la registrazione, la salva in "I miei percorsi" e la apre sulla mappa. */
  async stop(): Promise<void> {
    this.pause();
    const pts = this.points();
    this.state.set('idle');
    clearInterval(this.ticker);
    localStorage.removeItem(STORAGE_KEY);
    await this.location.release('registrazione');
    if (pts.length < 2) return;

    const name = `Registrazione ${new Date(this.startedAt).toLocaleString('it-IT', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })}`;
    // le quote GPS sono poco precise: le sostituisce il modello del terreno, come per i GPX senza quota
    await this.store.loadTrack(
      name,
      pts.map(([lon, lat]) => [lon, lat]),
      'recorded',
    );
    await this.store.saveCurrent();
    this.points.set([]);
  }

  /** Scarta la registrazione in corso senza salvarla. */
  async discard(): Promise<void> {
    this.state.set('idle');
    this.points.set([]);
    clearInterval(this.ticker);
    localStorage.removeItem(STORAGE_KEY);
    await this.location.release('registrazione');
  }

  private add(fix: GeoFix): void {
    if (fix.accuracy > MAX_ACCURACY_M) return;
    const pts = this.points();
    const last = pts[pts.length - 1];
    if (last && haversineKm({ lon: last[0], lat: last[1] }, fix) * 1000 < MIN_STEP_M) return;
    this.points.set([...pts, [fix.lon, fix.lat, fix.altitude ?? NaN, fix.time]]);
    this.persist();
  }

  private startTicker(): void {
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.now.set(Date.now()), 1000);
  }

  private persist(): void {
    const saved: Saved = {
      state: this.state(),
      points: this.points(),
      startedAt: this.startedAt,
      activeMs: this.activeMs,
      resumedAt: this.resumedAt,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      /* storage pieno o non disponibile: la registrazione continua in memoria */
    }
  }

  /** Dopo una chiusura dell'app la registrazione riprende in pausa: l'utente decide se continuare. */
  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s: Saved = JSON.parse(raw);
      if (s.state === 'idle') return;
      this.points.set(s.points);
      this.startedAt = s.startedAt;
      this.activeMs = s.activeMs + (s.resumedAt ? Math.max(0, s.points.at(-1)?.[3] ?? s.resumedAt) - s.resumedAt : 0);
      this.resumedAt = null;
      this.state.set('paused');
      this.startTicker();
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
}
