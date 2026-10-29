# Crinalia — istruzioni per l'assistente

Webapp Angular 20 di mappe outdoor (Trentino), futura app Android con Capacitor.

@HANDOFF.md

## Regole

- All'inizio di una sessione leggi `HANDOFF.md`: contiene stato, architettura, servizi esterni, decisioni e prossimi passi.
- **Alla fine di ogni blocco di lavoro aggiorna `HANDOFF.md`**: data e commit in cima, sezione "Funzionalità attuali",
  "Problemi noti", "Prossimi passi" e una riga nel "Registro". Includilo nello stesso commit della modifica.
- Interfaccia, commenti e messaggi di commit in italiano. Commit solo su richiesta dell'utente.
- Chiedi conferma prima di scaricare file da fonti esterne.
- Se `ng build` fallisce con "Debug Failure ... .tsbuildinfo", usa `NG_PERSISTENT_BUILD_CACHE=0 npx ng build`
  (la cache si rovina se gira anche `ng serve`).
