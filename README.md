# Menu di famiglia

Mobile web app to pick the week's home meals around the children's school canteen
lunches, and turn the plan into a shopping list. Companion to the
`family-meal-planner` Claude skill. See `CLAUDE.md` for the constraints and
`PLAN.md` for the build phases.

Status: **phase A** — the canteen lunches of the week, read-only.

## Layout

| Path | What |
| --- | --- |
| `engine/` | shared rules engine, pure ES modules (browser + Node) |
| `web/` | the static page served by GitHub Pages |
| `apps-script/` | data API on Google Drive; deployment steps in its README |
| `fixtures/` | anonymised sample data (public Olbia canteen menu, week 1) |
| `docs/` | data model, mirrored from the skill |

## Run locally

```sh
npm test                    # engine tests, no dependencies to install
python3 -m http.server 8000 # then open http://localhost:8000/web/?demo
```

`?demo` reads `fixtures/` and needs no backend. Without it, the page asks (⚙︎) for
the Apps Script `/exec` URL and the Google OAuth client id, then for a Google
sign-in.

## Publish

1. Deploy the API: `apps-script/README.md`.
2. GitHub → *Settings → Pages*: deploy from branch `main`, folder `/ (root)`. The
   whole repo is served because `web/` imports `../engine/`; the app is at
   `https://<user>.github.io/<repo>/web/`.
3. Add that origin to the OAuth client's authorized JavaScript origins.
