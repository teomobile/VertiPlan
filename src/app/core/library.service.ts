import { Injectable, signal } from '@angular/core';
import { Waypoint } from './geo';
import { RoutingProfile } from './routing.service';

const DB_NAME = 'crinalia';
const DB_VERSION = 1;
const STORE = 'routes';

/** Da dove arriva il percorso salvato. */
export type SavedOrigin = 'gpx' | 'plan' | 'recommended';

export interface SavedSummary {
  id: string;
  name: string;
  origin: SavedOrigin;
  createdAt: number;
  updatedAt: number;
  distanceKm: number;
  ascent: number;
  descent: number;
  durationMin: number;
}

export interface SavedRoute extends SavedSummary {
  /** [lon, lat, quota] */
  coords: number[][];
  /** Solo per i percorsi pianificati: permettono di riaprirli modificabili. */
  waypoints?: Waypoint[];
  profile?: RoutingProfile;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Libreria dei percorsi salvati, in IndexedDB: resta nel browser (o nell'app) anche offline.
 * Non è sincronizzata tra dispositivi.
 */
@Injectable({ providedIn: 'root' })
export class LibraryService {
  /** Elenco senza coordinate, dal più recente. */
  readonly items = signal<SavedSummary[]>([]);
  readonly error = signal<string | null>(null);

  private db = this.open();

  constructor() {
    this.refresh();
  }

  async get(id: string): Promise<SavedRoute | undefined> {
    return request((await this.tx('readonly')).get(id));
  }

  async save(route: SavedRoute): Promise<void> {
    await request((await this.tx('readwrite')).put(route));
    await this.refresh();
  }

  async rename(id: string, name: string): Promise<void> {
    const route = await this.get(id);
    if (!route) return;
    await this.save({ ...route, name, updatedAt: Date.now() });
  }

  async delete(id: string): Promise<void> {
    await request((await this.tx('readwrite')).delete(id));
    await this.refresh();
  }

  /** Un percorso con lo stesso nome e la stessa lunghezza è considerato già salvato. */
  findDuplicate(name: string, distanceKm: number): SavedSummary | undefined {
    return this.items().find((i) => i.name === name && Math.abs(i.distanceKm - distanceKm) < 0.01);
  }

  private async refresh(): Promise<void> {
    try {
      const all: SavedRoute[] = await request((await this.tx('readonly')).getAll());
      this.items.set(
        all
          .map(({ coords: _c, waypoints: _w, profile: _p, ...summary }) => summary)
          .sort((a, b) => b.updatedAt - a.updatedAt),
      );
      this.error.set(null);
    } catch (e) {
      this.error.set(`Libreria non disponibile: ${(e as Error).message}`);
    }
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.db).transaction(STORE, mode).objectStore(STORE);
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}
