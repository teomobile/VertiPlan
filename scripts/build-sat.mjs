// Converte il KML dei sentieri SAT (https://www.sat.tn.it/sentieri/mappa-sentieri/) in un GeoJSON
// leggero per l'app: coordinate a 5 decimali (~1 m) e linee semplificate (Douglas-Peucker, ~3 m).
//
// Uso:  node scripts/build-sat.mjs <sentieri_tratte.kml> [output.geojson]
// Dati: © SAT - Società degli Alpinisti Tridentini, licenza ODbL 1.0.

import { readFileSync, writeFileSync } from 'node:fs';

const [input, output = 'public/data/sat-sentieri.geojson'] = process.argv.slice(2);
if (!input) {
  console.error('Uso: node scripts/build-sat.mjs <sentieri_tratte.kml> [output.geojson]');
  process.exit(1);
}

const TOLERANCE_DEG = 0.00003;

const ENTITIES = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };
const decode = (s) =>
  s.replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENTITIES[e] ?? m),
  );

const MINOR = new Set(
  'a ai al alla alle agli con d da dal dalla dalle dai dagli de dei del della delle degli di e ed in la le lo per su sul sulla sulle sui'.split(' '),
);

/** "SENTIERO DELLE CRESTINE" -> "Sentiero delle Crestine" */
const titleCase = (s) =>
  s
    .toLocaleLowerCase('it')
    .replace(/(^|[\s"'(\-/.])(\p{L}+)/gu, (_, sep, word, offset) =>
      sep + (offset > 0 && MINOR.has(word) ? word : word[0].toLocaleUpperCase('it') + word.slice(1)),
    )
    .replace(/\bSat\b/g, 'SAT');

function simplify(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const kml = readFileSync(input, 'utf8');
const features = [];
let pointsIn = 0;
let pointsOut = 0;

for (const [, body] of kml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)) {
  const data = {};
  for (const [, k, v] of body.matchAll(/<SimpleData name="(\w+)">([^<]*)<\/SimpleData>/g)) data[k] = decode(v).trim();

  const coordsText = body.match(/<coordinates>([^<]*)<\/coordinates>/)?.[1];
  if (!coordsText) continue;
  const coords = coordsText
    .trim()
    .split(/\s+/)
    .map((c) => c.split(',').slice(0, 2).map(Number));
  pointsIn += coords.length;
  const line = simplify(coords, TOLERANCE_DEG).map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
  pointsOut += line.length;

  const int = (k) => (data[k] ? parseInt(data[k], 10) : null);
  features.push({
    type: 'Feature',
    properties: {
      numero: data.numero,
      // per le etichette: "E101" -> "101"
      ref: data.numero?.replace(/^[A-Z]/, ''),
      nome: data.denominaz ? titleCase(data.denominaz) : '',
      difficolta: data.difficolta,
      da: titleCase(data.loc_inizio ?? ''),
      a: titleCase(data.loc_fine ?? ''),
      quota_min: int('quota_min'),
      quota_max: int('quota_max'),
      lunghezza_m: int('lun_inclin') ?? int('lun_planim'),
      t_andata: data.t_andata || null,
      t_ritorno: data.t_ritorno || null,
      gruppo: data.gr_mont ? titleCase(data.gr_mont) : '',
      gestione: data.competenza ? titleCase(data.competenza) : '',
    },
    geometry: { type: 'LineString', coordinates: line },
  });
}

const geojson = {
  type: 'FeatureCollection',
  attribution: '© SAT - Società degli Alpinisti Tridentini, ODbL 1.0',
  generated: new Date().toISOString(),
  features,
};
writeFileSync(output, JSON.stringify(geojson));
const kb = Math.round(Buffer.byteLength(JSON.stringify(geojson)) / 1024);
console.log(`${features.length} sentieri, punti ${pointsIn} -> ${pointsOut}, ${kb} kB -> ${output}`);
