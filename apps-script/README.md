# Apps Script data API — deployment

The API runs as the Drive owner and reads the files in `family-meal-planner/`. It
contains no planning logic.

## Why sign-in goes through an ID token

The first design used `Session.getActiveUser().getEmail()`. That does not work for
this family:

- in a web app that runs as the owner, `getActiveUser()` returns an **empty email**
  for other consumer (`@gmail.com`) accounts; it only works inside one Google
  Workspace domain;
- a web app restricted to "anyone with a Google account" relies on Google's cookies
  being sent to `script.google.com` from the `github.io` page. Those are third-party
  cookies, and Safari on iPhone blocks them.

So the web app is open to **anyone** at the HTTP level, and every call must carry a
Google **ID token**. The page gets it from Google Identity Services ("Accedi con
Google", free). The script checks the token with Google, then checks the email
against the allowlist in Script Properties. No token, a wrong token or an account
missing from the allowlist gets no data.

## One-time setup

1. **OAuth client id** (free, no billing):
   1. <https://console.cloud.google.com/> → create a project (e.g. `menu-famiglia`).
   2. *APIs & Services → OAuth consent screen*: External, app name, your email.
      Scopes: none beyond the defaults (`openid`, `email`, `profile`). Publish it
      ("In production"): with only these scopes, no Google review is needed.
   3. *Credentials → Create credentials → OAuth client ID → Web application*.
      Authorized JavaScript origins: `https://<github-user>.github.io` and, for
      local testing, `http://localhost:8000`. No redirect URI.
   4. Copy the client id (`….apps.googleusercontent.com`).
2. **Script**: <https://script.google.com/> → New project, named `menu-famiglia-api`.
   - Paste `Code.gs` into the editor's `Code.gs`.
   - *Project settings* → tick "Show appsscript.json", then paste `appsscript.json`.
3. **Script Properties** (*Project settings → Script properties*):

   | Property | Value |
   | --- | --- |
   | `FOLDER_ID` | id of the `family-meal-planner` folder (the last part of its Drive URL) |
   | `ALLOWED` | optional: the family's Google accounts, comma-separated. Managed from the app (⚙︎ → Famiglia); the owner is always allowed and never listed |
   | `ADMINS` | optional: other accounts that may invite and remove members (the owner always can) |
   | `CLIENT_ID` | the OAuth client id from step 1 |

4. In the editor, select `checkSetup` and press *Run*. Authorize the scopes:
   - `drive` — read the data files now, write `plans.json` from phase C on;
   - `script.external_request` — verify ID tokens with `oauth2.googleapis.com`;
   - `script.send_mail` — send the invitations (from the owner's Gmail, 100 a day);
   - `userinfo.email` — know the owner's address (always allowed, admin).

   After a version that adds scopes, run `checkSetup` once again **before**
   deploying it, or the web app fails until the owner authorizes.

   The log lists the three files (`plans.json` is "missing" until the first save).
5. *Deploy → New deployment → Web app*: execute as **Me**, who has access
   **Anyone**. Copy the `/exec` URL.
6. Open the web page, tap ⚙︎ → Avanzate and paste the `/exec` URL (only the
   owner, only once; the client id is asked to the script). Then ⚙︎ → Famiglia →
   Invita: each person gets a mail with a link that sets everything up.

Never commit the folder id, the emails, the client id or the `/exec` URL.

## Updating

### With clasp (optional)

From a computer with Node installed:

```sh
npm install -g @google/clasp
clasp login                       # once, opens the browser
cd apps-script
cp .clasp.json.example .clasp.json   # git-ignored
# put the script id in .clasp.json: editor → Project settings → IDs
clasp push                        # uploads Code.gs and appsscript.json only
clasp deploy -i <deployment-id>   # new version on the same /exec URL
```

`clasp push` needs the Apps Script API turned on once, at
<https://script.google.com/home/usersettings>. The deployment id is the part
between `/s/` and `/exec` of the web app URL, and is different from the script id.

### By hand

Paste the new `Code.gs`, then *Deploy → Manage deployments → ✏︎ → Version: New
version*. Keeping the same deployment keeps the same `/exec` URL.

## API

`GET <exec>?resource=<name>&id_token=<token>`

| `resource` | Returns |
| --- | --- |
| `catalog` | `catalog.json` |
| `family` | `family-data.json` |
| `plans` | `plans.json`, or `{plans: []}` while it does not exist |
| `all` | `{resources: {catalog, family, plans}}`, each `{data, updated_at}` |

Success: `{ok: true, resource, email, data, updated_at}` (`updated_at` is the
file's last modification, ISO 8601; `null` for a missing `plans.json`).

Failure (HTTP status is always 200): `{ok: false, status, error, message}`.

| `status` | `error` | Meaning |
| --- | --- | --- |
| 400 | `bad_resource` | unknown `resource` |
| 401 | `unauthenticated`, `invalid_token` | sign in again |
| 403 | `forbidden` | the account is not in `ALLOWED` (`email` says which) |
| 404 | `not_found` | `catalog.json` or `family-data.json` missing |
| 500 | `not_configured`, `bad_json`, `internal` | setup or data problem |

`POST <exec>` with body (sent as **`text/plain`**, never a JSON content type:
it would trigger a CORS preflight Apps Script cannot answer):

```json
{"id_token": "…", "action": "savePlan", "base_updated_at": "<updated_at of plans.json as loaded, or null>",
 "plan": {"id": "2026-w41", "week_start": "2026-10-05", "status": "draft", "cycle_week": 2,
          "meals": [{"date": "2026-10-05", "slot": "dinner", "dish_ids": ["pasta-lenticchie"]}]}}
```

- The plan replaces the one of the same `week_start`; `updated_at` and
  `updated_by` (the email of whoever saved) are recorded on the plan and on
  the file.
- If `plans.json` changed since `base_updated_at`, nothing is written and the
  answer is `409 conflict` with `updated_at` and `updated_by`: the app reloads
  and asks whether to overwrite. The last confirmed save wins.
- Only the shape is checked (Monday `week_start`, dates inside the week,
  `lunch`/`dinner`, dish ids present in the catalog): `422 invalid_plan`
  otherwise. Planning rules stay in `engine/`.
- Saves are serialized with a script lock. The new `plans.json` is created
  first, then the previous one moves to `archive/` as
  `plans-YYYYMMDD-HHMM.json`. `catalog.json` and `family-data.json` are never
  written.

Success: `{ok: true, data: <new plans.json>, updated_at}`.

`POST <exec>` with `{"id_token": "…", "action": "saveShoppingList",
"week_start": "2026-10-05", "text": "…"}` writes
`shopping-lists/spesa-2026-10-05.txt` (folder created if missing); an older copy
moves to `archive/` as `spesa-2026-10-05-YYYYMMDD-HHMM.txt`. The text comes from
`engine/shopping.js`: no conflict check, it is derived from the plan.
`422 invalid_list` for a non-Monday week or an empty text.

`POST <exec>` with `{"id_token": "…", "action": "updatePantry", "add": ["riso"],
"remove": ["pepe"]}` changes the pantry (`pantry.json`). The change is applied
under the lock to the current list, so two people editing at once do not
overwrite each other; the first change starts from `family-data.json`'s
`pantry`, which is never written. Names are compared ignoring case and spaces,
1–60 characters, at most 200 items (`422 invalid_pantry`). Answer:
`{ok: true, data: <new pantry.json>, updated_at}`; the old copy goes to
`archive/pantry-YYYYMMDD-HHMM.json`. `GET ?resource=pantry` returns
`data: null` while the file does not exist.

`POST <exec>` with `{"id_token": "…", "action": "addWish", "name": "…", "url":
"https://…", "note": "…"}` adds a recipe to `wishlist.json` (`url` and `note`
optional; name ≤ 80, url ≤ 500 and http(s) only, note ≤ 300 characters); the
answer carries the new `wish` with its `id`, `added_by`, `added_at`.
`{"action": "removeWish", "id": "…"}` removes one (`404` if unknown). Both are
applied under the lock to the current list, old copy to
`archive/wishlist-YYYYMMDD-HHMM.json`; `422 invalid_wish` on bad input.

| `status` | `error` | Meaning |
| --- | --- | --- |
| 400 | `bad_json`, `bad_action` | malformed body |
| 409 | `conflict` | someone saved in between |
| 422 | `invalid_plan` | `message` lists the problems |
| 503 | `busy` | another save holds the lock, retry |

`npm test` runs `Code.gs` under Node against an in-memory Drive
(`apps-script/test/`), including saves, conflicts and archiving.

`POST <exec>` with `{"id_token": "…", "action": "saveDishEdit", "dish_id": "…",
"fields": {…}}` stores the family's correction of a catalog dish in
`dish-edits.json` (replacing that dish's previous edit); `{"action":
"resetDishEdit", "dish_id"}` removes it. The dish must exist in `catalog.json`,
which is never written. Fields and values are checked against the skill's
closed sets (`422 invalid_dish`): see `docs/schema.md`.

`GET <exec>?resource=config` (no token) returns `{ok, client_id}`: the client id
is public, the page needs it to show the Google sign-in. Nothing else is
reachable without a token.

Family management, owner and `ADMINS` only (`403 not_admin` otherwise):

- `{"action": "listMembers"}` → `members: [{email, owner, admin}]`;
- `{"action": "inviteMember", "email", "app_url", "endpoint"}` adds the address
  to `ALLOWED` and mails it a link `app_url#invito=<base64url(endpoint)>`;
  inviting again resends the mail; `app_url` must be https, `endpoint` the
  `/exec` URL (`422 invalid_member`);
  the answer carries the same `link`. The mail is plain text plus a plain
  link, with `replyTo` the inviter; if it lands in spam, the app shares the
  link by hand (⚙︎ → Famiglia → «Condividi il link»): it only works for
  accounts in `ALLOWED`;
- `{"action": "removeMember", "email"}` removes it at once (the owner cannot be
  removed; `404` if not listed).

`GET ?resource=all` also says `admin: true|false` for the caller.

Verified tokens are cached for their lifetime (at most one hour), keyed by their
SHA-256 hash; the allowlist is read on every call.
