import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { LngLat } from './geo';

export type ShareResult = 'shared' | 'copied' | 'cancelled' | 'failed';

/** Coordinate in gradi, primi e secondi (es. 46°01'08.4" N), il formato che chiedono spesso i soccorsi. */
export function toDms(value: number, pos: string, neg: string): string {
  const v = Math.abs(value);
  const d = Math.floor(v);
  const mFloat = (v - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(1).padStart(4, '0')}" ${value >= 0 ? pos : neg}`;
}

export function positionText(p: LngLat, accuracy?: number): string {
  const lat = p.lat.toFixed(5);
  const lon = p.lon.toFixed(5);
  const acc = accuracy != null ? ` (±${Math.round(accuracy)} m)` : '';
  return (
    `La mia posizione${acc}: ${lat}, ${lon}\n` +
    `${toDms(p.lat, 'N', 'S')} ${toDms(p.lon, 'E', 'O')}\n` +
    `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`
  );
}

/** Condivisione: nell'app il menu di Android (WhatsApp, SMS…), nel browser quello del sistema o gli appunti. */
@Injectable({ providedIn: 'root' })
export class ShareService {
  async share(title: string, text: string): Promise<ShareResult> {
    try {
      if (Capacitor.isNativePlatform()) {
        await Share.share({ title, text, dialogTitle: title });
        return 'shared';
      }
      if (navigator.share) {
        await navigator.share({ title, text });
        return 'shared';
      }
    } catch (e) {
      // chiudere il menu di condivisione non è un errore
      if ((e as Error).name === 'AbortError' || /cancel/i.test((e as Error).message)) return 'cancelled';
    }
    return this.copy(text);
  }

  async copy(text: string): Promise<ShareResult> {
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch {
      // alcune WebView negano l'API degli appunti: ripiego sul vecchio metodo con una textarea nascosta
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok ? 'copied' : 'failed';
    }
  }
}
