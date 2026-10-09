# CLAUDE.md — menu-famiglia-app

Mobile web app that lets a family pick the week's home meals (dinners + weekend
lunches) around the children's school canteen lunches, and turns the chosen plan
into a shopping list. Companion to the `family-meal-planner` Claude skill, which
keeps handling PDF menu imports, new recipes and nutrition classification.

Language: code, identifiers and comments in **English**; all user-facing text in
**Italian** (the family is Italian).

## Hard constraints

- **Zero cost.** GitHub Pages (public repo) + Google Apps Script + Google Drive only.
  No paid services, no server, no database, no bundler, no CI minutes needed.
- **No build step.** Plain ES modules loaded directly by the browser. No npm
  dependencies in the shipped code. Dev dependencies: none — tests use `node:test`.
- **Offline-tolerant UI.** The app must render from cached data when offline and
  only fail on writes.
- **Mobile first.** Designed for a phone screen; desktop is a bonus.

## Architecture

```
GitHub Pages (static PWA)  ->  Apps Script web app  ->  Google Drive JSON files
         web/                      apps-script/            (folder family-meal-planner/)
                    \__ shared rules engine __/
                            engine/  (also run by the skill via Node)
```

- `engine/` is the **single source of truth for the planning rules**. Pure ES
  modules, no DOM, no network, no Node-only API: they must run both in the browser
  and under `node`. The Python skill shells out to Node to reuse them; never
  reimplement a rule in Python or in the UI.
- `web/` is the interface. It talks only to the Apps Script endpoint and to
  `engine/`.
- `apps-script/` is the data API. It contains no planning logic: read, validate
  ownership, write.

## Drive data (already in production)

Folder `family-meal-planner/` in the owner's Drive:

| File | Written by | Content |
| --- | --- | --- |
| `catalog.json` | skill only | `dishes`, `school_menus` (~48 KB) |
| `family-data.json` | skill only | `family`, `rules`, `pantry` (initial pantry only) |
| `plans.json` | **app only** | `plans` |
| `pantry.json` | **app only** | `pantry`: staples kept out of the shopping list; once it exists it replaces `family-data.json`'s `pantry` |
| `wishlist.json` | **app only** | `wishes`: recipes the family asks to add; the skill adds the dishes with `wish:<id>` in `source.ref` |
| `dish-edits.json` | **app only** | `edits`: the family's corrections to catalog dishes, applied on top of `catalog.json` (`engine/data.js` `applyDishEdits`) |
| `archive/` | both | previous versions, `<name>-YYYYMMDD-HHMM.json` |
| `shopping-lists/` | app | one text file per week (optional) |

Respect the write boundary: the app must never write `catalog.json` or
`family-data.json`, and the skill never writes the app's files
(`docs/skill-integration.md`). The Drive API cannot patch a file, so every save uploads a new
copy and moves the old one into `archive/`.

The JSON schema, the nutrition taxonomy and the rule types are documented in the
skill package (`references/schema.md`, `references/taxonomy.md`,
`references/default-rules.md`). Mirror them in `docs/schema.md` and keep
`fixtures/` in sync with real, anonymised data.

Schema essentials:

- A `dish` has `id`, `name`, `course` (first, second, side, single, bread, fruit,
  dessert, takeaway), `allergens`, `ingredients[{name, aisle, qty?, unit?}]`,
  `nutrition {carbs, cereals, proteins, fats, vegetables, confidence}`,
  `prep_minutes`, `tags`, `aliases`, `cookable_at_home`.
- A `school_menu` has `weeks[].days[].items[]`, each item `{course, options: [dishId], portion?}`;
  `cycle_start_date` is the Monday of cycle week 1. Cycle week for a date:
  `((date - start) / 7 days | 0) % weeks.length + 1`. Holidays are ignored.
- Rule types: `frequency`, `complement`, `exclusion`, `variety`, `time_limit`,
  `takeaway`, `meal_structure`. `priority` is `hard` (never violate) or `soft`
  (score). Frequencies count over the whole week: canteen lunches + weekend lunches
  + dinners.
- Omitted keys carry defaults: missing lists are empty, `verified` false,
  `cookable_at_home` true, `vegetables {present:false}`, item `portion` 1.

## Apps Script notes

- Deploy: execute as the **owner**, access **anyone**. Every call carries a Google
  ID token (Google Identity Services sign-in in the page); the script verifies it
  and checks the email against an allowlist kept in Script Properties (`ALLOWED`,
  managed from the app by the owner, who is always allowed) — never hardcode
  emails in the repo.
- Nobody types configuration: the owner invites from Settings → Famiglia, the
  script mails a link with the `/exec` address in the URL fragment
  (`#invito=<base64url>`, never sent to GitHub), and the OAuth client id is
  served by the script (`?resource=config`, the only unauthenticated call). `Session.getActiveUser()` is not usable: it returns
  an empty email for other gmail.com accounts, and "anyone with a Google account"
  needs third-party cookies that Safari blocks (see `apps-script/README.md`).
- **POST bodies must be sent as `text/plain`**. Any JSON content type triggers a
  CORS preflight that Apps Script cannot answer. Parse with `JSON.parse(e.postData.contents)`.
- Responses: `ContentService.createTextOutput(JSON.stringify(x)).setMimeType(JSON)`.
- Find files by name inside the folder id stored in Script Properties; do not
  hardcode file ids, they change at every save.
- Keep `apps-script/` deployable by copy-paste into the editor; `clasp` is optional.

## Conventions

- `const`/`let`, no semicolon-free style, 2-space indent, no framework.
- Functions in `engine/` are pure: `(data, args) => result`. No dates from
  `Date.now()` inside them — pass the date in, so tests are deterministic.
- Every rule type gets its own function and its own test file.
- Tests: `npm test` (runs `node --test` on `engine/test/` and `apps-script/test/`,
  no install needed; `Code.gs` runs against an in-memory Drive). They must pass
  without network access.
- Commit messages in English, imperative mood.
- Every release bumps `APP_VERSION` in `web/app.js` as `YYYY.MM.DD-N`: the
  release date and N, the number of that day's release starting from 1.
- Never commit real family data, emails, Drive ids or deployment URLs. Those live
  in Script Properties, in the invitation links and in the browser's
  `localStorage`; `web/config.js` (git-ignored, `config.example.js` checked in)
  is only for local development.

## What NOT to do

- Do not add a framework, a bundler, TypeScript, or npm runtime dependencies.
- Do not call any AI API from the app: the proposals are deterministic.
- Do not duplicate planning rules in the UI or in Apps Script.
- Do not compute portion sizes or quantities: the family decides those. The
  shopping list aggregates ingredient names, and repeats a recipe's own quantities
  only when the recipe states them.
