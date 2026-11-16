import {
  afterNextRender,
  Component,
  computed,
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
import {
  buildTrack,
  computeStats,
  formatDuration,
  haversineKm,
  LngLat as GeoLngLat,
  pointAtDistance,
  sliceTrack,
  slopeAngleClass,
  TrackPoint,
  Waypoint,
} from '../core/geo';
import { RouteAnalysisService } from '../core/route-analysis.service';
import { LocationService } from '../core/location.service';
import { NavigationService } from '../core/navigation.service';
import { RecorderService } from '../core/recorder.service';
import { GpsBar } from '../gps-bar/gps-bar';
import { CarService } from '../core/car.service';
import { UiModeService } from '../core/ui-mode.service';
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
/** Misura: posizione e punto scelto entro questa distanza dal percorso contano come "sul percorso" (m). */
const ON_ROUTE_M = 80;

/** Risultato della misura dalla posizione GPS a un punto toccato. */
interface MeasureInfo {
  waiting: boolean;
  straightKm: number;
  /** Dislivello punto − posizione (m), dal modello del terreno. */
  dEle: number | null;
  targetEle: number | null;
  along: { km: number; ascent: number; descent: number; durationMin: number; behind: boolean } | null;
}

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
    recorded: { type: 'geojson', data: emptyLine() },
    'me-accuracy': { type: 'geojson', data: emptyLine() },
    measure: { type: 'geojson', data: emptyLine() },
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
    // traccia che si sta registrando col GPS
    {
      id: 'recorded-casing',
      type: 'line',
      source: 'recorded',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 7 },
    },
    {
      id: 'recorded-line',
      type: 'line',
      source: 'recorded',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#1c7ed6', 'line-width': 4 },
    },
    // cerchio di precisione della posizione GPS
    {
      id: 'me-accuracy',
      type: 'fill',
      source: 'me-accuracy',
      paint: { 'fill-color': '#228be6', 'fill-opacity': 0.15, 'fill-outline-color': '#228be6' },
    },
    // misura dalla posizione GPS a un punto toccato
    {
      id: 'measure-line',
      type: 'line',
      source: 'measure',
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': '#212529', 'line-width': 2.5, 'line-dasharray': [2, 2] },
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
  imports: [GpsBar],
  templateUrl: './map-view.html',
  styleUrl: './map-view.scss',
  host: {
    '[class.simple]': 'ui.simple()',
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
  private location = inject(LocationService);
  private recorder = inject(RecorderService);
  private nav = inject(NavigationService);
  private car = inject(CarService);
  protected ui = inject(UiModeService);
  private carMarker?: Marker;
  /** La mappa segue la posizione durante registrazione/navigazione, finché l'utente non la sposta. */
  protected readonly follow = signal(true);
  private meMarker?: Marker;
  private readonly gpsBusy = computed(() => this.recorder.state() !== 'idle' || this.nav.active());
  /** Punto toccato con il GPS attivo: se ne misurano distanza e dislivello dalla posizione attuale. */
  protected readonly measureTarget = signal<GeoLngLat | null>(null);
  protected readonly measure = signal<MeasureInfo | null>(null);
  protected readonly formatDuration = formatDuration;
  private measurePin?: Marker;
  private measureToken = 0;

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

    // traccia in registrazione
    effect(() => {
      const pts = this.recorder.points();
      if (!this.ready()) return;
      this.source('recorded').setData(
        pts.length > 1
          ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts.map((p) => [p[0], p[1]]) } }
          : emptyLine(),
      );
    });

    // all'avvio di registrazione o navigazione la mappa torna a seguire la posizione
    effect(() => {
      if (this.gpsBusy()) this.follow.set(true);
    });

    // posizione GPS: puntino, cerchio di precisione, mappa che segue
    effect(() => {
      const fix = this.location.fix();
      const busy = this.gpsBusy();
      const follow = this.follow();
      if (!this.ready() || !this.map) return;
      if (!fix || !busy) {
        this.meMarker?.remove();
        this.source('me-accuracy').setData(emptyLine());
        return;
      }
      this.meMarker ??= new maplibregl.Marker({ element: dot('me-dot') });
      this.meMarker.setLngLat([fix.lon, fix.lat]).addTo(this.map);
      this.source('me-accuracy').setData(accuracyCircle(fix.lon, fix.lat, fix.accuracy));
      if (follow) {
        untracked(() => this.map!.easeTo({ center: [fix.lon, fix.lat], zoom: Math.max(this.map!.getZoom(), 15), duration: 500 }));
      }
    });

    // auto parcheggiata
    effect(() => {
      const spot = this.car.car();
      if (!this.ready() || !this.map) return;
      if (!spot) {
        this.carMarker?.remove();
        return;
      }
      this.carMarker ??= new maplibregl.Marker({ element: dot('car-pin', '🚗') });
      this.carMarker.setLngLat([spot.lon, spot.lat]).addTo(this.map);
    });

    // scelta del parcheggio sulla mappa: cursore a croce
    effect(() => {
      const picking = this.car.picking();
      if (this.ready() && this.map) this.map.getCanvas().style.cursor = picking ? 'crosshair' : '';
    });

    // misura: si chiude da sola quando il GPS non è più in uso
    effect(() => {
      if (!this.gpsBusy()) this.measureTarget.set(null);
    });

    effect(() => {
      const target = this.measureTarget();
      const fix = this.location.fix();
      const track = this.store.track();
      if (!this.ready() || !this.map) return;
      if (!target) {
        this.measurePin?.remove();
        this.source('measure').setData(emptyLine());
        this.measure.set(null);
        return;
      }
      this.measurePin ??= new maplibregl.Marker({ element: dot('measure-pin'), anchor: 'bottom' });
      this.measurePin.setLngLat([target.lon, target.lat]).addTo(this.map);
      if (!fix) {
        this.measure.set({ waiting: true, straightKm: 0, dEle: null, targetEle: null, along: null });
        return;
      }
      this.source('measure').setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [[fix.lon, fix.lat], [target.lon, target.lat]] },
      });
      untracked(() => this.computeMeasure(fix, target, track));
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
      const locked = this.store.editLocked();
      if (!this.ready()) return;
      this.renderWaypoints(wps, locked);
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

    // se l'utente sposta la mappa durante registrazione/navigazione, smette di seguire la posizione
    map.on('dragstart', (e) => {
      if (e.originalEvent && this.gpsBusy()) this.follow.set(false);
    });

    map.on('click', (e) => {
      // "segna auto sulla mappa": il tocco segna il parcheggio, prima di ogni altra cosa
      if (this.car.picking()) {
        this.car.setAt({ lon: e.lngLat.lng, lat: e.lngLat.lat });
        return;
      }
      // un clic sulla linea del percorso non aggiunge tappe in fondo: la linea si trascina
      const onRoute = map.queryRenderedFeatures(e.point, { layers: ['route-hit'] }).length > 0;

      // con il GPS attivo un tocco non aggiunge tappe: misura distanza e dislivello da dove sei a quel punto
      if (this.gpsBusy()) {
        this.measureTarget.set({ lon: e.lngLat.lng, lat: e.lngLat.lat });
        return;
      }

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
      if (!this.drag) map.getCanvas().style.cursor = this.store.mode() === 'plan' && !this.store.editLocked() ? 'grab' : 'crosshair';
      this.store.hover.set({ dist, source: 'map' });
    });

    map.on('mouseleave', 'route-hit', () => {
      if (!this.drag) map.getCanvas().style.cursor = '';
      if (this.store.hover()?.source === 'map') this.store.hover.set(null);
    });

    // trascinando la linea del percorso si inserisce una tappa nel tratto corrispondente
    map.on('mousedown', 'route-hit', (e) => {
      const wps = this.store.waypoints();
      if (this.store.mode() !== 'plan' || this.store.editLocked() || wps.length < 2 || e.originalEvent.button !== 0) return;
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
      if (this.store.mode() !== 'plan' || this.store.editLocked() || this.store.waypoints().length < 2 || e.points.length !== 1) return;
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

    // il sistema può interrompere il gesto (es. notifica, gesto di navigazione): annullo senza inserire tappe
    map.on('touchcancel', () => {
      clearTimeout(this.longPress?.timer);
      this.longPress = null;
      if (!this.drag) return;
      this.drag = null;
      map.dragPan.enable();
      this.source('drag-preview').setData(emptyLine());
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
    if (this.store.mode() === 'plan' && !this.store.editLocked()) {
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

  /**
   * Distanza e dislivello dalla posizione al punto scelto; se entrambi stanno sul percorso caricato,
   * anche distanza, salita, discesa e tempo lungo il percorso (in avanti o all'indietro).
   */
  private async computeMeasure(fix: GeoLngLat, target: GeoLngLat, track: TrackPoint[]): Promise<void> {
    const token = ++this.measureToken;
    let along: MeasureInfo['along'] = null;
    if (track.length > 1) {
      const line = lineString(track.map((p) => [p.lon, p.lat]));
      const nf = nearestPointOnLine(line, point([fix.lon, fix.lat]), { units: 'kilometers' });
      const nt = nearestPointOnLine(line, point([target.lon, target.lat]), { units: 'kilometers' });
      if (nf.properties.dist * 1000 <= ON_ROUTE_M && nt.properties.dist * 1000 <= ON_ROUTE_M) {
        const a = track[0].dist + nf.properties.location;
        const b = track[0].dist + nt.properties.location;
        let part = sliceTrack(track, Math.min(a, b), Math.max(a, b));
        // punto alle spalle: il tratto si percorre al contrario (salita e discesa si scambiano)
        if (b < a) part = buildTrack(part.reverse().map((p) => [p.lon, p.lat, p.ele ?? NaN]));
        const st = computeStats(part);
        along = { km: st.distanceKm, ascent: st.ascent, descent: st.descent, durationMin: st.durationMin, behind: b < a };
      }
    }
    const prev = this.measure();
    this.measure.set({
      waiting: false,
      straightKm: haversineKm(fix, target),
      // la quota resta quella di prima finché non arriva il nuovo calcolo
      dEle: prev?.dEle ?? null,
      targetEle: prev?.targetEle ?? null,
      along,
    });
    const [p1, p2] = await this.elevation.fill([
      [fix.lon, fix.lat],
      [target.lon, target.lat],
    ]).catch(() => [[0, 0, NaN], [0, 0, NaN]]);
    if (token !== this.measureToken || !Number.isFinite(p1[2]) || !Number.isFinite(p2[2])) return;
    this.measure.update((m) => m && { ...m, dEle: p2[2] - p1[2], targetEle: p2[2] });
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

  /** locked: tappe bloccate (registrazione in corso), non si trascinano né si eliminano. */
  private renderWaypoints(wps: Waypoint[], locked: boolean): void {
    this.waypointMarkers.forEach((m) => m.remove());
    this.waypointMarkers = wps.map((w, i) => {
      const kind = i === 0 ? 'start' : i === wps.length - 1 ? 'end' : 'via';
      const el = dot(`wp wp-${kind}`, kind === 'via' ? String(i) : '');
      el.title = locked ? (w.name ?? '') : `${w.name ? w.name + '\n' : ''}Trascina per spostare · doppio clic per eliminare`;
      if (locked) el.style.cursor = 'default';
      el.addEventListener('click', (e) => e.stopPropagation());
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.store.removeWaypoint(i);
      });
      const marker = new maplibregl.Marker({ element: el, draggable: !locked }).setLngLat([w.lon, w.lat]).addTo(this.map!);
      marker.on('dragend', () => {
        const ll = marker.getLngLat();
        this.store.moveWaypoint(i, { lon: ll.lng, lat: ll.lat });
      });
      return marker;
    });
  }
}

/** Cerchio (poligono a 48 lati) di raggio r metri attorno a lon/lat, per la precisione del GPS. */
function accuracyCircle(lon: number, lat: number, r: number): GeoJSON.Feature {
  const dLat = r / 111320;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const ring = Array.from({ length: 49 }, (_, i) => {
    const a = (i / 48) * 2 * Math.PI;
    return [lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)];
  });
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

function dot(className: string, text = ''): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}
