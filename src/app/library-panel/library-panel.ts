import { Component, computed, effect, ElementRef, inject, output, signal, viewChild } from '@angular/core';
import { buildTrack, formatDuration } from '../core/geo';
import { buildGpx, downloadText } from '../core/gpx';
import { LibraryService, SavedOrigin, SavedSummary } from '../core/library.service';
import { RouteStore } from '../core/route-store';

const ORIGIN_LABELS: Record<SavedOrigin, string> = {
  gpx: 'GPX importato',
  plan: 'Pianificato',
  recommended: 'Percorso consigliato',
  recorded: 'Registrata col GPS',
};

/** "I miei percorsi": GPX importati e percorsi salvati, conservati nel browser. */
@Component({
  selector: 'app-library-panel',
  templateUrl: './library-panel.html',
  styleUrl: './library-panel.scss',
})
export class LibraryPanel {
  protected library = inject(LibraryService);
  protected store = inject(RouteStore);

  /** Emesso dopo aver aperto un percorso, per tornare alla scheda di pianificazione. */
  readonly opened = output<void>();

  protected readonly filter = signal('');
  protected readonly renaming = signal<string | null>(null);
  protected readonly confirmDelete = signal<string | null>(null);
  protected readonly formatDuration = formatDuration;
  protected readonly originLabels = ORIGIN_LABELS;

  private renameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  constructor() {
    effect(() => {
      const el = this.renameInput()?.nativeElement;
      el?.focus();
      el?.select();
    });
  }

  protected readonly visible = computed(() => {
    const q = this.filter().trim().toLocaleLowerCase('it');
    const items = this.library.items();
    return q ? items.filter((i) => i.name.toLocaleLowerCase('it').includes(q)) : items;
  });

  protected async open(item: SavedSummary): Promise<void> {
    await this.store.openSaved(item.id);
    this.opened.emit();
  }

  protected async rename(item: SavedSummary, name: string): Promise<void> {
    // Invio e poi blur: il secondo evento non deve rinominare di nuovo
    if (this.renaming() !== item.id) return;
    this.renaming.set(null);
    const clean = name.trim();
    if (!clean || clean === item.name) return;
    await this.library.rename(item.id, clean);
    if (this.store.savedId() === item.id) this.store.name.set(clean);
  }

  protected async remove(item: SavedSummary): Promise<void> {
    this.confirmDelete.set(null);
    await this.library.delete(item.id);
    if (this.store.savedId() === item.id) this.store.savedId.set(null);
  }

  protected async exportGpx(item: SavedSummary): Promise<void> {
    const r = await this.library.get(item.id);
    if (!r) return;
    const safe = r.name.replace(/[^\p{L}\p{N}_-]+/gu, '_');
    downloadText(`${safe}.gpx`, buildGpx(r.name, buildTrack(r.coords), r.waypoints ?? []), 'application/gpx+xml');
  }

  protected date(ms: number): string {
    return new Date(ms).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
  }
}
