# 🏏 Cricket Kharcha

A mobile-first web app for tracking weekend cricket match payments. Players check in via a shared link, the admin enters the total cost which splits equally, and anyone can mark their payment done.

**Live app → https://tripathigaurav.github.io/cricket-kharcha/**

---

## Features

- **Check-in** — share a link, players add their own names
- **Auto cost split** — enter total cost, everyone's share is calculated (ceiling rounded)
- **Mark paid** — tap a player to toggle paid/unpaid
- **UPI deep link** — one-tap payment via any UPI app
- **Player stats** — all-time history: games played, owed, paid, outstanding
- **PWA** — add to home screen on iOS/Android, works offline for viewing
- **CricHeroes import** — paste a match URL to auto-import player names (best-effort)

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla JS SPA, hash routing, mobile-first CSS |
| Backend | Google Apps Script (REST Web App) |
| Database | Google Sheets (3 tabs: Matches, Payments, Players) |
| Hosting | GitHub Pages |

No build step, no npm, no framework — just 3 files served as static HTML/JS/CSS.

---

## Setup (self-host)

### 1. Google Sheet

1. Create a new Google Sheet
2. Add 3 tabs named exactly: `Matches`, `Payments`, `Players`
3. Note the Sheet ID from the URL: `https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit`

### 2. Apps Script backend

1. In the Sheet: **Extensions → Apps Script**
2. Paste the contents of `Code.gs`
3. Set `SHEET_ID` to your sheet's ID
4. Run `initializeSheets()` once to create headers
5. **Deploy → New Deployment → Web App**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Copy the deployment URL

### 3. Frontend

1. In `app.js`, set `API_URL` to your deployment URL
2. Push to GitHub and enable **Settings → Pages → Branch: main**

---

## Project structure

```
index.html      # SPA shell — 4 views (home, new match, match detail, stats)
app.js          # All frontend logic — routing, API calls, DOM rendering
style.css       # Mobile-first styles
manifest.json   # PWA manifest
Code.gs         # Google Apps Script backend (not deployed to GitHub Pages)
test.js         # Integration test suite (node --experimental-fetch test.js)
```

---

## Running tests

Tests run against the live Apps Script backend:

```bash
node --experimental-fetch test.js
```

109 assertions across 12 blocks: match lifecycle, check-in, cost splits, payments, player stats, formula injection, SSRF, monkey tests, late check-in, and more.

---

## Security

- **Formula injection** — all user inputs sanitised before writing to Sheets
- **SSRF** — CricHeroes scraper validates hostname before fetching
- **Concurrency** — `LockService` prevents duplicate check-ins under load
- **Input limits** — player names ≤ 100 chars, other fields ≤ 200 chars
- **XSS** — all user content HTML-escaped before rendering
