import { afterNextRender, Component, ElementRef, inject, input, OnDestroy, output, signal, viewChild } from '@angular/core';
import { GeocodingService, PlaceResult } from '../core/geocoding.service';
import { RouteStore } from '../core/route-store';

const DEBOUNCE_MS = 300;

/** Campo di ricerca luoghi con suggerimenti: nomi (rifugi, cime, paesi…) o coordinate "lat, lon". */
@Component({
  selector: 'app-place-search',
  templateUrl: './place-search.html',
  styleUrl: './place-search.scss',
})
export class PlaceSearch implements OnDestroy {
  private geocoding = inject(GeocodingService);
  private store = inject(RouteStore);

  readonly placeholder = input('Cerca un luogo o scrivi lat, lon');
  readonly initial = input('');
  readonly autofocus = input(false);
  readonly picked = output<PlaceResult>();
  readonly cancelled = output<void>();

  protected readonly query = signal('');
  protected readonly results = signal<PlaceResult[]>([]);
  protected readonly active = signal(0);
  protected readonly searching = signal(false);
  protected readonly error = signal<string | null>(null);

  private inputEl = viewChild.required<ElementRef<HTMLInputElement>>('input');
  private timer?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;

  constructor() {
    afterNextRender(() => {
      this.setText(this.initial());
      if (this.autofocus()) {
        this.inputEl().nativeElement.focus();
        this.inputEl().nativeElement.select();
      }
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
    this.abort?.abort();
  }

  protected onInput(value: string): void {
    this.query.set(value);
    clearTimeout(this.timer);
    if (value.trim().length < 2) {
      this.results.set([]);
      return;
    }
    this.timer = setTimeout(() => this.search(value.trim()), DEBOUNCE_MS);
  }

  protected onKeydown(e: KeyboardEvent): void {
    const n = this.results().length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (n) this.active.set((this.active() + 1) % n);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (n) this.active.set((this.active() - 1 + n) % n);
        break;
      case 'Enter':
        e.preventDefault();
        // Invio prima che arrivino i suggerimenti: cerco subito
        if (n) this.pick(this.results()[this.active()]);
        else if (this.query().trim().length >= 2) this.search(this.query().trim(), true);
        break;
      case 'Escape':
        this.results.set([]);
        this.cancelled.emit();
        break;
    }
  }

  protected pick(r: PlaceResult): void {
    this.picked.emit(r);
    this.setText('');
    this.results.set([]);
  }

  /** Scrive direttamente nell'input: il binding [value] non rileva il cambio se il testo era già lo stesso. */
  private setText(text: string): void {
    this.query.set(text);
    this.inputEl().nativeElement.value = text;
  }

  private async search(q: string, pickFirst = false): Promise<void> {
    clearTimeout(this.timer);
    this.abort?.abort();
    this.abort = new AbortController();
    this.searching.set(true);
    this.error.set(null);
    try {
      const results = await this.geocoding.search(q, this.store.mapCenter(), this.abort.signal);
      this.results.set(results);
      this.active.set(0);
      if (!results.length) this.error.set('Nessun risultato');
      else if (pickFirst) this.pick(results[0]);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.error.set((e as Error).message);
    } finally {
      this.searching.set(false);
    }
  }
}
