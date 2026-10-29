import { Component, inject, signal } from '@angular/core';
import { formatDuration, Waypoint } from '../core/geo';
import { PlaceResult } from '../core/geocoding.service';
import { RouteStore } from '../core/route-store';
import { ROUTING_PROFILES, RoutingProfile } from '../core/routing.service';
import { PlaceSearch } from '../place-search/place-search';
import { RoutesPanel } from '../routes-panel/routes-panel';
import { LibraryPanel } from '../library-panel/library-panel';
import { LibraryService } from '../core/library.service';
import { RouteAnalysisService } from '../core/route-analysis.service';
import { AvalancheService, DANGER_LEVELS } from '../core/avalanche.service';

type SheetState = 'peek' | 'half' | 'full';
const SHEET_STATES: SheetState[] = ['peek', 'half', 'full'];

@Component({
  selector: 'app-sidebar',
  imports: [PlaceSearch, RoutesPanel, LibraryPanel],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
  host: { '[attr.data-sheet]': 'sheet()' },
})
export class Sidebar {
  protected store = inject(RouteStore);
  protected readonly profiles = ROUTING_PROFILES;
  protected readonly formatDuration = formatDuration;
  /** Indice della tappa che si sta sostituendo con una ricerca. */
  protected readonly editing = signal<number | null>(null);
  protected readonly tab = signal<'plan' | 'routes' | 'library'>('plan');
  /** Posizione del cassetto su telefono (sul desktop il pannello è sempre aperto). */
  protected readonly sheet = signal<SheetState>('peek');
  private handleStartY: number | null = null;

  protected onHandleDown(e: PointerEvent): void {
    this.handleStartY = e.clientY;
  }

  /** Tocco: posizione successiva. Scorrimento: su apre, giù chiude. */
  protected onHandleUp(e: PointerEvent): void {
    const dy = this.handleStartY == null ? 0 : e.clientY - this.handleStartY;
    this.handleStartY = null;
    const i = SHEET_STATES.indexOf(this.sheet());
    if (Math.abs(dy) < 20) this.sheet.set(i === SHEET_STATES.length - 1 ? 'peek' : SHEET_STATES[i + 1]);
    else if (dy < 0) this.sheet.set(SHEET_STATES[Math.min(SHEET_STATES.length - 1, i + 1)]);
    else this.sheet.set(SHEET_STATES[Math.max(0, i - 1)]);
  }
  protected library = inject(LibraryService);
  protected analysis = inject(RouteAnalysisService);
  protected avalanche = inject(AvalancheService);
  protected readonly now = Date.now();

  protected dangerOf(level: number) {
    return DANGER_LEVELS.find((d) => d.level === level);
  }

  protected onProfile(value: string): void {
    this.store.profile.set(value as RoutingProfile);
  }

  protected onFile(input: HTMLInputElement): void {
    const file = input.files?.[0];
    if (file) this.store.importGpx(file);
    input.value = '';
  }

  protected onAdd(r: PlaceResult): void {
    this.store.addWaypoint(toWaypoint(r));
    this.store.flyTo(r);
  }

  protected onReplace(i: number, r: PlaceResult): void {
    this.store.replaceWaypoint(i, toWaypoint(r));
    this.store.flyTo(r);
    this.editing.set(null);
  }
}

function toWaypoint(r: PlaceResult): Waypoint {
  return r.isCoords ? { lon: r.lon, lat: r.lat } : { lon: r.lon, lat: r.lat, name: r.name };
}
