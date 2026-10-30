# Social Scheduler

Pubblica in automatico su Facebook e Instagram i post del **piano** (cartella `piano/`),
usando le API ufficiali di Meta. Gira su GitHub Actions ogni 15 minuti.

- `piano/*.json` – i post da pubblicare (li prepara Claude ogni mese)
- `media/` – immagini e video dei post (serviti da GitHub Pages)
- `pages.json` – le Pagine Facebook gestite (nome breve → ID Pagina)
- `config.json` – impostazioni (indirizzo dei media, versione API)
- `state/published.json` – cosa è già stato pubblicato (aggiornato in automatico)
- `src/publish.js` – lo script di pubblicazione
- `.github/workflows/pubblica.yml` – l'automazione (quando gira lo script)

Formato di un post nel piano:

```json
{ "id": "ale-2026-12-01", "pagina": "alessio", "quando": "2026-12-01T19:00:00+01:00",
  "piattaforme": ["facebook", "instagram"], "tipo": "immagine",
  "testo": "Testo del post", "file": "media/2026-12/01.png" }
```
`tipo`: `testo` (solo Facebook), `immagine`, `reel`.
