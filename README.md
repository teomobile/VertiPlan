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
- **Pendenza**: il profilo altimetrico è colorato per pendenza (tratti di almeno 100 m), con pendenza massima in salita e discesa nelle statistiche e nel tratto selezionato.
- **Terreno**: "Rilievo" (ombreggiatura), "3D" (rilievo inclinabile, trascina col tasto destro per ruotare) e "Pendenze ≥ 30°": carta dell'inclinazione del pendio per lo sci alpinismo (30–35°, 35–40°, 40–45°, > 45°), calcolata nel browser dalle Terrain Tiles con il metodo di Horn. Visibile da zoom 12. Risoluzione del modello ~30 m: i pendii ripidi ma brevi possono risultare sottostimati.
- **Valanghe**: bollettino Euregio (Trentino, Alto Adige, Tirolo) con microzone colorate per grado di pericolo (scala EAWS 1–5). Passando su una zona: grado per quota e fascia oraria, problemi valanghivi con esposizioni, sintesi. Con la data si consultano i bollettini archiviati; fuori stagione l'app avvisa che l'ultimo bollettino è scaduto.
- **I miei percorsi**: i GPX importati vengono salvati automaticamente (senza doppioni); "Salva" conserva anche i percorsi pianificati (che si riaprono modificabili) e quelli consigliati. Da qui si riaprono, rinominano, eliminano e scaricano come GPX. I dati stanno in IndexedDB, solo in questo browser.
- **Percorsi consigliati**: nella scheda omonima trovi i percorsi segnati nella zona inquadrata. Clic per vederlo in mappa con la scheda, "Usa come percorso" per caricarlo con altimetria ed export GPX.
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
| Quote | Terrain Tiles su AWS Open Data (EU-DEM / SRTM, ~30 m) | Lette dai pixel delle tile, solo per le tracce senza quota |
| Bollettino valanghe | avalanche.report (Euregio), CAAML v6 JSON | CC BY 4.0; microzone EAWS (regions.avalanches.org), CC0 |
| Percorsi consigliati | API Waymarked Trails | Percorsi escursionistici segnati in OSM (internazionali → locali) |

## Struttura

```
src/app/
  core/
    geo.ts               calcoli su traccia: distanze, interpolazione, statistiche (DIN 33466)
    gpx.ts               parsing ed export GPX
    routing.service.ts   BRouter, con cache per tratto
    elevation.service.ts quote mancanti dalle tile Terrarium
    recommended-routes.service.ts  percorsi segnati (Waymarked Trails)
    library.service.ts   "I miei percorsi" in IndexedDB
  routes-panel/          scheda "Percorsi consigliati": lista, dettaglio, "Usa come percorso"
  library-panel/         scheda "I miei percorsi": apri, rinomina, elimina, scarica GPX
    route-store.ts       stato condiviso (signals): tappe, traccia, hover, selezione
  map-view/              MapLibre: livelli, tappe, marker di hover
    terrain-layers.ts    rilievo, 3D e protocollo slope:// per la carta delle pendenze
    avalanche-layer.ts   microzone colorate per grado di pericolo
  elevation-profile/     grafico uPlot sincronizzato
  sidebar/               statistiche, tappe, azioni
```

## Prossimi passi

- Scheda sentiero SAT anche al tocco (mobile) e "aggiungi questo sentiero al percorso"
- Inserire una tappa intermedia trascinando la linea del percorso
- Ombreggiatura del rilievo e rilievo 3D (dati DEM in formato terrain-RGB)
- Percorsi salvati multipli / backend
- App Android con Capacitor, mappe offline in PMTiles
