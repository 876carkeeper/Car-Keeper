/**
 * CarKeeper — payments server
 * Serves the PWA and exposes the Stripe Checkout / Billing / webhook API.
 * Secret keys stay here, server-side, and are never sent to the browser.
 */
import express from 'express';
import Stripe from 'stripe';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

const PORT = Number(env.PORT || 8080);
const APP_URL = (env.APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const DATA_DIR = env.DATA_DIR || path.join(__dirname, 'data');
const SECRET_KEY = (env.STRIPE_SECRET_KEY || '').trim();
const WEBHOOK_SECRET = (env.STRIPE_WEBHOOK_SECRET || '').trim();

/* STRIPE_API_* overrides exist for the integration test harness (scripts/../test-api.mjs).
   They are never set in production; leave them unset and the SDK talks to api.stripe.com. */
const stripeOpts = {};
if (env.STRIPE_API_HOST) {
  stripeOpts.host = env.STRIPE_API_HOST;
  stripeOpts.protocol = env.STRIPE_API_PROTOCOL || 'http';
  stripeOpts.port = Number(env.STRIPE_API_PORT || 443);
}
const stripe = SECRET_KEY ? new Stripe(SECRET_KEY, stripeOpts) : null;
const MODE = SECRET_KEY.startsWith('sk_live') ? 'live' : 'test';

/* ---------- price catalogue (from your Stripe account) ---------- */
const PRICE_ENV = {
  'basic:month': env.STRIPE_PRICE_BASIC_MONTH,
  'basic:year': env.STRIPE_PRICE_BASIC_YEAR,
  'premium:month': env.STRIPE_PRICE_PREMIUM_MONTH,
  'premium:year': env.STRIPE_PRICE_PREMIUM_YEAR
};
const KEY_BY_PRICE = Object.fromEntries(Object.entries(PRICE_ENV).filter(([, v]) => v).map(([k, v]) => [v, k]));
const PLAN_BY_PRICE = Object.fromEntries(Object.entries(PRICE_ENV).filter(([, v]) => v).map(([k, v]) => {
  const [plan, cycle] = k.split(':');
  return [v, { plan, cycle }];
}));

/* ---------- storage ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'carkeeper.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS subscriptions (
    account_email TEXT PRIMARY KEY, customer_id TEXT, stripe_subscription_id TEXT, plan TEXT,
    status TEXT, cycle TEXT, price_id TEXT, current_period_end TEXT, cancel_at_period_end INTEGER,
    updated_at TEXT);
  CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, type TEXT, created_at TEXT);
`);

const nowISO = () => new Date().toISOString();
const normEmail = (e) => String(e || '').trim().toLowerCase();
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(e || ''));

function saveCustomer(id, email) {
  const t = nowISO();
  db.prepare(`INSERT INTO customers (id, email, created_at, updated_at) VALUES (?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET email=excluded.email, updated_at=excluded.updated_at`)
    .run(id, normEmail(email), t, t);
  db.prepare(`UPDATE subscriptions SET customer_id=? WHERE account_email=?`).run(id, normEmail(email));
}
function getCustomer(email) {
  return db.prepare('SELECT * FROM customers WHERE email=?').get(normEmail(email));
}
function getSubscription(email) {
  return db.prepare('SELECT * FROM subscriptions WHERE account_email=?').get(normEmail(email));
}
function saveSubscription(sub, accountEmail) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const priceId = item && item.price ? item.price.id : null;
  const mapped = priceId ? PLAN_BY_PRICE[priceId] : null;
  const email = normEmail(accountEmail || (sub.metadata && sub.metadata.accountEmail) || '');
  if (!email) return null;
  const periodEnd = item && item.current_period_end ? new Date(item.current_period_end * 1000).toISOString() : null;
  db.prepare(`INSERT INTO subscriptions
      (account_email, customer_id, stripe_subscription_id, plan, status, cycle, price_id, current_period_end, cancel_at_period_end, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_email) DO UPDATE SET
        customer_id=excluded.customer_id, stripe_subscription_id=excluded.stripe_subscription_id,
        plan=excluded.plan, status=excluded.status, cycle=excluded.cycle, price_id=excluded.price_id,
        current_period_end=excluded.current_period_end, cancel_at_period_end=excluded.cancel_at_period_end,
        updated_at=excluded.updated_at`)
    .run(email, sub.customer || null, sub.id || null, mapped ? mapped.plan : 'free', sub.status || 'inactive',
      mapped ? mapped.cycle : (sub.items && sub.items.data[0] && sub.items.data[0].price.recurring
        ? sub.items.data[0].price.recurring.interval : null),
      priceId, periodEnd, sub.cancel_at_period_end ? 1 : 0, nowISO());
  return email;
}

/* entitlement: the single source of truth the app reads */
function entitlementFor(email) {
  const sub = getSubscription(email);
  if (!sub) return { verified: true, plan: 'free', status: 'none', paymentFailed: false, cancelAtPeriodEnd: false, currentPeriodEnd: null, source: 'server' };
  const live = sub.status === 'active' || sub.status === 'trialing';
  const grace = sub.status === 'past_due';
  return {
    verified: true,
    plan: (live || grace) ? sub.plan : 'free',
    status: sub.status,
    cycle: sub.cycle,
    paymentFailed: sub.status === 'past_due' || sub.status === 'unpaid',
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    currentPeriodEnd: sub.current_period_end,
    source: 'server'
  };
}

/* ---------- Stripe helpers ---------- */
async function getOrCreateCustomer(email) {
  const found = getCustomer(email);
  if (found && found.id) {
    try {
      const c = await stripe.customers.retrieve(found.id);
      if (c && !c.deleted) return c;
    } catch { /* fall through and recreate */ }
  }
  const list = await stripe.customers.list({ email: normEmail(email), limit: 1 });
  let customer = list.data[0];
  if (!customer) customer = await stripe.customers.create({ email: normEmail(email), metadata: { app: 'carkeeper' } });
  saveCustomer(customer.id, email);
  return customer;
}

async function syncFromStripe(email) {
  let customer = getCustomer(email);
  if (!customer) {
    /* the customer may exist in Stripe without a local row (created elsewhere,
       or after a database reset) — adopt it instead of reporting "free" */
    try {
      const list = await stripe.customers.list({ email: normEmail(email), limit: 1 });
      if (list.data.length) { saveCustomer(list.data[0].id, email); customer = getCustomer(email); }
    } catch (e) { console.warn('[sync] customer lookup failed:', e.message); }
  }
  if (!customer) return entitlementFor(email);
  const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 10 });
  const rank = { active: 0, trialing: 1, past_due: 2, unpaid: 3, incomplete: 4, canceled: 5, incomplete_expired: 6 };
  const best = subs.data.slice().sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))[0];
  if (best) {
    const withMeta = { ...best, metadata: { ...(best.metadata || {}), accountEmail: normEmail(email) } };
    saveSubscription(withMeta, email);
  }
  return entitlementFor(email);
}

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');

/* webhook needs the raw body — mount before the JSON parser */
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe is not configured' });
  if (!WEBHOOK_SECRET) return res.status(503).json({ error: 'STRIPE_WEBHOOK_SECRET is not set' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  /* idempotency: Stripe retries, and a replay must not double-apply */
  const fresh = db.prepare('INSERT OR IGNORE INTO events (id, type, created_at) VALUES (?,?,?)')
    .run(event.id, event.type, nowISO()).changes > 0;
  if (!fresh) return res.json({ received: true, duplicate: true });

  try {
    const obj = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': {
        const email = (obj.metadata && obj.metadata.accountEmail) || (obj.customer_details && obj.customer_details.email);
        if (obj.customer) saveCustomer(obj.customer, email);
        if (obj.subscription) {
          const sub = await stripe.subscriptions.retrieve(obj.subscription, { expand: ['items.data.price'] });
          saveSubscription({ ...sub, metadata: { ...(sub.metadata || {}), accountEmail: normEmail(email) } }, email);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const email = await resolveEmailForEvent(obj);
        if (email) saveSubscription(obj, email);
        break;
      }
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const subId = obj.subscription;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId, { expand: ['items.data.price'] });
          const email = await resolveEmailForEvent(sub);
          if (email) saveSubscription({ ...sub, status: event.type === 'invoice.payment_failed' ? 'past_due' : sub.status }, email);
        }
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

async function resolveEmailForEvent(sub) {
  if (sub.metadata && sub.metadata.accountEmail) return normEmail(sub.metadata.accountEmail);
  if (sub.customer) {
    const row = db.prepare('SELECT email FROM customers WHERE id=?').get(sub.customer);
    if (row) return row.email;
    try {
      const c = await stripe.customers.retrieve(sub.customer);
      if (c && c.email) { saveCustomer(c.id, c.email); return normEmail(c.email); }
    } catch { /* ignore */ }
  }
  return '';
}

app.use(express.json({ limit: '100kb' }));

/* --- tiny in-memory rate limit for the create-session endpoints --- */
const hits = new Map();
function rateLimit(key, max = 12, windowMs = 60_000) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length <= max;
}

/* billing + entitlement responses must never be cached, by us or by a proxy */
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    stripe: !!stripe,
    mode: MODE,
    webhookSecret: !!WEBHOOK_SECRET,
    pricesConfigured: Object.values(PRICE_ENV).filter(Boolean).length
  });
});

/* price details are cached so the plan screen shows the amount actually configured in Stripe */
let priceCache = { at: 0, data: null };
async function priceDetails(){
  if (priceCache.data && Date.now() - priceCache.at < 5 * 60_000) return priceCache.data;
  const entries = Object.entries(PRICE_ENV).filter(([, id]) => id);
  if (!stripe || !entries.length) return [];
  const out = await Promise.all(entries.map(async ([k, priceId]) => {
    const [plan, cycle] = k.split(':');
    try {
      const p = await stripe.prices.retrieve(priceId);
      return { plan, cycle, priceId, amount: p.unit_amount, currency: p.currency, interval: p.recurring && p.recurring.interval };
    } catch (e) {
      console.warn('[config] price lookup failed', priceId, e.message);
      return { plan, cycle, priceId };
    }
  }));
  priceCache = { at: Date.now(), data: out };
  return out;
}

app.get('/api/config', async (req, res) => {
  let plans = Object.entries(PRICE_ENV).filter(([, priceId]) => priceId)
    .map(([k, priceId]) => ({ plan: k.split(':')[0], cycle: k.split(':')[1], priceId }));
  try { plans = await priceDetails(); } catch (e) { /* fall back to bare ids */ }
  res.json({
    configured: !!(stripe && plans.length > 0),
    mode: MODE,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY || null,
    plans
  });
});

app.get('/api/entitlement', (req, res) => {
  const email = normEmail(req.query.email);
  if (!isEmail(email)) return res.status(400).json({ error: 'A valid email is required' });
  res.json(entitlementFor(email));
});

app.post('/api/checkout', async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe is not configured on this server.' });
    if (!rateLimit('checkout:' + (req.ip || 'x'))) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
    const email = normEmail(req.body && req.body.email);
    const plan = String((req.body && req.body.plan) || '');
    const cycle = String((req.body && req.body.cycle) || 'month');
    if (!isEmail(email)) return res.status(400).json({ error: 'Sign in with a valid email before subscribing.' });
    if (!['basic', 'premium'].includes(plan)) return res.status(400).json({ error: 'Unknown plan.' });
    if (!['month', 'year'].includes(cycle)) return res.status(400).json({ error: 'Unknown billing cycle.' });
    const priceId = PRICE_ENV[`${plan}:${cycle}`];
    if (!priceId) return res.status(400).json({ error: `No Stripe price configured for ${plan}/${cycle}. Run npm run stripe:setup.` });

    /* a customer who is already subscribed should manage, not re-buy */
    const existing = getSubscription(email);
    if (existing && (existing.status === 'active' || existing.status === 'trialing')) {
      return res.status(409).json({ error: 'This account already has a subscription.', alreadySubscribed: true });
    }

    const customer = await getOrCreateCustomer(email);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      client_reference_id: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/?checkout=cancelled`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      subscription_data: { metadata: { accountEmail: email, plan, cycle } },
      metadata: { accountEmail: email, plan, cycle }
    });
    res.json({ url: session.url, id: session.id });
  } catch (err) { next(err); }
});

app.post('/api/portal', async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe is not configured on this server.' });
    if (!rateLimit('portal:' + (req.ip || 'x'))) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
    const email = normEmail(req.body && req.body.email);
    if (!isEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
    const customer = getCustomer(email);
    if (!customer) return res.status(404).json({ error: 'No billing account found for that email yet.' });
    const session = await stripe.billingPortal.sessions.create({ customer: customer.id, return_url: `${APP_URL}/?billing=return` });
    res.json({ url: session.url });
  } catch (err) { next(err); }
});

/* pulls live state from Stripe — used right after checkout and by the app on load */
app.post('/api/sync', async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe is not configured on this server.' });
    const email = normEmail(req.body && req.body.email);
    if (!isEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
    res.json(await syncFromStripe(email));
  } catch (err) { next(err); }
});

/* ---------- static app (allowlist, so .env and server.js are never served) ---------- */
const PUBLIC = new Set(['index.html', 'manifest.webmanifest', 'sw.js', 'README.md', 'README-STRIPE.md',
  'icon-192.png', 'icon-512.png', 'icon-192-maskable.png', 'icon-512-maskable.png', 'apple-touch-icon.png']);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/:file', (req, res, next) => {
  const f = req.params.file;
  if (!PUBLIC.has(f)) return next();
  res.sendFile(path.join(__dirname, f), (err) => { if (err) next(err); });
});

/* JSON errors for API, plain 404 otherwise */
app.use('/api', (err, req, res, next) => {
  console.error('[api]', err.type || '', err.message);
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  res.status(status).json({ error: err.type === 'StripeAuthenticationError'
    ? 'Stripe rejected the API key. Check STRIPE_SECRET_KEY.'
    : (err.message || 'Unexpected server error') });
});
app.use((req, res) => res.status(404).send('Not found'));

app.listen(PORT, () => {
  console.log(`CarKeeper running on ${APP_URL}  (Stripe ${stripe ? MODE + ' mode' : 'NOT CONFIGURED'})`);
  if (!SECRET_KEY) console.log('→ set STRIPE_SECRET_KEY in .env to enable payments');
  if (!WEBHOOK_SECRET) console.log('→ set STRIPE_WEBHOOK_SECRET to recognise payments automatically');
  if (!Object.values(PRICE_ENV).some(Boolean)) console.log('→ run `npm run stripe:setup` to create prices');
});
