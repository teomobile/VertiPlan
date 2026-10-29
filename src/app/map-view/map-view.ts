import {
  afterNextRender,
  Component,
  effect,
  ElementRef,
  inject,
  isDevMode,
  OnDestroy,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import { lineString, point } from '@turf/helpers';
import maplibregl, {
  GeoJSONSource,
  LngLat,
  LngLatBounds,
  Map as MlMap,
  Marker,
  Point,
  StyleSpecification,
} from 'maplibre-gl';
import { pointAtDistance, sliceTrack, slopeAngleClass, TrackPoint, Waypoint } from '../core/geo';
import { RouteAnalysisService } from '../core/route-analysis.service';
import { RouteStore } from '../core/route-store';
import {
  GLYPHS_URL,
  SAT_DATA_URL,
  SAT_DIFFICULTIES,
  SAT_LAYER_IDS,
  SAT_LAYERS,
  SAT_SOURCE,
  SatProps,
  satTooltipHtml,
} from './sat-layer';
import { HILLSHADE_LAYER, registerSlopeProtocol, SLOPE_LAYER, SLOPE_LEGEND, TERRAIN_SOURCES } from './terrain-layers';
import { ElevationService } from '../core/elevation.service';
import { AvalancheService, Bulletin, DANGER_LEVELS, RegionBulletin } from '../core/avalanche.service';
import { AVALANCHE_LAYER_IDS, AVALANCHE_LAYERS, AVALANCHE_SOURCE, colorRegions } from './avalanche-layer';

type BaseLayer = 'osm' | 'otm';

const BASE_LAYERS: { id: BaseLayer; label: string }[] = [
  { id: 'osm', label: 'OpenStreetMap' },
  { id: 'otm', label: 'Topografica' },
];

const START_CENTER: [number, number] = [11.12, 46.07]; // Trento
/** Tocco: quanto tenere premuto sulla linea del percorso prima di poterla trascinare. */
const LONG_PRESS_MS = 400;

const STYLE: StyleSpecification = {
  version: 8,
  glyphs: GLYPHS_URL,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
    otm: {
      type: 'raster',
      tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 17,
      attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    },
    trails: {
      type: 'raster',
      tiles: ['https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 18,
      attribution: 'Sentieri © <a href="https://hiking.waymarkedtrails.org">Waymarked Trails</a>',
    },
    ...TERRAIN_SOURCES,
    avalanche: AVALANCHE_SOURCE,
    sat: SAT_SOURCE,
    recommended: {
      type: 'geojson',
      data: emptyLine(),
      attribution: 'Percorsi © <a href="https://hiking.waymarkedtrails.org">Waymarked Trails</a> / OSM',
    },
    route: { type: 'geojson', data: emptyLine() },
    selection: { type: 'geojson', data: emptyLine() },
    'drag-preview': { type: 'geojson', data: emptyLine() },
    'route-steep': { type: 'geojson', data: emptyLine() },
  },
  layers: [
    { id: 'osm', type: 'raster', source: 'osm' },
    { id: 'otm', type: 'raster', source: 'otm', layout: { visibility: 'none' } },
    HILLSHADE_LAYER,
    ...AVALANCHE_LAYERS,
    SLOPE_LAYER,
    { id: 'trails', type: 'raster', source: 'trails', paint: { 'raster-opacity': 0.85 } },
    ...SAT_LAYERS,
    {
      id: 'recommended-casing',
      type: 'line',
      source: 'recommended',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.9 },
    },
    {
      id: 'recommended-line',
      type: 'line',
      source: 'recommended',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#1971c2', 'line-width': 5, 'line-opacity': 0.85 },
    },
    // alone attorno ai tratti del percorso su pendii ≥ 30°
    {
      id: 'route-steep',
      type: 'line',
      source: 'route-steep',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 14, 'line-opacity': 0.85 },
    },
    {
      id: 'route-casing',
      type: 'line',
      source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 8 },
    },
    {
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#d9480f', 'line-width': 4.5 },
    },
    {
      id: 'selection-line',
      type: 'line',
      source: 'selection',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#1864ab', 'line-width': 6 },
    },
    {
      id: 'drag-preview',
      type: 'line',
      source: 'drag-preview',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#d9480f', 'line-width': 3, 'line-dasharray': [2, 1.5] },
    },
    // linea invisibile e larga: rende facile "agganciare" il percorso col mouse
    {
      id: 'route-hit',
      type: 'line',
      source: 'route',
      paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 22 },
    },
  ],
};

function emptyLine(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function toLine(points: TrackPoint[]): GeoJSON.FeatureCollection {
  if (points.length < 2) return emptyLine();
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points.map((p) => [p.lon, p.lat]) } },
    ],
  };
}

@Component({
  selector: 'app-map-view',
  templateUrl: './map-view.html',
  styleUrl: './map-view.scss',
  host: {
    '(dragover)': 'onDragOver($event)',
    '(dragleave)': 'dragging.set(false)',
    '(drop)': 'onDrop($event)',
  },
})
export class MapView implements OnDestroy {
  protected store = inject(RouteStore);
  protected readonly baseLayers = BASE_LAYERS;
  protected readonly base = signal<BaseLayer>('osm');
  protected readonly showTrails = signal(false);
  protected readonly showSat = signal(true);
  protected readonly satLegend = SAT_DIFFICULTIES;
  protected readonly showHillshade = signal(true);
  protected readonly showSlope = signal(false);
  protected readonly show3d = signal(false);
  protected readonly slopeLegend = SLOPE_LEGEND;
  protected readonly zoom = signal(11);
  protected readonly dragging = signal(false);
  private elevation = inject(ElevationService);
  protected avalanche = inject(AvalancheService);
  private analysis = inject(RouteAnalysisService);

  protected readonly showAvalanche = signal(false);
  /** Pannello livelli aperto (conta solo su telefono, sul desktop è sempre visibile). */
  protected readonly panelOpen = signal(false);
  protected readonly hoveredRegion = signal<RegionBulletin | null>(null);
  protected readonly dangerLevels = DANGER_LEVELS;
  protected readonly today = new Date().toISOString().slice(0, 10);

  private container = viewChild.required<ElementRef<HTMLDivElement>>('map');
  private map?: MlMap;
  private readonly ready = signal(false);
  private waypointMarkers: Marker[] = [];
  private hoverMarker?: Marker;
  private satLoaded = false;
  /** Trascinamento in corso della linea del percorso (tratto tra la tappa leg e leg+1). */
  private drag: { leg: number; moved: boolean; last?: LngLat } | null = null;
  /** Pressione prolungata sulla linea in attesa di diventare un trascinamento (solo tocco). */
  private longPress: { start: Point; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Dispositivo senza mouse (telefono, tablet): le schede si aprono al tocco. */
  private readonly touchMode = matchMedia('(hover: none)').matches;
  private satTapPopup = new maplibregl.Popup({ className: 'sat-popup sat-popup-tap', maxWidth: '280px', offset: 8 });
  private satPopup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    className: 'sat-popup',
    maxWidth: '280px',
    offset: 12,
  });

  constructor() {
    afterNextRender(() => {
      registerSlopeProtocol(this.elevation);
      this.map = new maplibregl.Map({
        container: this.container().nativeElement,
        style: STYLE,
        center: START_CENTER,
        zoom: 11,
        maxZoom: 19,
        maxPitch: 70,
        doubleClickZoom: false,
        // sul telefono i crediti restano dietro la "i" per non coprire la mappa
        attributionControl: { compact: true },
      });
      this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
      this.map.on('zoomend', () => this.zoom.set(this.map!.getZoom()));
      this.map.addControl(
        new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }),
        'top-right',
      );
      this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
      this.map.on('load', () => this.ready.set(true));
      // i crediti compatti di MapLibre partono aperti: li chiudo appena la mappa è pronta, restano dietro la "i"
      this.map.once('idle', () =>
        this.container().nativeElement.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'),
      );
      this.bindEvents(this.map);
      // per il debug dalla console del browser
      if (isDevMode()) (window as unknown as { vertiplanMap: MlMap }).vertiplanMap = this.map;
    });

    // traccia
    effect(() => {
      const track = this.store.track();
      if (!this.ready()) return;
      this.source('route').setData(toLine(track));
    });

    // tratti su terreno ripido, raggruppati per classe di inclinazione
    effect(() => {
      const samples = this.analysis.samples();
      if (!this.ready()) return;
      const features: GeoJSON.Feature[] = [];
      let run: number[][] = [];
      let color: string | undefined;
      const flush = () => {
        if (run.length > 1 && color) {
          features.push({ type: 'Feature', properties: { color }, geometry: { type: 'LineString', coordinates: run } });
        }
      };
      samples.forEach((s, i) => {
        const c = slopeAngleClass(s.deg)?.color;
        if (c !== color) {
          flush();
          // riparto dal punto precedente, così i tratti si toccano senza buchi
          run = i && c ? [[samples[i - 1].lon, samples[i - 1].lat]] : [];
          color = c;
        }
        if (c) run.push([s.lon, s.lat]);
      });
      flush();
      this.source('route-steep').setData({ type: 'FeatureCollection', features });
    });

    // tratto selezionato sul profilo
    effect(() => {
      const sel = this.store.selection();
      const track = this.store.track();
      if (!this.ready()) return;
      this.source('selection').setData(sel ? toLine(sliceTrack(track, sel.from, sel.to)) : emptyLine());
    });

    // tappe
    effect(() => {
      const wps = this.store.waypoints();
      if (!this.ready()) return;
      this.renderWaypoints(wps);
    });

    // posizione evidenziata (da mappa o da profilo)
    effect(() => {
      const hover = this.store.hover();
      const p = hover ? pointAtDistance(this.store.track(), hover.dist) : null;
      if (!this.ready() || !this.map) return;
      if (!p) {
        this.hoverMarker?.remove();
        return;
      }
      this.hoverMarker ??= new maplibregl.Marker({ element: dot('hover-dot') });
      this.hoverMarker.setLngLat([p.lon, p.lat]).addTo(this.map);
    });

    // luogo scelto dalla ricerca
    effect(() => {
      const p = this.store.flyRequest();
      if (!p || !this.ready() || !this.map) return;
      this.map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(this.map.getZoom(), 13) });
    });

    // bollettino valanghe: caricato la prima volta che il livello viene acceso
    effect(() => {
      const on = this.showAvalanche();
      if (!this.ready() || !this.map) return;
      for (const id of AVALANCHE_LAYER_IDS) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      if (on) this.avalanche.ensureLoaded();
      else this.hoveredRegion.set(null);
    });

    effect(() => {
      const bulletin = this.avalanche.current();
      const shapes = this.avalanche.regionShapes();
      if (!this.ready()) return;
      this.source('avalanche').setData(bulletin && shapes ? colorRegions(shapes, bulletin) : emptyLine());
    });

    // rilievo 3D
    effect(() => {
      const on = this.show3d();
      if (!this.ready() || !this.map) return;
      this.map.setTerrain(on ? { source: 'dem-3d', exaggeration: 1.3 } : null);
      this.map.easeTo({ pitch: on ? 60 : 0, duration: 800 });
    });

    // percorso consigliato selezionato
    effect(() => {
      const r = this.store.recommended();
      if (!this.ready()) return;
      this.source('recommended').setData(
        r
          ? { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: r.lines } }
          : emptyLine(),
      );
    });

    effect(() => {
      const box = this.store.fitBoundsRequest();
      if (!box || !this.ready() || !this.map) return;
      this.map.fitBounds(box, { padding: 60, duration: 600 });
    });

    // inquadra tutta la traccia dopo un import
    effect(() => {
      if (this.store.fitRequest() === 0 || !this.ready()) return;
      this.fitTrack();
    });

    // livelli
    effect(() => {
      const base = this.base();
      const trails = this.showTrails();
      const sat = this.showSat();
      if (!this.ready() || !this.map) return;
      for (const l of BASE_LAYERS) this.map.setLayoutProperty(l.id, 'visibility', l.id === base ? 'visible' : 'none');
      this.map.setLayoutProperty('trails', 'visibility', trails ? 'visible' : 'none');
      for (const id of SAT_LAYER_IDS) this.map.setLayoutProperty(id, 'visibility', sat ? 'visible' : 'none');
      this.map.setLayoutProperty('hillshade', 'visibility', this.showHillshade() ? 'visible' : 'none');
      this.map.setLayoutProperty('slope', 'visibility', this.showSlope() ? 'visible' : 'none');
      if (!sat) this.hideSatInfo();
      // i dati SAT (~1 MB compressi) si scaricano solo la prima volta che il livello è acceso
      if (sat && !this.satLoaded) {
        this.satLoaded = true;
        this.source('sat').setData(new URL(SAT_DATA_URL, document.baseURI).href);
      }
    });
  }

  ngOnDestroy(): void {
    this.map?.remove();
  }

  fitTrack(): void {
    const track = this.store.track();
    if (!this.map || track.length < 2) return;
    const b = new LngLatBounds();
    track.forEach((p) => b.extend([p.lon, p.lat]));
    this.map.fitBounds(b, { padding: 60, duration: 600 });
  }

  protected onDragOver(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    this.dragging.set(true);
  }

  protected onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragging.set(false);
    const file = e.dataTransfer?.files[0];
    if (file) this.store.importGpx(file);
  }

  private source(id: string): GeoJSONSource {
    return this.map!.getSource(id) as GeoJSONSource;
  }

  private bindEvents(map: MlMap): void {
    const updateCenter = () => {
      const c = map.getCenter();
      const b = map.getBounds();
      this.store.mapCenter.set({ lon: c.lng, lat: c.lat });
      this.store.mapBounds.set({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
    };
    // subito, senza aspettare il caricamento delle tile: serve già alla ricerca e ai percorsi consigliati
    updateCenter();
    map.on('moveend', updateCenter);

    map.on('click', (e) => {
      // un clic sulla linea del percorso non aggiunge tappe in fondo: la linea si trascina
      const onRoute = map.queryRenderedFeatures(e.point, { layers: ['route-hit'] }).length > 0;

      if (this.touchMode) {
        // senza mouse non c'è il "passaggio": le informazioni arrivano al tocco
        if (this.showAvalanche()) {
          const id = map.queryRenderedFeatures(e.point, { layers: ['avalanche-fill'] })[0]?.properties?.['id'];
          if (id) {
            this.hoveredRegion.set(this.avalanche.current()?.regions.get(id) ?? null);
            map.setFilter('avalanche-highlight', ['==', ['get', 'id'], id]);
          }
        }
        const sat = this.showSat() && !onRoute ? map.queryRenderedFeatures(e.point, { layers: ['sat-hit'] })[0] : undefined;
        if (sat) {
          this.showSatTap(map, sat.properties as SatProps, e.lngLat);
          return;
        }
        map.setFilter('sat-highlight', ['==', ['get', 'numero'], '']);
      }

      if (this.store.mode() === 'track' || onRoute) return;
      this.store.addWaypoint({ lon: e.lngLat.lng, lat: e.lngLat.lat });
    });

    map.on('mousemove', 'route-hit', (e) => {
      const dist = this.distanceAlongTrack(e.lngLat.lng, e.lngLat.lat);
      if (dist == null) return;
      if (!this.drag) map.getCanvas().style.cursor = this.store.mode() === 'plan' ? 'grab' : 'crosshair';
      this.store.hover.set({ dist, source: 'map' });
    });

    map.on('mouseleave', 'route-hit', () => {
      if (!this.drag) map.getCanvas().style.cursor = '';
      if (this.store.hover()?.source === 'map') this.store.hover.set(null);
    });

    // trascinando la linea del percorso si inserisce una tappa nel tratto corrispondente
    map.on('mousedown', 'route-hit', (e) => {
      const wps = this.store.waypoints();
      if (this.store.mode() !== 'plan' || wps.length < 2 || e.originalEvent.button !== 0) return;
      const dist = this.distanceAlongTrack(e.lngLat.lng, e.lngLat.lat);
      if (dist == null) return;
      e.preventDefault(); // niente spostamento della mappa durante il trascinamento
      this.drag = { leg: this.store.legAt(dist), moved: false };
      map.getCanvas().style.cursor = 'grabbing';
      // rilascio fuori dalla mappa: il mouseup della mappa non arriva, annullo
      window.addEventListener(
        'mouseup',
        () => {
          if (!this.drag) return;
          this.drag = null;
          map.getCanvas().style.cursor = '';
          this.source('drag-preview').setData(emptyLine());
        },
        { once: true },
      );
    });

    map.on('mousemove', (e) => {
      if (!this.drag) return;
      this.drag.moved = true;
      this.showDragPreview(e.lngLat.lng, e.lngLat.lat);
    });

    // al tocco: tieni premuto sulla linea, poi trascina (un trascinamento normale sposta la mappa)
    map.on('touchstart', 'route-hit', (e) => {
      if (this.store.mode() !== 'plan' || this.store.waypoints().length < 2 || e.points.length !== 1) return;
      const dist = this.distanceAlongTrack(e.lngLat.lng, e.lngLat.lat);
      if (dist == null) return;
      const start = e.point;
      const at = e.lngLat;
      clearTimeout(this.longPress?.timer);
      this.longPress = {
        start,
        timer: setTimeout(() => {
          this.longPress = null;
          this.drag = { leg: this.store.legAt(dist), moved: false };
          map.dragPan.disable();
          navigator.vibrate?.(30);
          this.showDragPreview(at.lng, at.lat);
        }, LONG_PRESS_MS),
      };
    });

    map.on('touchmove', (e) => {
      if (this.longPress) {
        // il dito si è mosso prima del tempo: è un normale spostamento della mappa
        if (Math.hypot(e.point.x - this.longPress.start.x, e.point.y - this.longPress.start.y) > 10) {
          clearTimeout(this.longPress.timer);
          this.longPress = null;
        }
        return;
      }
      if (!this.drag || e.points.length !== 1) return;
      this.drag.moved = true;
      this.drag.last = e.lngLat;
      this.showDragPreview(e.lngLat.lng, e.lngLat.lat);
    });

    map.on('touchend', () => {
      clearTimeout(this.longPress?.timer);
      this.longPress = null;
      const drag = this.drag;
      if (!drag) return;
      this.drag = null;
      map.dragPan.enable();
      this.source('drag-preview').setData(emptyLine());
      // a fine tocco la posizione del dito non c'è più: uso l'ultima vista durante il trascinamento
      if (drag.moved && drag.last) this.store.insertWaypoint(drag.leg + 1, { lon: drag.last.lng, lat: drag.last.lat });
    });

    map.on('mouseup', (e) => {
      const drag = this.drag;
      if (!drag) return;
      this.drag = null;
      map.getCanvas().style.cursor = '';
      this.source('drag-preview').setData(emptyLine());
      if (drag.moved) this.store.insertWaypoint(drag.leg + 1, { lon: e.lngLat.lng, lat: e.lngLat.lat });
    });

    // scheda del sentiero SAT al passaggio del mouse (il percorso pianificato ha la precedenza)
    map.on('mousemove', 'sat-hit', (e) => {
      const onRoute = map.queryRenderedFeatures(e.point, { layers: ['route-hit'] }).length > 0;
      const f = e.features?.[0];
      if (onRoute || !f) {
        this.hideSatInfo();
        return;
      }
      const props = f.properties as SatProps;
      map.setFilter('sat-highlight', ['==', ['get', 'numero'], props.numero]);
      this.satPopup.setLngLat(e.lngLat).setHTML(satTooltipHtml(props)).addTo(map);
    });
    map.on('mouseleave', 'sat-hit', () => this.hideSatInfo());

    // microzona del bollettino valanghe sotto il mouse
    map.on('mousemove', 'avalanche-fill', (e) => {
      const id = e.features?.[0]?.properties?.['id'] as string | undefined;
      if (!id || this.hoveredRegion()?.regionId === id) return;
      this.hoveredRegion.set(this.avalanche.current()?.regions.get(id) ?? null);
      map.setFilter('avalanche-highlight', ['==', ['get', 'id'], id]);
    });
    map.on('mouseleave', 'avalanche-fill', () => {
      this.hoveredRegion.set(null);
      map.setFilter('avalanche-highlight', ['==', ['get', 'id'], '']);
    });
  }

  protected bulletinExpired(b: Bulletin): boolean {
    return b.validTo.getTime() < Date.now();
  }

  protected formatDate(d: Date): string {
    return d.toLocaleString('it-IT', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  protected dangerOf(level: number) {
    return DANGER_LEVELS.find((d) => d.level === level);
  }

  private showDragPreview(lon: number, lat: number): void {
    if (!this.drag) return;
    const wps = this.store.waypoints();
    const a = wps[this.drag.leg];
    const b = wps[this.drag.leg + 1];
    if (!a || !b) return;
    this.source('drag-preview').setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [lon, lat], [b.lon, b.lat]] },
    });
  }

  /** Al tocco: scheda del sentiero SAT con il pulsante per aggiungere una tappa in quel punto. */
  private showSatTap(map: MlMap, props: SatProps, at: { lng: number; lat: number }): void {
    const el = document.createElement('div');
    el.innerHTML = satTooltipHtml(props);
    if (this.store.mode() === 'plan') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sat-add';
      btn.textContent = '+ Tappa qui';
      btn.addEventListener('click', () => {
        this.store.addWaypoint({ lon: at.lng, lat: at.lat });
        this.satTapPopup.remove();
      });
      el.appendChild(btn);
    }
    map.setFilter('sat-highlight', ['==', ['get', 'numero'], props.numero]);
    this.satTapPopup.setLngLat(at).setDOMContent(el).addTo(map);
  }

  /** Distanza progressiva (km) del punto della traccia più vicino a lon/lat. */
  private distanceAlongTrack(lon: number, lat: number): number | null {
    const track = this.store.track();
    if (track.length < 2) return null;
    const line = lineString(track.map((p) => [p.lon, p.lat]));
    const nearest = nearestPointOnLine(line, point([lon, lat]), { units: 'kilometers' });
    // la distanza di turf è geodetica come la nostra: aggiungo l'offset del primo punto
    return track[0].dist + nearest.properties.location;
  }

  private hideSatInfo(): void {
    this.satPopup.remove();
    this.map?.setFilter('sat-highlight', ['==', ['get', 'numero'], '']);
  }

  private renderWaypoints(wps: Waypoint[]): void {
    this.waypointMarkers.forEach((m) => m.remove());
    this.waypointMarkers = wps.map((w, i) => {
      const kind = i === 0 ? 'start' : i === wps.length - 1 ? 'end' : 'via';
      const el = dot(`wp wp-${kind}`, kind === 'via' ? String(i) : '');
      el.title = `${w.name ? w.name + '\n' : ''}Trascina per spostare · doppio clic per eliminare`;
      el.addEventListener('click', (e) => e.stopPropagation());
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.store.removeWaypoint(i);
      });
      const marker = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([w.lon, w.lat]).addTo(this.map!);
      marker.on('dragend', () => {
        const ll = marker.getLngLat();
        this.store.moveWaypoint(i, { lon: ll.lng, lat: ll.lat });
      });
      return marker;
    });
  }
}

function dot(className: string, text = ''): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}
