import { Component, computed, inject, input, output, signal } from '@angular/core';
import { formatDuration } from '../core/geo';
import { LocationService } from '../core/location.service';
import { NavigationService } from '../core/navigation.service';
import { RecorderService } from '../core/recorder.service';
import { RouteStore } from '../core/route-store';

/** Comandi e dati del GPS: registrazione della traccia e navigazione lungo il percorso. */
@Component({
  selector: 'app-gps-bar',
  templateUrl: './gps-bar.html',
  styleUrl: './gps-bar.scss',
})
export class GpsBar {
  protected recorder = inject(RecorderService);
  protected nav = inject(NavigationService);
  protected location = inject(LocationService);
  protected store = inject(RouteStore);
  protected readonly formatDuration = formatDuration;

  /** false se l'utente ha spostato la mappa: compare "Segui" per tornare a seguire la posizione. */
  readonly following = input(true);
  readonly recenter = output<void>();

  protected readonly busy = computed(() => this.recorder.state() !== 'idle' || this.nav.active());
  protected readonly confirmDiscard = signal(false);

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
