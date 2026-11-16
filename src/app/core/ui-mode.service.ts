import { effect, Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'vertiplan.simple.v1';

/**
 * Modalità semplificata, per l'uso sul sentiero: mappa a tutto schermo e pochi pulsanti grandi
 * (registra, torna all'auto, naviga, posizione). La scelta resta tra una apertura e l'altra.
 */
@Injectable({ providedIn: 'root' })
export class UiModeService {
  readonly simple = signal(this.restore());

  constructor() {
    effect(() => {
      const on = this.simple();
      try {
        localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
      } catch {
        /* storage non disponibile: vale fino alla chiusura */
      }
    });
  }

  toggle(): void {
    this.simple.update((v) => !v);
  }

  private restore(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }
}
