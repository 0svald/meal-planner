# Menu di famiglia

Mobile web app to pick the week's home meals around the children's school canteen
lunches, and turn the plan into a shopping list. Companion to the
`family-meal-planner` Claude skill. See `CLAUDE.md` for the constraints and
`PLAN.md` for the build phases.

Status: **phase E**, all phases of `PLAN.md` built: the week with three options
per meal and live feedback on the rules (`plans.json`); the shopping list,
checkable and shared in one tap, with the pantry edited in the app
(`pantry.json`); the recipe wishlist for the skill to load (`wishlist.json`,
`docs/skill-integration.md`); installable, and it opens without a connection.
Engine: `docs/engine.md`.

## Layout

| Path | What |
| --- | --- |
| `engine/` | shared rules engine, pure ES modules (browser + Node) |
| `scripts/propose.js` | prints the proposals for a week (Node) |
| `web/` | the static page served by GitHub Pages: home "Oggi" with the day's meals (swipe left/right to change day), bottom bar to Settimana (calendar), Spesa and Ricette (`app.js` screen, `api.js` calls, `storage.js` cache) |
| `apps-script/` | data API on Google Drive; deployment steps in its README |
| `fixtures/` | anonymised sample data (public Olbia canteen menu, week 1) |
| `docs/` | data model (mirrored from the skill) and engine (`engine.md`) |

## Run locally

```sh
npm test                    # engine tests, no dependencies to install
node scripts/propose.js     # proposals for the fixture week
python3 -m http.server 8000 # then open http://localhost:8000/web/?demo
```

`?demo` reads `fixtures/` and needs no backend. Without it, the page asks (⚙︎) for
the Apps Script `/exec` URL and the Google OAuth client id, then for a Google
sign-in.

## Publish

1. Deploy the API: `apps-script/README.md`.
2. GitHub → *Settings → Pages*: deploy from branch `main`, folder `/ (root)`. The
   whole repo is served because `web/` imports `../engine/`; the app is at
   `https://<user>.github.io/<repo>/web/`
   (the root `index.html` redirects there).
3. Add that origin to the OAuth client's authorized JavaScript origins.

## Install on the phone

- **Android (Chrome)**: open the app, then ⚙︎ → "Installa l'app sul telefono",
  or the browser menu → "Installa app". Once installed, "Menu" appears in the
  share sheet: sharing a recipe link opens the Ricette tab with the form filled.
- **iPhone (Safari)**: Condividi → "Aggiungi alla schermata Home". iOS has no
  share target: copy and paste links into the Ricette tab.

Offline the app opens from the service worker (`web/sw.js`, network-first: online
you always get the latest version) and shows the last data it loaded; saving is
disabled until the connection is back, and unsaved week edits stay on the phone.
⚙︎ shows the app version (`APP_VERSION` in `web/app.js`, bump it on release) and
"Aggiorna all'ultima versione" drops the offline copy and reloads.
