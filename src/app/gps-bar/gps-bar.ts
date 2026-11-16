import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CAR_STALE_MS, CarService } from '../core/car.service';
import { formatDuration } from '../core/geo';
import { ElevationService } from '../core/elevation.service';
import { GeoFix, LocationService } from '../core/location.service';
import { positionText, ShareService, toDms } from '../core/share.service';
import { UiModeService } from '../core/ui-mode.service';
import { NavigationService } from '../core/navigation.service';
import { RecorderService } from '../core/recorder.service';
import { RouteStore } from '../core/route-store';

/** Comandi e dati del GPS: registrazione della traccia e navigazione lungo il percorso. */
@Component({
  selector: 'app-gps-bar',
  templateUrl: './gps-bar.html',
  styleUrl: './gps-bar.scss',
  host: { '[class.simple]': 'ui.simple()' },
})
export class GpsBar {
  protected recorder = inject(RecorderService);
  protected nav = inject(NavigationService);
  protected location = inject(LocationService);
  protected store = inject(RouteStore);
  protected car = inject(CarService);
  protected ui = inject(UiModeService);
  private shareService = inject(ShareService);
  private elevation = inject(ElevationService);
  protected readonly toDms = toDms;

  /** Scheda "📍 Posizione": coordinate da dettare o condividere. */
  protected readonly position = signal<{ fix: GeoFix; ele: number | null } | null>(null);
  protected readonly positionBusy = signal(false);
  protected readonly positionMsg = signal<string | null>(null);

  protected async showPosition(): Promise<void> {
    this.positionMsg.set(null);
    this.positionBusy.set(true);
    try {
      // sempre una posizione fresca: è quella che si manda ai soccorsi
      const fix = await this.location.current(15_000);
      if (!fix) {
        this.position.set(null);
        this.positionMsg.set("Posizione GPS non disponibile: prova all'aperto.");
        return;
      }
      this.position.set({ fix, ele: null });
      this.store.flyTo(fix);
      const [p] = await this.elevation.fill([[fix.lon, fix.lat]]).catch(() => [[0, 0, NaN]]);
      if (Number.isFinite(p[2]) && this.position()?.fix === fix) this.position.set({ fix, ele: p[2] });
    } finally {
      this.positionBusy.set(false);
    }
  }

  protected async sharePosition(copyOnly = false): Promise<void> {
    const p = this.position();
    if (!p) return;
    const text = positionText(p.fix, p.fix.accuracy);
    const result = copyOnly ? await this.shareService.copy(text) : await this.shareService.share('La mia posizione', text);
    this.positionMsg.set(
      { shared: null, cancelled: null, copied: 'Copiata negli appunti', failed: 'Non riesco a condividere: detta le coordinate.' }[result],
    );
  }

  protected closePosition(): void {
    this.position.set(null);
    this.positionMsg.set(null);
  }

  protected time(ms: number): string {
    return new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  }
  protected readonly formatDuration = formatDuration;

  /** false se l'utente ha spostato la mappa: compare "Segui" per tornare a seguire la posizione. */
  readonly following = input(true);
  readonly recenter = output<void>();

  protected readonly busy = computed(() => this.recorder.state() !== 'idle' || this.nav.active());
  protected readonly confirmDiscard = signal(false);
  /** Menu "🚗" aperto. */
  protected readonly carMenu = signal(false);
  /** Domanda "Segno qui l'auto?" dopo l'avvio della registrazione. */
  protected readonly carPrompt = signal(false);

  protected async startRecording(): Promise<void> {
    const spot = this.car.car();
    await this.recorder.start();
    // nessuna auto segnata, o segnata in un'altra uscita: probabilmente sei appena partito dal parcheggio
    if (!spot || Date.now() - spot.time > CAR_STALE_MS) this.carPrompt.set(true);
  }

  protected async carHere(): Promise<void> {
    this.carPrompt.set(false);
    this.carMenu.set(false);
    await this.car.setHere();
  }

  protected carOnMap(): void {
    this.carPrompt.set(false);
    this.carMenu.set(false);
    this.car.picking.set(true);
  }

  protected async goBack(mode: 'trails' | 'retrace' | 'straight'): Promise<void> {
    this.carMenu.set(false);
    await this.car.goBack(mode);
  }

  protected clock(ms: number): string {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  protected km(v: number): string {
    return v < 1 ? `${Math.round(v * 1000)} m` : `${v.toFixed(1)} km`;
  }

  protected async discard(): Promise<void> {
    this.confirmDiscard.set(false);
    await this.recorder.discard();
  }
}
