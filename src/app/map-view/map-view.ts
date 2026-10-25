import { afterNextRender, Component, effect, ElementRef, inject, isDevMode, OnDestroy, signal, viewChild } from '@angular/core';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import { lineString, point } from '@turf/helpers';
import maplibregl, { GeoJSONSource, LngLatBounds, Map as MlMap, Marker, StyleSpecification } from 'maplibre-gl';
import { pointAtDistance, sliceTrack, TrackPoint, Waypoint } from '../core/geo';
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

type BaseLayer = 'osm' | 'otm';

const BASE_LAYERS: { id: BaseLayer; label: string }[] = [
  { id: 'osm', label: 'OpenStreetMap' },
  { id: 'otm', label: 'Topografica' },
];

const START_CENTER: [number, number] = [11.12, 46.07]; // Trento

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
    sat: SAT_SOURCE,
    recommended: {
      type: 'geojson',
      data: emptyLine(),
      attribution: 'Percorsi © <a href="https://hiking.waymarkedtrails.org">Waymarked Trails</a> / OSM',
    },
    route: { type: 'geojson', data: emptyLine() },
    selection: { type: 'geojson', data: emptyLine() },
  },
  layers: [
    { id: 'osm', type: 'raster', source: 'osm' },
    { id: 'otm', type: 'raster', source: 'otm', layout: { visibility: 'none' } },
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
  protected readonly dragging = signal(false);

  private container = viewChild.required<ElementRef<HTMLDivElement>>('map');
  private map?: MlMap;
  private readonly ready = signal(false);
  private waypointMarkers: Marker[] = [];
  private hoverMarker?: Marker;
  private satLoaded = false;
  private satPopup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    className: 'sat-popup',
    maxWidth: '280px',
    offset: 12,
  });

  constructor() {
    afterNextRender(() => {
      this.map = new maplibregl.Map({
        container: this.container().nativeElement,
        style: STYLE,
        center: START_CENTER,
        zoom: 11,
        maxZoom: 19,
        doubleClickZoom: false,
      });
      this.map.addControl(new maplibregl.NavigationControl(), 'top-right');
      this.map.addControl(
        new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }),
        'top-right',
      );
      this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
      this.map.on('load', () => this.ready.set(true));
      this.bindEvents(this.map);
      // per il debug dalla console del browser
      if (isDevMode()) (window as unknown as { crinaliaMap: MlMap }).crinaliaMap = this.map;
    });

    // traccia
    effect(() => {
      const track = this.store.track();
      if (!this.ready()) return;
      this.source('route').setData(toLine(track));
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
      if (this.store.mode() === 'track') return;
      this.store.addWaypoint({ lon: e.lngLat.lng, lat: e.lngLat.lat });
    });

    map.on('mousemove', 'route-hit', (e) => {
      const track = this.store.track();
      if (track.length < 2) return;
      map.getCanvas().style.cursor = 'crosshair';
      const line = lineString(track.map((p) => [p.lon, p.lat]));
      const nearest = nearestPointOnLine(line, point([e.lngLat.lng, e.lngLat.lat]), { units: 'kilometers' });
      // la distanza di turf è geodetica come la nostra: aggiungo l'offset del primo punto
      this.store.hover.set({ dist: track[0].dist + nearest.properties.location, source: 'map' });
    });

    map.on('mouseleave', 'route-hit', () => {
      map.getCanvas().style.cursor = '';
      if (this.store.hover()?.source === 'map') this.store.hover.set(null);
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
