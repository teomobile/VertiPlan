import { gpx } from '@tmcw/togeojson';
import { TrackPoint, Waypoint } from './geo';

export interface ParsedGpx {
  name: string;
  coords: number[][];
}

/** Legge tracce (trk) e rotte (rte) di un GPX e le unisce in un'unica linea. */
export function parseGpx(xml: string, fallbackName: string): ParsedGpx {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('File GPX non valido');

  const fc = gpx(doc);
  const coords: number[][] = [];
  let name = '';
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'LineString') coords.push(...g.coordinates);
    else if (g.type === 'MultiLineString') g.coordinates.forEach((line) => coords.push(...line));
    else continue;
    name ||= (f.properties?.['name'] as string | undefined) ?? '';
  }
  if (coords.length < 2) throw new Error('Il GPX non contiene tracce');
  return { name: name || fallbackName, coords };
}

function esc(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function buildGpx(name: string, points: TrackPoint[], waypoints: Waypoint[]): string {
  const wpts = waypoints
    .map((w, i) => `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}"><name>${esc(w.name ?? `Tappa ${i + 1}`)}</name></wpt>`)
    .join('\n');
  const trkpts = points
    .map((p) => {
      const ele = p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : '';
      return `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${ele}</trkpt>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="VertiPlan" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name><time>${new Date().toISOString()}</time></metadata>
${wpts}
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

export function downloadText(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
