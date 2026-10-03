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
   | `ALLOWED` | the family's Google accounts, comma-separated |
   | `CLIENT_ID` | the OAuth client id from step 1 |

4. In the editor, select `checkSetup` and press *Run*. Authorize the scopes:
   - `drive` — read the data files now, write `plans.json` from phase C on;
   - `script.external_request` — verify ID tokens with `oauth2.googleapis.com`.

   The log lists the three files (`plans.json` is "missing" until the first save).
5. *Deploy → New deployment → Web app*: execute as **Me**, who has access
   **Anyone**. Copy the `/exec` URL.
6. Open the web page, tap ⚙︎ and paste the `/exec` URL and the client id. They are
   stored on that phone only.

Never commit the folder id, the emails, the client id or the `/exec` URL.

## Updating

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

Verified tokens are cached for their lifetime (at most one hour), keyed by their
SHA-256 hash; the allowlist is read on every call.
