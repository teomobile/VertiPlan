# Crinalia

Webapp Angular per pianificare escursioni: mappa OSM con i sentieri, percorso calcolato sui sentieri,
profilo altimetrico sincronizzato con la mappa, import/export GPX.

## Avvio

```bash
npm install
npm start
```

Poi apri http://localhost:4200.

## Uso

- **Clic sulla mappa**: aggiunge una tappa (la prima è la partenza). Trascina le tappe per spostarle, doppio clic per eliminarle.
- **Tappe come testo**: nel pannello scrivi un luogo (rifugio, cima, paese) o delle coordinate `lat, lon`. Clic sul nome di una tappa per sostituirla, frecce per riordinare.
- **Profilo altimetrico**: passa il mouse sul grafico per vedere il punto sulla mappa, o sul percorso per vedere il punto sul grafico. Trascina sul grafico per selezionare un tratto (statistiche del tratto nel pannello).
- **GPX**: "Importa GPX" oppure trascina il file sulla mappa. Se il GPX non ha le quote vengono prese dal modello del terreno.
- Il percorso pianificato resta salvato nel browser (localStorage).

## Sentieri SAT (Trentino)

Il layer "Sentieri SAT" legge `public/data/sat-sentieri.geojson`, generato dai tracciati ufficiali SAT
(© SAT - Società degli Alpinisti Tridentini, licenza ODbL 1.0). La SAT li aggiorna a inizio mese; per rigenerarli:

```bash
curl -o data/sat-raw/sentierisat.kml.zip https://sentieri.sat.tn.it/download/sentierisat.kml.zip
```

```bash
unzip -o data/sat-raw/sentierisat.kml.zip -d data/sat-raw
```

```bash
node scripts/build-sat.mjs data/sat-raw/sentieri_tratte.kml
```

Colori: T verde, E rosso, EE viola tratteggiato, EEA (ferrate) nero puntinato. Passando col mouse su un sentiero
si vede la scheda (numero, località, quote, lunghezza, tempi).

## Servizi esterni

| Cosa | Servizio | Note |
|---|---|---|
| Mappa base | tile.openstreetmap.org, OpenTopoMap | Rispettare le policy d'uso: niente download massivi |
| Sentieri | Waymarked Trails (overlay hiking) | Spento di default, si accende da "Sentieri OSM" |
| Ricerca luoghi | Photon (photon.komoot.io) | Ricerca e nome automatico delle tappe |
| Font etichette | OpenFreeMap | |
| Calcolo percorso | BRouter pubblico (brouter.de) | Profili `hiking-mountain`, `hiking-beta`, `trekking` |
| Quote | Open-Meteo Elevation API (Copernicus DEM 90 m) | Solo per le tracce senza quota |

## Struttura

```
src/app/
  core/
    geo.ts               calcoli su traccia: distanze, interpolazione, statistiche (DIN 33466)
    gpx.ts               parsing ed export GPX
    routing.service.ts   BRouter, con cache per tratto
    elevation.service.ts quote mancanti da Open-Meteo
    route-store.ts       stato condiviso (signals): tappe, traccia, hover, selezione
  map-view/              MapLibre: livelli, tappe, marker di hover
  elevation-profile/     grafico uPlot sincronizzato
  sidebar/               statistiche, tappe, azioni
```

## Prossimi passi

- Scheda sentiero SAT anche al tocco (mobile) e "aggiungi questo sentiero al percorso"
- Inserire una tappa intermedia trascinando la linea del percorso
- Ombreggiatura del rilievo e rilievo 3D (dati DEM in formato terrain-RGB)
- Percorsi salvati multipli / backend
- App Android con Capacitor, mappe offline in PMTiles
