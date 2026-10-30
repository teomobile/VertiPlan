import { Injectable, signal } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';

/** Posizione GPS. */
export interface GeoFix {
  lon: number;
  lat: number;
  /** Precisione orizzontale in metri. */
  accuracy: number;
  /** Quota GPS (m), poco precisa: per le statistiche si preferisce il modello del terreno. */
  altitude: number | null;
  time: number;
}

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

/**
 * Sorgente unica della posizione, condivisa da registrazione e navigazione.
 * - Webapp: GPS del browser (funziona solo con la pagina aperta e lo schermo acceso).
 * - App Android: plugin nativo con servizio in primo piano, continua anche a schermo spento.
 */
@Injectable({ providedIn: 'root' })
export class LocationService {
  readonly fix = signal<GeoFix | null>(null);
  readonly active = signal(false);
  readonly error = signal<string | null>(null);
  /** true se la posizione continua ad arrivare anche a schermo spento (solo app). */
  readonly background = Capacitor.isNativePlatform();

  /** Chi sta usando il GPS (es. "registrazione", "navigazione"): si spegne quando non serve più a nessuno. */
  private users = new Set<string>();
  private browserWatch: number | null = null;
  private nativeWatch: string | null = null;

  async acquire(user: string): Promise<void> {
    this.users.add(user);
    if (!this.active()) await this.start();
  }

  async release(user: string): Promise<void> {
    this.users.delete(user);
    if (this.users.size === 0) await this.stop();
  }

  private async start(): Promise<void> {
    this.error.set(null);
    this.active.set(true);
    if (this.background) {
      // Android 13+: senza questo permesso la notifica del servizio GPS resta nascosta
      // (la registrazione funziona lo stesso, ma l'utente non vede che è in corso)
      await LocalNotifications.requestPermissions().catch(() => undefined);
      this.nativeWatch = await BackgroundGeolocation.addWatcher(
        {
          // con un messaggio il plugin avvia il servizio in primo piano con la notifica
          backgroundTitle: 'VertiPlan',
          backgroundMessage: 'Registrazione / navigazione in corso',
          requestPermissions: true,
          stale: false,
          distanceFilter: 3,
        },
        (location, error) => {
          if (error) {
            this.error.set(error.code === 'NOT_AUTHORIZED' ? 'Permesso di posizione negato' : error.message);
            return;
          }
          if (!location) return;
          this.fix.set({
            lon: location.longitude,
            lat: location.latitude,
            accuracy: location.accuracy,
            altitude: location.altitude ?? null,
            time: location.time ?? Date.now(),
          });
        },
      );
      return;
    }

    if (!('geolocation' in navigator)) {
      this.error.set('GPS non disponibile in questo browser');
      this.active.set(false);
      return;
    }
    this.browserWatch = navigator.geolocation.watchPosition(
      (p) =>
        this.fix.set({
          lon: p.coords.longitude,
          lat: p.coords.latitude,
          accuracy: p.coords.accuracy,
          altitude: p.coords.altitude,
          time: p.timestamp,
        }),
      (e) => this.error.set(e.code === e.PERMISSION_DENIED ? 'Permesso di posizione negato' : 'Posizione non disponibile'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  }

  private async stop(): Promise<void> {
    if (this.browserWatch != null) navigator.geolocation.clearWatch(this.browserWatch);
    if (this.nativeWatch != null) await BackgroundGeolocation.removeWatcher({ id: this.nativeWatch });
    this.browserWatch = null;
    this.nativeWatch = null;
    this.active.set(false);
  }
}
