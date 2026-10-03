# PLAN.md — menu-famiglia-app

Build order: A to E. Each phase ends with something usable and is reviewed before
the next one starts. Read `CLAUDE.md` first for the constraints.

Target repo layout:

```
menu-famiglia-app/
├── CLAUDE.md, PLAN.md, README.md
├── docs/schema.md            # data model, mirrored from the skill
├── engine/                   # shared rules engine (browser + Node)
│   ├── data.js               # load/merge, defaults, cycle-week math
│   ├── rules.js              # one evaluator per rule type
│   ├── planner.js            # proposals for a week
│   ├── shopping.js           # plan -> shopping list
│   └── test/*.test.js        # node --test
├── web/                      # GitHub Pages site
│   ├── index.html, app.js, styles.css
│   ├── config.example.js     # endpoint URL; real config.js is git-ignored
│   ├── manifest.webmanifest, sw.js, icons/
├── apps-script/
│   ├── Code.gs, appsscript.json, README.md   # deployment steps
└── fixtures/                 # anonymised catalog/family/plans samples
```

## Phase A — read-only API and first screen

1. `apps-script/Code.gs`: `doGet(e)` returning `catalog`, `family` or `plans`
   (`?resource=`), read from the Drive folder by file name. Allowlist check on
   `Session.getActiveUser().getEmail()`; 403 otherwise. Folder id and allowlist in
   Script Properties.
2. `apps-script/README.md`: how to deploy, which scopes, how to set the properties.
3. `engine/data.js`: merge the data files into one object, apply defaults, compute
   the cycle week for a date and return the canteen lunches for a given week.
4. `web/`: a page showing the current week's canteen lunches, day by day, in
   Italian, readable on a phone. Fetch the API, cache the response in
   `localStorage`, render from cache when offline.

Done when: opening the page on a phone shows the right canteen week, and a
non-allowlisted account gets a clear refusal.

## Phase B — rules engine and proposals

1. `engine/rules.js`: an evaluator per rule type, each returning
   `{ruleId, satisfied, severity, detail}`:
   - `meal_structure`: allowed course combinations per meal (hard).
   - `complement`: a protein group eaten at lunch is excluded at dinner the same day.
   - `exclusion`: substring match on ingredient names.
   - `time_limit`: `prep_minutes` per weekday.
   - `variety`: days since the dish last appeared in a confirmed plan.
   - `frequency`: counts per group over the week (canteen + home meals), against
     `min`/`target`/`max`.
   - `takeaway`: how many takeaway meals, on which days, rotating cuisines.
2. `engine/planner.js`: `proposeWeek({data, weekStart, seed})` returns, for each
   meal slot (7 dinners + Saturday and Sunday lunch), a ranked list of candidate
   meals with the reason for the ranking. Hard rules filter; soft rules score.
   Deterministic given the same seed and data.
3. Tests with the real Olbia week 1 as a fixture: no hard-rule violation in the
   output; weekly frequencies within bounds where the canteen allows it.

Done when: `node --test engine/test/` passes and proposals for a chosen week can be
printed from a small Node script.

## Phase C — choose and confirm (first write)

1. Screen: the week, day by day, canteen lunch next to the proposed home meal.
   Tapping a meal shows the alternatives that still respect the hard rules, with a
   one-line reason; the family can swap or clear a day.
2. Live feedback: which soft rules the current week misses (e.g. "legumi 2 su 3").
3. `doPost` in Apps Script: `{action: "savePlan", plan}` sent as `text/plain`.
   Validates the payload shape, writes a new `plans.json`, archives the previous
   copy, records the email of whoever saved and the timestamp.
4. Concurrency: the client sends the `updatedAt` it loaded; the server refuses the
   write if the file changed in the meantime, and the app reloads and asks again.

Done when: a plan chosen on the phone is on Drive, and a second device sees it.

## Phase D — shopping list

1. `engine/shopping.js`: confirmed plan -> ingredients of home-cooked meals,
   merged by name, grouped by aisle, pantry items removed, takeaway meals skipped.
   Quantities only where the recipe states them; never computed.
2. Screen: checkable list, grouped by aisle, with a "share" button using the Web
   Share API (works into Bring, Keep, WhatsApp).
3. Optionally store the list as a text file in `shopping-lists/` on Drive.

Done when: the list for a confirmed week can be shared to another app in two taps.

## Phase D2 — recipe wishlist (requested after D)

1. Screen "Ricette da provare": anyone in the family adds a wish (name, optional
   link, optional note) or removes one; the list shows who asked and the status.
2. `wishlist.json` on Drive, written by the app only (same save, archive and
   `updated_at` conflict check as `plans.json`); Apps Script actions to add and
   remove a wish.
3. The skill reads the wishlist, opens the links, proposes ingredients and
   classification, and after the family's "salva" adds the dishes to
   `catalog.json` with the wish id in `source.ref`. The app shows a wish as
   "aggiunta al catalogo" when a dish refers to it: the skill never writes
   `wishlist.json`. Needs a skill update (outside this repo).
4. Sharing a link straight into the app (Web Share Target) comes with phase E,
   Android only.

## Phase E — PWA

1. `manifest.webmanifest` + icons, installable on Android and iOS.
2. `sw.js`: cache the shell and the last data; offline shows the last plan and the
   shopping list read-only; writes queue until back online or simply fail clearly.

Done when: the app is installed on the family's phones and opens offline.

## Skill integration (after B)

- The skill stops using `verifica_regole.py` and calls `engine/` through Node, so
  chat and app judge a plan identically.
- Decide then whether to keep the Python checker as an independent cross-check or
  delete it (open question in the design document).

## Open questions

- Two people editing the same week: **settled** — last write wins, with the
  `updated_at` check: on a conflict the app reloads and asks before overwriting.
- A weekly reminder to pick the menu: worth it, and through what (email from Apps
  Script, or nothing)? Still open.
