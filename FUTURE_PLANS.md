# Future Plans

## 1. Player Match History Drill-down ✅ IMPLEMENTED

**Goal**: When tapping a player card on the Stats page, show a per-match breakdown of what they owe and to whom.

### Design

- Expandable card (accordion-style) on tap
- First expansion triggers a lazy fetch to `getPlayerHistory` endpoint
- Cached after first load so re-expanding doesn't re-fetch

### Backend: New `getPlayerHistory` GET endpoint (Option B — lazy load)

```
GET ?action=playerHistory&id=PLAYER_ID
```

Response:

```json
{
  "playerId": "abc123",
  "name": "Rahul",
  "history": [
    { "matchId": "m1", "date": "2026-06-08", "payTo": "Amit", "amount": 500, "paid": true },
    { "matchId": "m2", "date": "2026-06-05", "payTo": "Saurabh", "amount": 800, "paid": false }
  ]
}
```

### Frontend UX

**Collapsed (default):**

```
┌─────────────────────────────────────┐
│  Rahul                    3 games   │
│  Owed: ₹1800  Paid: ₹500  Due: ₹1300 │
│                              ▶      │
└─────────────────────────────────────┘
```

**Expanded (after tap):**

```
┌─────────────────────────────────────┐
│  Rahul                    3 games   │
│  Owed: ₹1800  Paid: ₹500  Due: ₹1300 │
│                              ▼      │
├─────────────────────────────────────┤
│  8 Jun · Pay to: Amit               │
│  ₹500  ✅ Paid                       │
│                                     │
│  5 Jun · Pay to: Saurabh            │
│  ₹800  ⏳ Unpaid                     │
│                                     │
│  1 Jun · Pay to: Amit               │
│  ₹500  ⏳ Unpaid                     │
└─────────────────────────────────────┘
```

### Why lazy-load (Option B) over enriching getPlayers (Option A)

- Keeps initial Stats page load fast (just totals)
- Only fetches details on demand
- Scales better as match count grows

### Optional enhancements

- Filter: "Show unpaid only"
- Tap a match row to navigate to that match page
- Group by collector (payTo) for quick "who do I owe"
