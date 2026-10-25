import { afterNextRender, Component, computed, effect, ElementRef, inject, OnDestroy, viewChild } from '@angular/core';
import uPlot from 'uplot';
import { pointAtDistance, TrackPoint } from '../core/geo';
import { RouteStore } from '../core/route-store';

/** Pendenza media (%) in una finestra di ±halfKm attorno alla distanza d. */
function slopeAt(points: TrackPoint[], d: number, halfKm = 0.05): number | null {
  const a = pointAtDistance(points, d - halfKm);
  const b = pointAtDistance(points, d + halfKm);
  if (!a || !b || a.ele == null || b.ele == null || b.dist - a.dist < 0.01) return null;
  return ((b.ele - a.ele) / ((b.dist - a.dist) * 1000)) * 100;
}

@Component({
  selector: 'app-elevation-profile',
  templateUrl: './elevation-profile.html',
  styleUrl: './elevation-profile.scss',
})
export class ElevationProfile implements OnDestroy {
  protected store = inject(RouteStore);
  private chartEl = viewChild.required<ElementRef<HTMLDivElement>>('chart');
  private plot?: uPlot;
  private resizeObserver?: ResizeObserver;
  /** true mentre muoviamo il cursore per conto della mappa: evita il rimbalzo degli eventi. */
  private syncing = false;

  protected readonly hoverInfo = computed(() => {
    const h = this.store.hover();
    const track = this.store.track();
    const p = h ? pointAtDistance(track, h.dist) : null;
    if (!p) return null;
    return { dist: p.dist, ele: p.ele, slope: slopeAt(track, p.dist) };
  });

  constructor() {
    afterNextRender(() => {
      const el = this.chartEl().nativeElement;
      this.resizeObserver = new ResizeObserver(() => this.plot?.setSize(this.size()));
      this.resizeObserver.observe(el);
    });

    effect(() => {
      const track = this.store.track();
      if (!this.store.hasElevation()) {
        this.destroyPlot();
        return;
      }
      const data: uPlot.AlignedData = [track.map((p) => p.dist), track.map((p) => p.ele)];
      if (this.plot) this.plot.setData(data);
      else this.plot = new uPlot(this.options(), data, this.chartEl().nativeElement);
    });

    // cursore spostato dalla mappa
    effect(() => {
      const h = this.store.hover();
      const p = h ? pointAtDistance(this.store.track(), h.dist) : null;
      const u = this.plot;
      if (!u || h?.source === 'chart') return;
      this.syncing = true;
      if (p && p.ele != null) u.setCursor({ left: u.valToPos(p.dist, 'x'), top: u.valToPos(p.ele, 'y') });
      else u.setCursor({ left: -10, top: -10 });
      this.syncing = false;
    });

    // selezione azzerata da fuori (es. pulsante nel pannello)
    effect(() => {
      if (this.store.selection() == null && this.plot) this.plot.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.destroyPlot();
  }

  protected clearSelection(): void {
    this.store.selection.set(null);
  }

  private destroyPlot(): void {
    this.plot?.destroy();
    this.plot = undefined;
  }

  private size(): { width: number; height: number } {
    const el = this.chartEl().nativeElement;
    return { width: Math.max(el.clientWidth, 100), height: Math.max(el.clientHeight, 80) };
  }

  private options(): uPlot.Options {
    return {
      ...this.size(),
      legend: { show: false },
      scales: { x: { time: false } },
      cursor: {
        drag: { x: true, y: false, setScale: false },
        points: { size: 9, fill: '#d9480f', stroke: '#fff', width: 2 },
        y: false,
      },
      axes: [
        {
          stroke: '#5c6670',
          grid: { stroke: '#e9ecef' },
          values: (_u, ticks) => ticks.map((v) => `${v} km`),
        },
        {
          stroke: '#5c6670',
          grid: { stroke: '#e9ecef' },
          size: 56,
          values: (_u, ticks) => ticks.map((v) => `${v} m`),
        },
      ],
      series: [
        {},
        {
          stroke: '#d9480f',
          width: 2,
          fill: (u) => {
            const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
            g.addColorStop(0, 'rgba(217,72,15,0.35)');
            g.addColorStop(1, 'rgba(217,72,15,0.03)');
            return g;
          },
          points: { show: false },
        },
      ],
      hooks: {
        setCursor: [
          (u) => {
            if (this.syncing) return;
            const left = u.cursor.left ?? -1;
            if (left < 0) {
              if (this.store.hover()?.source === 'chart') this.store.hover.set(null);
              return;
            }
            this.store.hover.set({ dist: u.posToVal(left, 'x'), source: 'chart' });
          },
        ],
        setSelect: [
          (u) => {
            if (u.select.width < 3) return;
            const from = u.posToVal(u.select.left, 'x');
            const to = u.posToVal(u.select.left + u.select.width, 'x');
            this.store.selection.set({ from, to });
          },
        ],
      },
    };
  }
}
