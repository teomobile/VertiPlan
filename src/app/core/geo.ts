/** Punto della traccia: coordinate, quota (m) e distanza progressiva dall'inizio (km). */
export interface TrackPoint {
  lon: number;
  lat: number;
  ele: number | null;
  dist: number;
}

export interface LngLat {
  lon: number;
  lat: number;
}

export interface Waypoint extends LngLat {
  name?: string;
}

export interface TrackStats {
  distanceKm: number;
  ascent: number;
  descent: number;
  minEle: number | null;
  maxEle: number | null;
  /** Tempo stimato in minuti (DIN 33466). */
  durationMin: number;
}

const EARTH_RADIUS_KM = 6371.0088;

export function haversineKm(a: LngLat, b: LngLat): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Converte coordinate [lon, lat, ele?] in punti con distanza progressiva. */
export function buildTrack(coords: number[][]): TrackPoint[] {
  const points: TrackPoint[] = [];
  for (const c of coords) {
    const prev = points[points.length - 1];
    const p: TrackPoint = { lon: c[0], lat: c[1], ele: c.length > 2 && Number.isFinite(c[2]) ? c[2] : null, dist: 0 };
    if (prev) {
      const d = haversineKm(prev, p);
      // salta i punti duplicati: rompono la ricerca per distanza
      if (d === 0) continue;
      p.dist = prev.dist + d;
    }
    points.push(p);
  }
  return points;
}

/** Indice del primo punto con dist >= d (ricerca binaria). */
function indexAtDistance(points: TrackPoint[], d: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].dist < d) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Punto interpolato alla distanza d (km) lungo la traccia. */
export function pointAtDistance(points: TrackPoint[], d: number): TrackPoint | null {
  if (points.length === 0) return null;
  if (d <= 0) return points[0];
  const last = points[points.length - 1];
  if (d >= last.dist) return last;
  const i = indexAtDistance(points, d);
  const a = points[i - 1];
  const b = points[i];
  const t = (d - a.dist) / (b.dist - a.dist);
  const ele = a.ele != null && b.ele != null ? a.ele + (b.ele - a.ele) * t : (a.ele ?? b.ele);
  return { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t, ele, dist: d };
}

/** Porzione di traccia tra due distanze, con estremi interpolati. */
export function sliceTrack(points: TrackPoint[], from: number, to: number): TrackPoint[] {
  if (points.length < 2) return points;
  const start = pointAtDistance(points, from)!;
  const end = pointAtDistance(points, to)!;
  const inner = points.filter((p) => p.dist > from && p.dist < to);
  return [start, ...inner, end];
}

/**
 * Statistiche della traccia. Dislivello calcolato con isteresi per non sommare
 * il rumore delle quote (GPS o modello del terreno).
 */
export function computeStats(points: TrackPoint[], hysteresisM = 5): TrackStats {
  let ascent = 0;
  let descent = 0;
  let minEle: number | null = null;
  let maxEle: number | null = null;
  let ref: number | null = null;

  for (const p of points) {
    if (p.ele == null) continue;
    minEle = minEle == null ? p.ele : Math.min(minEle, p.ele);
    maxEle = maxEle == null ? p.ele : Math.max(maxEle, p.ele);
    if (ref == null) {
      ref = p.ele;
      continue;
    }
    const diff = p.ele - ref;
    if (diff >= hysteresisM) {
      ascent += diff;
      ref = p.ele;
    } else if (diff <= -hysteresisM) {
      descent -= diff;
      ref = p.ele;
    }
  }

  const distanceKm = points.length ? points[points.length - 1].dist - points[0].dist : 0;
  // DIN 33466: 4 km/h in piano, 300 m/h in salita, 500 m/h in discesa
  const horizontal = distanceKm / 4;
  const vertical = ascent / 300 + descent / 500;
  const hours = Math.max(horizontal, vertical) + Math.min(horizontal, vertical) / 2;

  return { distanceKm, ascent, descent, minEle, maxEle, durationMin: Math.round(hours * 60) };
}

export function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} h ${m.toString().padStart(2, '0')}` : `${m} min`;
}
