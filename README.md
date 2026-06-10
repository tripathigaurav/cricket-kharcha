# 🏏 CricTracker

A mobile-first web app for tracking weekend cricket match payments. Players check in via a shared link, the admin enters the total cost which splits equally, and payments are marked with a protected admin link.

**Live app → https://tripathigaurav.github.io/cricket-kharcha/**

---

## Features

- **Check-in** — share a view-only link; players add their own names
- **Write-token security** — admin link (`?w=`) required to set cost, mark paid, or delete
- **Auto cost split** — enter total cost, everyone's share is calculated (ceiling rounded)
- **Mark paid** — tap a player to toggle paid/unpaid (admin link only)
- **UPI deep link** — one-tap payment via any UPI app (mobile)
- **Player stats** — all-time history: games played, owed, paid, outstanding
- **PWA** — add to home screen on iOS/Android
- **CricHeroes import** — paste a match URL to auto-import player names (best-effort)

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla JS SPA, hash routing, mobile-first CSS |
| Backend | Google Apps Script (REST Web App) |
| Database | Google Sheets (3 tabs: Matches, Payments, Players) |
| Hosting | GitHub Pages |

No build step, no npm, no framework — static HTML/JS/CSS + Apps Script.

---

## Setup (self-host)

### 1. Google Sheet

1. Create a new Google Sheet (use a **separate sheet for testing** if you run `npm test`)
2. Add 3 tabs named exactly: `Matches`, `Payments`, `Players`
3. Note the Sheet ID from the URL: `https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit`

### 2. Apps Script backend

1. In the Sheet: **Extensions → Apps Script**
2. Paste the contents of `Code.gs`
3. **File → Project properties → Script properties** — set timezone to **Asia/Kolkata**
4. **Set Sheet ID in the Apps Script editor only** — never commit a real ID to git:
   - At the top of `Code.gs`, set `EDITOR_SHEET_ID = 'your-id-from-sheet-url'`  
   - Deploy — the first API request auto-saves it to Script Properties (no extra run needed)  
   - Optional: run `configureSheetId()` once to set Script Properties immediately  
   - In the public git repo, `EDITOR_SHEET_ID` stays `''`
5. Run `initializeSheets()` once to create headers (includes `WriteToken` column)
6. **Deploy → New Deployment → Web App**
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Copy the deployment URL

### 3. Frontend config

```bash
cp config.example.js config.js
```

Edit `config.js`:

```javascript
const CRICKET_API_URL = 'https://script.google.com/macros/s/.../exec';
```

`config.js` is gitignored — never commit your Sheet ID.

**GitHub Pages:** the live site loads [`config.deploy.js`](config.deploy.js) (API URL only, committed). After rotating your Apps Script deployment, update that file and push. Local `config.js` overrides `config.deploy.js` when present.

### 4. GitHub Pages

Push to GitHub and enable **Settings → Pages → Branch: main**.

---

## Share links

| Link type | URL | Can do |
|-----------|-----|--------|
| **Player** (share to group) | `#/match/{id}` | Check in only |
| **Admin** (keep private) | `#/match/{id}?w={token}` | Set cost, mark paid, delete |

The write token is returned when you create a match and stored in your browser session. Share to WhatsApp uses the player link (no token).

---

## Running tests

Tests hit the Apps Script API and auto-delete matches they create.

**Recommended:** deploy a second Apps Script + sheet for testing:

```bash
# config.js
const CRICKET_TEST_API_URL = 'https://script.google.com/macros/s/.../exec';

# or via env
CRICKET_TEST_API_URL='...' npm test
```

To run against production (not recommended): `CRICKET_ALLOW_PROD_TESTS=1 npm test`

```bash
npm test                  # full integration suite (auto-purges test data at end)
npm run test:cleanup      # remove leftover test matches/players only
npm run test:split        # exact-split tests
npm run test:player-link  # player link / mark-paid tests
npm run test:cricheroes   # CricHeroes scrape tests
```

---

## Project structure

```
index.html        # SPA shell — views (home, new match, match detail, stats)
app.js            # Frontend — routing, API, DOM
sw.js             # Service worker (caches static assets)
style.css         # Mobile-first styles
config.example.js # Template for config.js (gitignored)
config.deploy.js  # Production API URL for GitHub Pages
manifest.json     # PWA manifest
Code.gs           # Google Apps Script backend (single file — deploy manually)
package.json      # npm test scripts
test/             # Node integration tests
```

**Version:** keep `APP_VERSION` in `app.js` and `CACHE_NAME` in `sw.js` in sync with `package.json` when releasing.

---

## Security

- **Write-token** — POST actions (lock, mark paid, remove, delete) require `?w=` token on protected matches
- **Formula injection** — all user inputs sanitised before writing to Sheets
- **SSRF** — CricHeroes scraper validates hostname before fetching
- **Concurrency** — `LockService` on check-in, lock, remove, delete
- **Input limits** — player names ≤ 100 chars, other fields ≤ 200 chars
- **XSS** — all user content HTML-escaped before rendering
- **Secrets** — `config.js` is gitignored; Sheet ID lives in Apps Script **Script Properties** (`setSheetId`), not in `Code.gs`
- **Sheet sharing** — the Sheet ID alone does not grant access, but if it was ever committed, tighten Google Sheet sharing to specific people only (not “anyone with the link” unless you accept that risk)

### Sheet ID and git history

If a real Sheet ID was pushed to GitHub in an older commit, removing it from the latest `Code.gs` only protects **future** clones. Options:

1. **Recommended:** Restrict sheet sharing to trusted accounts; set `EDITOR_SHEET_ID` in the Apps Script editor (not in git)
2. **Optional:** Use [BFG Repo-Cleaner](https://rtyley.github.io/bfg-repo-cleaner/) to purge the ID string from all commits, then `git push --force` (rewrites history)
3. **Strict:** Create a new Google Sheet, migrate data, run `setSheetId()` with the new ID

---

## Deploy checklist (after code changes)

1. Paste updated `Code.gs` into Apps Script editor
2. Run `initializeSheets()` if upgrading (adds `WriteToken` column header)
3. Run `backfillWriteTokens()` once if any existing matches have an empty WriteToken column — then re-share admin `?w=` links for those matches
4. **Deploy → Manage deployments → Edit → New version → Deploy**
5. If `config.js` was ever committed: rotate the Apps Script deployment URL and update local `config.js` (old URL remains in git history)
6. Verify with `npm test` against your test deployment
7. Push frontend (`app.js`, `sw.js`, `index.html`, `style.css`) to GitHub Pages
