import { computed, inject, Injectable, signal } from '@angular/core';
import { haversineKm, LngLat } from './geo';
import { GeoFix, LocationService } from './location.service';
import { NavigationService } from './navigation.service';
import { RecorderService } from './recorder.service';
import { RouteStore } from './route-store';
import { RoutingService, straightLine } from './routing.service';

export interface CarSpot extends LngLat {
  /** Quando è stata segnata (ms). */
  time: number;
}

/** Come tornare: sui sentieri (serve rete), ripercorrendo la traccia registrata (offline), in linea retta. */
export type ReturnMode = 'trails' | 'retrace' | 'straight';

const STORAGE_KEY = 'vertiplan.car.v1';
/** Una posizione GPS più vecchia di così non vale come "posizione attuale". */
const FIX_MAX_AGE_MS = 60_000;
const FIX_TIMEOUT_MS = 30_000;
/** Oltre questo tempo il parcheggio segnato è probabilmente di un'altra uscita: alla registrazione si chiede di nuovo. */
export const CAR_STALE_MS = 12 * 3600_000;

const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

/** "Torna alla macchina": dove hai parcheggiato e il percorso per tornarci. */
@Injectable({ providedIn: 'root' })
export class CarService {
  private location = inject(LocationService);
  private routing = inject(RoutingService);
  private store = inject(RouteStore);
  private nav = inject(NavigationService);
  private recorder = inject(RecorderService);

  readonly car = signal<CarSpot | null>(this.restore());
  /** Il prossimo tocco sulla mappa segna l'auto. */
  readonly picking = signal(false);
  readonly busy = signal(false);
  readonly message = signal<string | null>(null);

  /** Distanza in linea d'aria e direzione dell'auto dalla posizione attuale. */
  readonly info = computed(() => {
    const car = this.car();
    const fix = this.location.fix();
    if (!car || !fix) return null;
    return { km: haversineKm(fix, car), direction: DIRECTIONS[Math.round(bearing(fix, car) / 45) % 8] };
  });

  /** Si può ripercorrere la traccia solo se si sta registrando e c'è qualcosa da ripercorrere. */
  readonly canRetrace = computed(() => this.recorder.state() !== 'idle' && this.recorder.points().length > 1);

  /** Segna l'auto alla posizione GPS attuale (aspetta il primo fix se serve). */
  async setHere(): Promise<void> {
    this.message.set(null);
    this.busy.set(true);
    try {
      const fix = await this.currentFix();
      if (!fix) {
        this.message.set('Posizione GPS non disponibile: segna l\'auto toccando la mappa.');
        return;
      }
      this.save({ lon: fix.lon, lat: fix.lat, time: Date.now() });
      this.message.set('Auto segnata qui');
    } finally {
      this.busy.set(false);
    }
  }

  /** Segna l'auto in un punto della mappa. */
  setAt(p: LngLat): void {
    this.picking.set(false);
    this.save({ lon: p.lon, lat: p.lat, time: Date.now() });
    this.message.set('Auto segnata');
  }

  clear(): void {
    this.car.set(null);
    this.message.set(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage non disponibile */
    }
  }

  /** Calcola il percorso di ritorno, lo carica sulla mappa e avvia la navigazione. */
  async goBack(mode: ReturnMode): Promise<void> {
    const car = this.car();
    if (!car) return;
    this.message.set(null);
    this.busy.set(true);
    try {
      let coords: number[][];
      let name: string;

      if (mode === 'retrace') {
        // a ritroso sulla traccia registrata: funziona anche senza rete
        coords = this.recorder.points().map(([lon, lat]) => [lon, lat]).reverse();
        coords.push([car.lon, car.lat]);
        name = 'Ritorno sulla traccia';
      } else {
        const fix = await this.currentFix();
        if (!fix) {
          this.message.set('Posizione GPS non disponibile.');
          return;
        }
        if (mode === 'trails') {
          try {
            coords = await this.routing.segment(fix, car, 'hiking-mountain');
            name = 'Ritorno all\'auto';
          } catch {
            // senza rete (o senza sentieri) resta la linea retta
            coords = straightLine(fix, car);
            name = 'Ritorno all\'auto (linea retta)';
            this.message.set(
              this.canRetrace()
                ? 'Percorso sui sentieri non disponibile (rete?): linea retta. Puoi anche ripercorrere la traccia.'
                : 'Percorso sui sentieri non disponibile (rete?): mostro la linea retta.',
            );
          }
        } else {
          coords = straightLine(fix, car);
          name = 'Ritorno all\'auto (linea retta)';
        }
      }

      await this.store.loadTrack(name, coords, 'plan');
      if (this.nav.active()) await this.nav.stop();
      await this.nav.start();
    } finally {
      this.busy.set(false);
    }
  }

  /** Posizione attuale: l'ultima se recente, altrimenti accende il GPS e aspetta la prima (max 30 s). */
  private async currentFix(): Promise<GeoFix | null> {
    const last = this.location.fix();
    if (last && Date.now() - last.time < FIX_MAX_AGE_MS) return last;
    await this.location.acquire('auto');
    try {
      return await new Promise<GeoFix | null>((resolve) => {
        const timer = setTimeout(() => {
          off();
          resolve(null);
        }, FIX_TIMEOUT_MS);
        const off = this.location.onFix((fix) => {
          clearTimeout(timer);
          off();
          resolve(fix);
        });
      });
    } finally {
      await this.location.release('auto');
    }
  }

  private save(spot: CarSpot): void {
    this.car.set(spot);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(spot));
    } catch {
      /* storage non disponibile: resta in memoria */
    }
  }

  private restore(): CarSpot | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as CarSpot) : null;
    } catch {
      return null;
    }
  }
}

/** Direzione da a verso b in gradi (0 = nord, senso orario). */
function bearing(a: LngLat, b: LngLat): number {
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}
