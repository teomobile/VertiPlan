import { Component, computed, effect, inject, OnDestroy, output, signal } from '@angular/core';
import {
  RecommendedRoutesService,
  ROUTE_GROUPS,
  RouteGroup,
  RouteSummary,
} from '../core/recommended-routes.service';
import { RouteStore } from '../core/route-store';

const DEBOUNCE_MS = 400;

/** Percorsi segnati nella zona inquadrata: lista, scheda di dettaglio e caricamento come traccia. */
@Component({
  selector: 'app-routes-panel',
  templateUrl: './routes-panel.html',
  styleUrl: './routes-panel.scss',
})
export class RoutesPanel implements OnDestroy {
  protected store = inject(RouteStore);
  private api = inject(RecommendedRoutesService);

  /** Emesso dopo "Usa come percorso", per tornare alla scheda di pianificazione. */
  readonly used = output<void>();

  protected readonly routes = signal<RouteSummary[]>([]);
  protected readonly filter = signal('');
  protected readonly listLoading = signal(false);
  protected readonly detailLoading = signal<number | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly selected = this.store.recommended;

  protected readonly groups = computed(() => {
    const q = this.filter().trim().toLocaleLowerCase('it');
    const visible = q
      ? this.routes().filter((r) => `${r.name} ${r.ref} ${r.itinerary.join(' ')}`.toLocaleLowerCase('it').includes(q))
      : this.routes();
    return ROUTE_GROUPS.map((g) => ({ ...g, routes: visible.filter((r) => r.group === g.id) })).filter((g) => g.routes.length);
  });

  private timer?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;

  constructor() {
    effect(() => {
      const bounds = this.store.mapBounds();
      if (!bounds) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.load(), DEBOUNCE_MS);
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
    this.abort?.abort();
  }

  protected groupLabel(id: RouteGroup): string {
    return ROUTE_GROUPS.find((g) => g.id === id)?.label ?? '';
  }

  protected async select(r: RouteSummary): Promise<void> {
    this.error.set(null);
    this.detailLoading.set(r.id);
    try {
      const d = await this.api.get(r.id);
      this.store.recommended.set(d);
      this.store.fitBoundsRequest.set(d.bbox);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.detailLoading.set(null);
    }
  }

  protected close(): void {
    this.store.recommended.set(null);
  }

  protected async useAsRoute(): Promise<void> {
    const d = this.selected();
    if (!d || d.path.length < 2) return;
    const name = d.ref && !d.name.includes(d.ref) ? `${d.ref} · ${d.name}` : d.name;
    this.store.recommended.set(null);
    this.used.emit();
    await this.store.loadTrack(name, d.path, 'recommended');
  }

  private async load(): Promise<void> {
    const bounds = this.store.mapBounds();
    if (!bounds) return;
    this.abort?.abort();
    this.abort = new AbortController();
    this.listLoading.set(true);
    try {
      this.routes.set(await this.api.listByArea(bounds, this.abort.signal));
      this.error.set(null);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.error.set((e as Error).message);
    } finally {
      this.listLoading.set(false);
    }
  }
}
