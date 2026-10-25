import { Component, inject, signal } from '@angular/core';
import { formatDuration, Waypoint } from '../core/geo';
import { PlaceResult } from '../core/geocoding.service';
import { RouteStore } from '../core/route-store';
import { ROUTING_PROFILES, RoutingProfile } from '../core/routing.service';
import { PlaceSearch } from '../place-search/place-search';
import { RoutesPanel } from '../routes-panel/routes-panel';

@Component({
  selector: 'app-sidebar',
  imports: [PlaceSearch, RoutesPanel],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
})
export class Sidebar {
  protected store = inject(RouteStore);
  protected readonly profiles = ROUTING_PROFILES;
  protected readonly formatDuration = formatDuration;
  /** Indice della tappa che si sta sostituendo con una ricerca. */
  protected readonly editing = signal<number | null>(null);
  protected readonly tab = signal<'plan' | 'routes'>('plan');

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
