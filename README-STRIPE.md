# Stripe subscriptions — setup & operations

CarKeeper now has a small Node backend (`server.js`) that serves the app **and** talks to
Stripe. Secret keys live only in the server environment; the browser never receives one.

```
browser (index.html)
   │  POST /api/checkout      → server creates a Stripe Checkout Session (subscription mode)
   │  POST /api/portal        → server creates a Billing Portal Session (manage / cancel)
   │  GET  /api/entitlement   → server returns the plan this account is entitled to
   │  POST /api/sync          → server re-reads the live subscription from Stripe
   ▼
server.js ──► Stripe API  (secret key, server-side only)
   ▲
   └── POST /api/stripe/webhook  ◄── Stripe (signature-verified events)
```

---

## 1. What I need from you

| # | Credential | Where to get it | How to give it to me |
|---|---|---|---|
| 1 | **Secret key** `sk_test_…` | Dashboard → Developers → API keys → *Secret key* (Reveal) | Use the secure key card in chat — never paste it in a message |
| 2 | **Publishable key** `pk_test_…` | Same page → *Publishable key* | Paste in chat or put it in `.env` yourself (it is public by design) |
| 3 | **Webhook signing secret** `whsec_…` | Created by `npm run stripe:setup` (production) or printed by `stripe listen` (local) | I generate it — no action needed from you |
| 4 | **Deployed URL** (e.g. `https://carkeeper.up.railway.app`) | Your hosting provider | Tell me once deployed, or run the setup script yourself |
| 5 | **Customer Portal config saved once** | Dashboard → Settings → Billing → *Customer portal* → Save | Click save once in **test mode**; otherwise portal links fail |

Nothing else. The four **price IDs are created for you** by `npm run stripe:setup` — you do
not need to build products by hand.

> Test mode and live mode are separate universes. Everything below is done with test keys
> until you deliberately swap in `sk_live_…`.

---

## 2. Run it locally

```bash
npm install
cp .env.example .env
# put STRIPE_SECRET_KEY + STRIPE_PUBLISHABLE_KEY into .env
npm run stripe:setup          # creates products + 4 prices, writes price IDs to .env
npm start                     # http://localhost:8080
```

Then, in a second terminal, forward webhooks from Stripe to your machine:

```bash
stripe login
stripe listen --forward-to localhost:8080/api/stripe/webhook
# copy the whsec_… it prints into STRIPE_WEBHOOK_SECRET in .env, then restart npm start
```

**Test cards**

| Case | Card |
|---|---|
| Success | `4242 4242 4242 4242` |
| 3-D Secure / SCA | `4000 0025 0000 3155` |
| Declined | `4000 0000 0000 0002` |
| Amex | `3782 822463 10005` |
| Debit | `4000 0000 0000 9995` |

Any future expiry date, any 3-digit CVC, any postal code.
Failed-payment state: use the declined card (`4000 0000 0000 0002`) on the *second* invoice —
or in test mode trigger `invoice.payment_failed` from the Stripe CLI:
`stripe trigger invoice.payment_failed`.

---

## 3. Production deploy

Any Node host works. Railway / Render / Fly.io are the least friction because they give you
a persistent disk for the SQLite file.

```bash
# Railway
railway init && railway up
railway variables set STRIPE_SECRET_KEY=sk_live_… STRIPE_PUBLISHABLE_KEY=pk_live_… APP_URL=https://your-domain
# attach a volume mounted at /data and set DATA_DIR=/data
```

```bash
# Docker
docker build -t carkeeper .
docker run -p 8080:8080 --env-file .env -v carkeeper-data:/data carkeeper
```

Then register the webhook and write its secret:

```bash
WEBHOOK_URL=https://your-domain/api/stripe/webhook npm run stripe:setup
npm start   # (or redeploy) to pick up STRIPE_WEBHOOK_SECRET
```

`npm run stripe:setup` is idempotent — it finds existing products/prices by lookup key, so
re-running it is safe.

**Serverless (Vercel/Netlify functions) is not a drop-in fit**: they have no persistent disk
for SQLite and webhooks need the raw body. If you must, replace the storage layer with
Postgres/Supabase and keep the same route contracts.

---

## 4. What is wired

| Requirement | Implementation |
|---|---|
| Recurring subscription checkout | `mode: 'subscription'` Checkout Session with a `price` line item |
| Visa / Mastercard / Amex / debit | Handled by Stripe Checkout (cards are on by default). Wallets: enable in Dashboard → Settings → Payments → Payment methods |
| $4.99/mo Basic, $9.99/mo Premium | Created by `stripe-setup.mjs`, plus $39.99/yr and $79.99/yr yearly prices |
| Recognising a successful payment | `checkout.session.completed` webhook → subscription stored; the app also calls `/api/sync` on return, so activation never waits on webhook latency |
| Subscription management & cancellation | Stripe Billing Portal session from `/api/portal` (update card, switch plan, cancel, download invoices) |
| Failed payments | `invoice.payment_failed` marks the subscription `past_due`: access continues, the app shows a "Payment failed" banner with a **Fix** button that opens the portal |
| Renewals | `customer.subscription.updated` / `invoice.paid` refresh status + `current_period_end`, which the UI shows as *Renews …* |
| Cancellation | `cancel_at_period_end` is surfaced as "Subscription ends <date> — you keep access until then"; the deleted event revokes access |
| Secret keys never in the client | Only `/api/*` is exposed; `server.js`, `package.json`, `.env` are not served (allowlist + 404) |
| Automatic recognition, duplicate-safe | Every webhook `event.id` is recorded; replays return `duplicate:true` and change nothing |

Entitlement rules (server-side, in `entitlementFor()`):

| Stripe subscription status | App plan |
|---|---|
| `active`, `trialing` | the purchased plan |
| `past_due` | same plan + `paymentFailed: true` (grace period) |
| `unpaid`, `canceled`, `incomplete_expired` | `free` |

---

## 5. Security notes

- The webhook endpoint verifies `stripe-signature` against `STRIPE_WEBHOOK_SECRET`; unsigned
  or tampered requests get a 400 before any state changes.
- The secret key is read once at boot from the environment. It is never logged, never
  serialised into a response. Stripe error text is mapped to a generic message so key
  fragments cannot leak (covered by a test).
- `/api/checkout` only accepts `plan ∈ {basic, premium}`, `cycle ∈ {month, year}` and maps
  those to price IDs held server-side — a client cannot invent a price.
- Rate limiting: 12 checkout/portal requests per IP per minute.
- `Cache-Control: no-store` on all `/api/*`, and the service worker skips `/api/` entirely —
  a cached entitlement would otherwise show a stale paid state.
- **Before real money:** replace email-based identity with authenticated sessions. Today the
  app proves nothing about who owns an email — that is acceptable for test mode, not for
  live customers. The Supabase auth wiring in `README.md` §5 provides the session; pass its
  JWT to `/api/checkout` and trust `auth.uid()` instead of the posted email.

---

## 6. Go-live checklist

1. Complete Stripe account activation (business details, bank account).
2. Switch the keys to `sk_live_…` / `pk_live_…`, set `APP_URL` to the real domain.
3. Run `WEBHOOK_URL=https://…/api/stripe/webhook npm run stripe:setup` so the live webhook exists.
4. Save the Customer Portal configuration in **live** mode.
5. Do one real subscription end-to-end with a low-value test price, then refund it.
6. Turn on Stripe emails (Settings → Customer emails) for receipts and failed payments.
7. Add server-side auth (see above) before public launch.
