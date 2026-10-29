# VertiPlan — Handoff

Documento per riprendere il lavoro da zero (nuovo account, nuovo assistente, nuovo PC).
**Va aggiornato alla fine di ogni blocco di lavoro**: sezioni "Stato", "Prossimi passi" e "Registro".

Ultimo aggiornamento: **2026-10-29** — rinomina in VertiPlan e repo su GitHub (vedi Registro).

---

## 1. In breve

**VertiPlan** è una webapp di mappe outdoor ispirata a mapy.cz, centrata su Trentino e Alpi orientali:
mappa con sentieri, pianificazione di percorsi a piedi, altimetria sincronizzata con la mappa, GPX,
libreria personale, percorsi consigliati, strumenti per lo sci alpinismo (pendenze, bollettino valanghe).

- Obiettivo finale: webapp + **app Android** (stesso codice Angular impacchettato con **Capacitor**) con uso **offline**.
- Utenti previsti: pochi (uso personale/gruppo). Per questo usiamo servizi pubblici gratuiti senza backend.
- Nome scelto dall'utente il 2026-10-29: **VertiPlan** (prima si chiamava "Crinalia"). Registro dei marchi **non verificato**.
- Gli identificativi di salvataggio nel browser restano quelli storici (`crinalia.route.v1`, IndexedDB `crinalia`):
  **non rinominarli**, si perderebbero i percorsi salvati. La cartella del progetto resta `MapyRep`.

## 2. Come riprendere (checklist per un nuovo account)

1. Apri la cartella `C:\Users\Matteo\Desktop\GestioneCorsi\MapyRep` (repo git, branch `master`, remote `origin` =
   https://github.com/teomobile/VertiPlan.git). Su un altro PC: `git clone https://github.com/teomobile/VertiPlan.git`.
2. Leggi questo file e il [README.md](README.md) (uso e struttura).
3. `npm install` (solo se manca `node_modules`), poi `npm start` → http://localhost:4200.
4. Controlla `git log --oneline` e `git status`: il registro in fondo a questo file deve corrispondere all'ultimo commit.
5. Se usi Claude Code: il file [CLAUDE.md](CLAUDE.md) fa leggere questo handoff in automatico e ricorda di aggiornarlo.

Requisiti: Node 22, npm 10, Angular CLI 20 (anche via `npx ng`). Sviluppato su Windows 11.

> Dopo ogni commit fare `git push`, così GitHub resta allineato. Il KML scaricato della SAT (`data/sat-raw/`) non è
> nel repo: si riscarica con i comandi del §6 (il GeoJSON generato invece è versionato).

## 3. Avvio, build, comandi utili

```bash
npm start                                   # dev server su http://localhost:4200
npx ng build                                # build di produzione in dist/vertiplan
node scripts/build-sat.mjs data/sat-raw/sentieri_tratte.kml   # rigenera il layer SAT (vedi §6)
```

- **Cache di build corrotta**: se `ng build` e `ng serve` girano insieme si rovina `.angular/cache/.../.tsbuildinfo`
  (errore "Debug Failure. Expected ... .tsbuildinfo"). Soluzione: cancellare quel file, oppure buildare con
  `NG_PERSISTENT_BUILD_CACHE=0 npx ng build`, oppure fermare `ng serve` prima della build.
- In modalità sviluppo la mappa è esposta come `window.vertiplanMap` (debug dalla console).
- Il percorso pianificato corrente sta in `localStorage` (`crinalia.route.v1`); la libreria in IndexedDB (db `crinalia`):
  nomi storici, da non cambiare.

## 4. Stack e architettura

- **Angular 20**, standalone components, **signals**, **zoneless** (`provideZonelessChangeDetection`, niente zone.js).
- **MapLibre GL JS 5** per la mappa (raster OSM/OpenTopoMap + layer GeoJSON + raster-dem).
- **uPlot** per l'altimetria, **@tmcw/togeojson** per leggere i GPX, **@turf/nearest-point-on-line** per agganciare il mouse alla traccia.
- Nessun backend. Tutti i dati arrivano da servizi pubblici o da file statici in `public/`.

Struttura (`src/app/`):

| File | Ruolo |
|---|---|
| `core/route-store.ts` | Stato centrale (signals): tappe, traccia, hover/selezione, salvataggio, import GPX, ricalcolo percorso |
| `core/geo.ts` | Calcoli: distanze, interpolazione, statistiche DIN 33466, pendenze, classi di colore |
| `core/routing.service.ts` | BRouter (cache per tratto tra due tappe) |
| `core/elevation.service.ts` | Quote e pendenza del terreno dalle Terrain Tiles (cache LRU delle tile) |
| `core/geocoding.service.ts` | Ricerca luoghi e nome automatico delle tappe (Photon) |
| `core/gpx.ts` | Parsing ed export GPX |
| `core/library.service.ts` | "I miei percorsi" in IndexedDB |
| `core/recommended-routes.service.ts` | Percorsi segnati OSM (API Waymarked Trails) |
| `core/avalanche.service.ts` | Bollettino Euregio CAAML v6 + microzone EAWS (stato condiviso, point-in-polygon) |
| `core/route-analysis.service.ts` | Inclinazione del terreno e pericolo valanghe lungo il percorso |
| `map-view/` | Mappa: livelli, tappe, trascinamento linea, popup SAT, riquadro valanghe |
| `map-view/sat-layer.ts`, `terrain-layers.ts`, `avalanche-layer.ts` | Definizioni dei layer; `terrain-layers` registra il protocollo `slope://` |
| `elevation-profile/` | Altimetria uPlot: colori per pendenza, striscia pendii ≥30°, sincronizzazione con la mappa |
| `sidebar/` | Pannello con 3 schede: Pianifica, Consigliati, I miei percorsi |
| `place-search/`, `routes-panel/`, `library-panel/` | Componenti delle schede |
| `scripts/build-sat.mjs` | Converte il KML SAT nel GeoJSON `public/data/sat-sentieri.geojson` |

## 5. Funzionalità attuali (stato al 2026-10-29)

- **Telefono** (schermi ≤ 800 px): mappa a tutto schermo, pannello come **cassetto dal basso** (chiuso con riepilogo / metà / quasi pieno, tocco o scorrimento sulla maniglia), livelli dietro il pulsante "☰ Livelli", crediti compatti dietro la "i".
- **Tocco** (dispositivi senza mouse, `hover: none`): tocco su un sentiero SAT → scheda con "+ Tappa qui"; con il layer valanghe acceso il tocco aggiorna il riquadro della microzona; sulla linea del percorso **tieni premuto ~0,4 s e trascina** per inserire una tappa (uno scorrimento normale sposta la mappa).

- Mappa OSM / OpenTopoMap, rilievo ombreggiato, vista 3D.
- Layer **Sentieri SAT** (1082 sentieri ufficiali, colori per difficoltà T/E/EE/EEA, numero, scheda al passaggio del mouse) e overlay **Sentieri OSM** (Waymarked Trails, spento di default).
- **Pianificazione**: tappe con clic, testo (luoghi o `lat, lon`) o **trascinando la linea**; riordino, sostituzione, nome automatico; profili BRouter (montagna, facile, trekking, linea retta).
- **Altimetria** colorata per pendenza, sincronizzata con la mappa nei due sensi, selezione di un tratto con statistiche; pendenza massima; tempo DIN 33466.
- **GPX**: import (anche drag&drop, quote mancanti completate), export.
- **I miei percorsi**: salvataggio automatico dei GPX importati, "Salva" per pianificati/consigliati, riapertura, rinomina, eliminazione, export.
- **Percorsi consigliati**: lista per zona inquadrata (internazionali→locali), scheda, "Usa come percorso".
- **Pendenze ≥ 30°**: carta dell'inclinazione per lo sci alpinismo, calcolata nel browser (Horn) — verificata con metodo indipendente (scarto ~2°).
- **Valanghe**: bollettino Euregio con microzone colorate, dettaglio per quota/fascia oraria/problemi, archivio per data, avviso fuori stagione.
- **Terreno e valanghe lungo il percorso**: pendio max attraversato, metri su ≥30/35/40/45°, alone in mappa, microzone attraversate con grado alle quote del percorso.

## 6. Servizi esterni, dati e licenze

| Cosa | Fonte | Licenza / note |
|---|---|---|
| Mappa base | tile.openstreetmap.org, tile.opentopomap.org | ODbL / CC-BY-SA. Rispettare le policy: **niente download massivi** (vietato per l'offline) |
| Sentieri OSM | tile.waymarkedtrails.org (hiking) | OSM ODbL |
| Sentieri SAT | Download manuale da https://www.sat.tn.it/sentieri/mappa-sentieri/ (`sentierisat.kml.zip`) | **ODbL 1.0** — attribuzione "© SAT" in mappa. Aggiornati a inizio mese |
| Calcolo percorsi | https://brouter.de (server pubblico) | Gratuito, va bene per pochi utenti |
| Ricerca luoghi | https://photon.komoot.io (`lang=default`, `it` non supportato) | Dati OSM |
| Quote e pendenze | Terrain Tiles AWS (terrarium) | EU-DEM/SRTM ~30 m, senza limiti di richieste |
| Percorsi consigliati | https://hiking.waymarkedtrails.org/api/v1 (bbox in EPSG:3857) | OSM ODbL |
| Bollettino valanghe | https://avalanche.report/bulletins/latest/EUREGIO_it_CAAMLv6.json e archivio `bulletins/AAAA-MM-GG/AAAA-MM-GG_EUREGIO_it_CAAMLv6.json` | **CC BY 4.0** |
| Microzone valanghe | https://regions.avalanches.org/micro-regions/{IT-32-TN,IT-32-BZ,AT-07}_micro-regions.geojson.json | CC0 |
| Font etichette | tiles.openfreemap.org/fonts | — |

Per aggiornare i sentieri SAT (il KML scaricato sta in `data/sat-raw/`, escluso da git):

```bash
curl -o data/sat-raw/sentierisat.kml.zip https://sentieri.sat.tn.it/download/sentierisat.kml.zip
unzip -o data/sat-raw/sentierisat.kml.zip -d data/sat-raw
node scripts/build-sat.mjs data/sat-raw/sentieri_tratte.kml
```

## 7. Decisioni prese (e perché)

- **Un solo codice Angular + Capacitor** invece di webapp e app separate: riuso ~95%.
- **OpenAndroMaps scartate**: formato Mapsforge non leggibile dal browser e licenza che **vieta l'integrazione in app** senza permesso scritto (il tema Elevate richiede un permesso a parte). Per l'offline: generare **PMTiles** propri da OSM (es. Planetiler).
- **Open-Meteo per le quote abbandonato**: conta ogni punto come una chiamata (~600/min) → errore 429 con tracce lunghe. Sostituito dalle Terrain Tiles.
- **Waymarked Trails spento di default** quando c'è il layer SAT: disegnano gli stessi sentieri e la mappa diventava illeggibile.
- **Microzone valanghe**: i file EAWS contengono zone "madri" e sottozone sovrapposte; teniamo solo quelle senza figlie (il bollettino usa le sottozone).
- **Limite del bosco** del bollettino stimato a **2000 m** nei calcoli lungo il percorso (dichiarato nell'interfaccia).
- **Pendenze dell'altimetria su tratti ≥ 100 m**: più corti seguirebbero il rumore del DEM.
- Percorsi con biforcazioni (Waymarked): "Usa come percorso" prende il ramo di andata.

## 8. Problemi noti e limiti

- Il tocco è stato verificato con l'emulazione telefono del browser e eventi touch simulati, **non ancora su un telefono vero**.
- L'altimetria (uPlot) al tocco non è ottimizzata: il cursore segue il dito solo in parte.
- Correzione dello z-index della scheda SAT sopra il pannello livelli: **non verificata a schermo**.
- DEM a ~30 m: canali stretti e ripidi possono risultare sottostimati. Possibile migliorare col LiDAR della Provincia di Trento.
- Il bollettino è stagionale: fuori stagione (maggio→dicembre) l'ultimo disponibile è scaduto, l'app lo segnala.
- La libreria è **solo nel browser** (IndexedDB): non sincronizzata tra dispositivi.
- Nessun test automatico (priorità: `geo.ts` e `gpx.ts`).
- Dipendenza da servizi pubblici gratuiti (BRouter, Photon, Waymarked, tile OSM): ok per pochi utenti, non per un prodotto.
- Ricerca luoghi: alcuni toponimi locali non esistono in OSM (es. "Viote" restituisce Caldes, non il Bondone).

## 9. Prossimi passi (in ordine di priorità suggerito)

1. **App Android** con Capacitor (tappa 2 del piano mobile): servono Android Studio e JDK; poi GPS (tappa 3: posizione, registrazione traccia, navigazione) e offline (tappa 4: PMTiles per zona).
2. **Backend leggero**: account, sincronizzazione della libreria, condivisione di un percorso via link.
3. Altimetria al tocco; prova su telefono vero.
4. **POI** (rifugi, bivacchi, fontane, parcheggi) e **meteo** lungo il percorso (Open-Meteo forecast).
5. Layer **MTB** (stessa API Waymarked), **piste** (OpenSnowMap), **sentieri chiusi** (fonte da trovare).
6. **Test** su `geo.ts` e GPX; **pagina crediti/licenze**.
7. Server BRouter proprio e cache delle tile se gli utenti crescono.

## 10. Convenzioni di lavoro

- Interfaccia, commenti nel codice e messaggi di commit **in italiano**.
- Commit solo quando l'utente lo chiede; messaggi descrittivi con elenco puntato; branch `master`.
- Prima di scaricare file da fonti esterne si chiede conferma (nome, fonte, dimensione).
- Ogni funzionalità viene provata nel browser prima del commit; i calcoli critici (pendenze, quote) verificati con un metodo indipendente.
- Stile codice: signals, `inject()`, control flow `@if/@for`, componenti con file separati `.ts/.html/.scss`, nomi Angular 20 (`map-view.ts` → classe `MapView`).

## 11. Registro

| Data | Commit | Cosa |
|---|---|---|
| 2026-10-24 | `5889cb8` | Progetto Angular creato |
| 2026-10-25 | `4750a34` | MVP: mappa, SAT, pianificazione BRouter, altimetria sincronizzata, GPX, tappe come testo |
| 2026-10-25 | `c797a46` | Percorsi consigliati (Waymarked) e quote dalle Terrain Tiles |
| 2026-10-25 | `556a7d2` | Libreria "I miei percorsi" (IndexedDB) |
| 2026-10-25 | `1ce3870` | Pendenza sull'altimetria, rilievo, 3D, carta pendenze ≥30° |
| 2026-10-26 | `d2efead` | Bollettino valanghe Euregio |
| 2026-10-26 | `93f7b9c` | Terreno e valanghe lungo il percorso; tappe trascinando la linea |
| 2026-10-29 | `fdee9ff` | Handoff e CLAUDE.md |
| 2026-10-29 | `97d8c2f` | Adattamento a telefono: cassetto dal basso, livelli richiudibili, tocco su SAT/valanghe, trascinamento linea con pressione prolungata |
| 2026-10-29 | (questo commit) | App rinominata da Crinalia a **VertiPlan**; repo pubblicato su github.com/teomobile/VertiPlan |
