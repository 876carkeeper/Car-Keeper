# CarKeeper — installable vehicle-management app (PWA)

A working, single-file progressive web app for tracking vehicles, maintenance, repairs,
fuel and expenses — with a dark automotive UI, an AI assistant slot, and a local-first
database that persists on the device.

**Files in this folder**

| File | Purpose |
|---|---|
| `index.html` | The entire app (HTML + CSS + JS, no build step, no dependencies) |
| `manifest.webmanifest` | PWA manifest — install to home screen |
| `sw.js` | Service worker — offline app shell |
| `icon-*.png`, `apple-touch-icon.png` | App icons (192/512, maskable variants) |
| `README.md` | This document |

---

## 1. Run it

```bash
# any static server works — the app must be served over http(s) for PWA install
cd carkeeper
python3 -m http.server 8080
# open http://localhost:8080
```

**Install on iPhone:** open the URL in Safari → Share → *Add to Home Screen*.
**Install on Android:** open in Chrome → menu → *Install app*.

Data lives in the browser (`localStorage` + `IndexedDB` for photos/receipts), so the app
works offline and needs no server. Because browsers scope storage per origin, serve it
from the same domain you want the data to stay on — moving domains starts an empty database.

---

## 2. What actually works (not mockups)

| Area | Status |
|---|---|
| Sign up / log in / log out / reset password / change password | **Working.** PBKDF2-SHA256, 120k iterations, per-user random salt |
| Onboarding wizard (vehicle → mileage → preferences → dashboard) | **Working** |
| Multiple vehicles (create / edit / delete, photo upload) | **Working**, gated by plan |
| Maintenance records (date, mileage, cost, shop, notes, next due) | **Working**, full CRUD |
| Automatic due-date / due-mileage engine (green / amber / red) | **Working.** Uses your logged intervals + rolling miles/month from the odometer log |
| Health score + Next-up + overdue counts | **Working** |
| Expenses (9 categories, month/year/all-time, donut + 6-month bars) | **Working**, full CRUD |
| Service cost auto-mirrors into Expenses | **Working** (no double-entry) |
| Fuel log + MPG from full-tank fills | **Working** |
| Modification tracker | **Working** |
| Custom reminders (registration, insurance, inspection, other) | **Working** |
| Receipt / invoice photo upload | **Working** (Premium), stored in IndexedDB, resized to ≤1400px |
| Vehicle health dashboard | **Working** — status only, never a mechanical diagnosis |
| Service-history report (download HTML, or print → save as PDF) | **Working** (Premium) |
| JSON backup export / import | **Working** |
| Subscription / paywall page with Free / Premium $4.99 / Pro $9.99 | **Working UI + local entitlement switch.** No payments are taken — see §7 |
| AI Car Assistant | **UI complete, needs an API key.** Without a key it shows an explicit "no model connected" state instead of faking answers — see §6 |
| Cloud sync (multi-device, emailed reset links) | **Adapter written, off until you add a Supabase project** — see §5 |

### Deliberately not built (so nothing pretends to work)

- **Emailed password reset.** Local-first means there is no server to send mail. The reset
  screen verifies the account on the device. Add Supabase auth (§5) for real email resets.
- **Push notifications.** Reminders are in-app only; real push needs FCM/APNs plus a backend.
- **Vehicle resale value.** A field exists for a manual estimate; no market-data API is called.
- **Receipt OCR, multi-driver sharing, Apple/Google IAP.** Not implemented (see §7–§8).
- **Predictive diagnosis.** No OBD integration; the app never claims to diagnose.

---

## 3. Data model

`localStorage["carkeeper.db.v1"]`:

```jsonc
{
  "v": 1,
  "users":   [{ "id","name","email","salt","hash","plan","prefs","createdAt","onboarded" }],
  "session": "user-id",
  "vehicles":[{ "id","userId","year","make","model","trim","engine","mileage","vin","plate",
                "nickname","photo","tireSize","warranty","resale" }],
  "services":[{ "id","userId","vehicleId","type","date","mileage","cost","shop","notes",
                "nextDate","nextMileage","receipts":[] }],
  "expenses":[{ "id","userId","vehicleId","category","amount","date","note","odometer","serviceId?" }],
  "fuel":    [{ "id","userId","vehicleId","date","odometer","gallons","cost","full" }],
  "mods":    [{ "id","userId","vehicleId","name","brand","cost","date","notes" }],
  "reminders":[{ "id","userId","vehicleId","kind","title","dueDate","repeat" }],
  "odo":     [{ "id","userId","vehicleId","miles","date" }]   // mileage history → miles/month
}
```

Photos and receipts are stored in IndexedDB (`carkeeper-img` → `files`), keyed by id, and
referenced by id in the records above. This keeps `localStorage` under its ~5 MB quota.

**Isolation:** every read goes through `D.owns()` / queries filtered on
`vehicleId === sessionUserId`, so one account on the device cannot see another's records.
This is *not* a substitute for server-side RLS — see §5.

---

## 4. Security notes

- Passwords: PBKDF2-SHA256, 120,000 iterations, 16-byte random salt, never stored in plain text.
- All queries are user-scoped; deleting a vehicle cascades its records.
- No analytics, no third-party requests except the AI provider you configure.
- **Honest limitation:** client-side storage is readable by anyone with the unlocked device
  or a browser devtools session. That is sufficient for a personal tracker, but if you handle
  other people's data (a shop, a fleet), you must move records server-side and keep only
  tokens on the client.
- The AI key is stored in `localStorage` and sent from the device. For production, proxy it.

---

## 5. Supabase wiring (multi-device + real email)

1. Create a project, then run this in the SQL editor:

```sql
create table if not exists vehicles (
  id text primary key, user_id uuid not null references auth.users on delete cascade,
  data jsonb not null, updated_at timestamptz default now());
create table if not exists services (
  id text primary key, user_id uuid not null references auth.users on delete cascade,
  vehicle_id text, data jsonb not null, updated_at timestamptz default now());
create table if not exists expenses  (like services including all);
create table if not exists fuel      (like services including all);
create table if not exists mods      (like services including all);
create table if not exists reminders (like services including all);

alter table vehicles  enable row level security;
alter table services  enable row level security;
alter table expenses  enable row level security;
alter table fuel      enable row level security;
alter table mods      enable row level security;
alter table reminders enable row level security;

-- one policy per table: owner-only access
create policy "own rows" on vehicles  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on services  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on expenses  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on fuel      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on mods      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on reminders for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

2. In the app: **Settings → Cloud sync → Configure cloud sync**, paste the project URL and
   the *anon/publishable* key, add the cloud account email + password, press **Connect**
   (it calls `POST /auth/v1/token?grant_type=password` and keeps the JWT in memory/device).
3. Use **Upload local data** / **Download cloud data** on the same panel. Push is an
   idempotent `upsert` (`Prefer: resolution=merge-duplicates`), pull merges by id.
4. Never ship the *service_role* key in the client. Only the anon key + RLS.

Current sync is whole-record, last-writer-wins per id — no field-level conflict resolution.
For a paid product, move the mutation path behind an Edge Function.

---

## 6. AI assistant

The assistant calls OpenAI's Chat Completions API directly from the device with your key
(**Assistant settings**). It receives the vehicle year/make/model, mileage and tracked
maintenance as context, and is instructed to give likely causes, checks, estimate ranges
and an explicit "see a professional" for safety-critical symptoms.

**Production hardening — proxy the key.** Deploy this ~20-line endpoint and point the app
at it (replace the `fetch` URL in `sendAI()`):

```js
// /api/chat.js  (Vercel / Netlify / Cloudflare function)
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
               Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: req.body.messages,
      max_tokens: 700,
    }),
  });
  res.status(r.status).json(await r.json());
}
```

Then: rate-limit per user, and log nothing that identifies the customer.

---

## 7. Monetization

Plan limits enforced in this build (`PLANS` in the code):

| | Free | Premium $4.99/mo · $39.99/yr | Pro $9.99/mo · $79.99/yr |
|---|---|---|---|
| Vehicles | 1 | unlimited | unlimited |
| AI assistant | — | ✓ | ✓ |
| Receipt storage | — | ✓ | ✓ |
| Downloadable reports | — | ✓ | ✓ |
| Fuel + modification logs | — | ✓ | ✓ |
| Advanced analytics | basic | ✓ | ✓ |

**No payment provider is configured, so nothing charges.** The plan screen sets a local
entitlement so you can review every gated screen. To go live:

- **Web:** Stripe Checkout + a webhook that writes `plan` to your own `users` table; read it
  on login. Never trust a plan flag the client sends.
- **iOS/Android:** App Store / Play rules require in-app purchase — use RevenueCat, then gate
  on `customerInfo.entitlements`. Prices above match the plan artwork provided.

---

## 8. Shipping to the stores

The PWA installs today. To publish native binaries, wrap it with Capacitor:

```bash
npm i @capacitor/core @capacitor/cli && npx cap init CarKeeper com.you.carkeeper --web-dir=.
npx cap add ios && npx cap add android && npx cap sync
```

Then in Xcode/Android Studio: set the app icon from `icon-512.png`, add a splash screen,
and use `@capacitor/preferences` (or SQLite) instead of `localStorage` if you want the data
to survive OS storage eviction. Keep the same screens — the layout is already mobile-first
and safe-area aware.

---

## 9. QA performed on this build

Automated browser run (Chromium, 420×900, mobile) covering the full path with zero console
errors: sign up → onboarding (3 steps) → dashboard → log service → expense add/edit/delete →
fuel → modification → report download → backup export → preferences save → logout → wrong
password error → login → AI key connect → plan upgrade → delete vehicle → empty garage.
Free-plan vehicle limit, service↔expense mirroring, odometer updates and cascade deletes
were verified against the stored database after each action.
