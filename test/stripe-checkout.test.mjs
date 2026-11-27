// LOCAL TEST ONLY: node --test test/*.mjs  (no network; Stripe faked)
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  paymentProvider,
  sanitizeAttribution,
  assertStripeTestMode,
  buildStripeCheckoutForm,
  verifyStripeSignature,
  stripeReturnOrigin,
} from '../worker/script-api.js';

const worker = (await import('../worker/script-api.js')).default;

let stripeCalls = [];

function parseForm(body) {
  return Object.fromEntries(new URLSearchParams(body));
}

function stripeFetch() {
  return async (url, init) => {
    const href = String(url);
    if (!href.startsWith('https://api.stripe.com/v1/')) throw new Error('blocked ' + href);
    stripeCalls.push({ url: href, method: (init && init.method) || 'GET', headers: init && init.headers, body: init && init.body });
    if (href.endsWith('/checkout/sessions') && init && init.method === 'POST') {
      return new Response(JSON.stringify({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' }), { status: 200 });
    }
    throw new Error('unexpected stripe ' + href);
  };
}

beforeEach(() => {
  stripeCalls = [];
  globalThis.fetch = stripeFetch();
});

const stripeEnv = {
  PAYMENT_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_PRICE_ID_MONTHLY: 'price_monthly',
  STRIPE_PRICE_ID_YEARLY: 'price_yearly',
  STRIPE_PRICE_ID_LIFETIME: 'price_lifetime',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
};

function checkout(env, plan, attribution) {
  return worker.fetch(
    new Request('https://x.test/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://clickprompt.app' },
      body: JSON.stringify({ plan, origin: 'https://clickprompt.app', attribution }),
    }),
    env,
    { waitUntil() {} }
  );
}

function memoryKv() {
  const store = new Map();
  return {
    async get(key, type) {
      if (!store.has(key)) return null;
      const v = store.get(key);
      if (type === 'json') return JSON.parse(v);
      return v;
    },
    async put(key, value) {
      store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

async function signStripe(secret, rawBody, ts) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(ts) + '.' + rawBody));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return 't=' + ts + ',v1=' + hex;
}

test('paymentProvider defaults to lemonsqueezy', () => {
  assert.equal(paymentProvider({}), 'lemonsqueezy');
  assert.equal(paymentProvider({ PAYMENT_PROVIDER: '' }), 'lemonsqueezy');
  assert.equal(paymentProvider({ PAYMENT_PROVIDER: 'LemonSqueezy' }), 'lemonsqueezy');
  assert.equal(paymentProvider({ PAYMENT_PROVIDER: 'other' }), 'lemonsqueezy');
  assert.equal(paymentProvider({ PAYMENT_PROVIDER: 'stripe' }), 'stripe');
  assert.equal(paymentProvider({ PAYMENT_PROVIDER: 'STRIPE' }), 'stripe');
});

test('assertStripeTestMode refuses live keys unless STRIPE_ALLOW_LIVE=true', () => {
  assert.throws(() => assertStripeTestMode({}), (e) => e.status === 503);
  assert.throws(
    () => assertStripeTestMode({ STRIPE_SECRET_KEY: 'sk_live_abc' }),
    (e) => e.status === 503 && /STRIPE_ALLOW_LIVE=true/.test(e.message) && !/sk_live_/.test(e.message)
  );
  assert.equal(assertStripeTestMode({ STRIPE_SECRET_KEY: 'sk_test_abc' }), 'sk_test_abc');
  assert.equal(
    assertStripeTestMode({ STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_ALLOW_LIVE: 'true' }),
    'sk_live_abc'
  );
});

test('live-key checkout is refused and does not call Stripe', async () => {
  const r = await checkout({ ...stripeEnv, STRIPE_SECRET_KEY: 'sk_live_abc' }, 'monthly');
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.match(body.error, /STRIPE_ALLOW_LIVE=true/);
  assert.doesNotMatch(body.error, /sk_live_/);
  assert.deepEqual(stripeCalls, []);
});

test('STRIPE_ALLOW_LIVE=true lets a live key through to session creation', async () => {
  const r = await checkout({ ...stripeEnv, STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_ALLOW_LIVE: 'true' }, 'monthly');
  assert.equal(r.status, 200);
  assert.equal(stripeCalls.length, 1);
  assert.equal(stripeCalls[0].headers.Authorization, 'Bearer sk_live_abc');
});

test('session creation: monthly is a subscription on the monthly price', async () => {
  const r = await checkout(stripeEnv, 'monthly');
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.url, 'https://checkout.stripe.com/c/pay/cs_test_123');
  assert.match(data.token, /^sub:[0-9a-f]{32}$/);
  assert.equal(stripeCalls.length, 1);
  assert.equal(stripeCalls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(stripeCalls[0].method, 'POST');
  assert.equal(stripeCalls[0].headers.Authorization, 'Bearer sk_test_123');
  assert.equal(stripeCalls[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = parseForm(stripeCalls[0].body);
  assert.equal(form.mode, 'subscription');
  assert.equal(form['line_items[0][price]'], 'price_monthly');
  assert.equal(form['line_items[0][quantity]'], '1');
  assert.equal(form.success_url, 'https://clickprompt.app/?checkout=done');
  assert.equal(form.cancel_url, 'https://clickprompt.app/?checkout=cancel');
  assert.equal(form['metadata[unlock_token]'], data.token);
  assert.equal(form['metadata[plan]'], 'monthly');
  assert.equal(form['subscription_data[metadata][unlock_token]'], data.token);
  assert.equal(form.client_reference_id, data.token);
});

test('session creation: yearly uses the yearly price; annual alias works', async () => {
  let r = await checkout(stripeEnv, 'yearly');
  assert.equal(r.status, 200);
  assert.equal(parseForm(stripeCalls[0].body).mode, 'subscription');
  assert.equal(parseForm(stripeCalls[0].body)['line_items[0][price]'], 'price_yearly');
  stripeCalls = [];
  r = await checkout(stripeEnv, 'annual');
  assert.equal(r.status, 200);
  assert.equal(parseForm(stripeCalls[0].body)['line_items[0][price]'], 'price_yearly');
});

test('session creation: lifetime is a one-time payment', async () => {
  const r = await checkout(stripeEnv, 'lifetime');
  assert.equal(r.status, 200);
  const form = parseForm(stripeCalls[0].body);
  assert.equal(form.mode, 'payment');
  assert.equal(form['line_items[0][price]'], 'price_lifetime');
  assert.equal(form['payment_intent_data[metadata][plan]'], 'lifetime');
  assert.ok(!form['subscription_data[metadata][unlock_token]']);
});

test('session creation: yearly falls back to STRIPE_PRICE_ID_ANNUAL', async () => {
  const env = { ...stripeEnv };
  delete env.STRIPE_PRICE_ID_YEARLY;
  env.STRIPE_PRICE_ID_ANNUAL = 'price_annual';
  const r = await checkout(env, 'yearly');
  assert.equal(r.status, 200);
  assert.equal(parseForm(stripeCalls[0].body)['line_items[0][price]'], 'price_annual');
});

test('session creation puts sanitized attribution in metadata', async () => {
  const r = await checkout(stripeEnv, 'monthly', {
    source: 'reddit',
    medium: 'cpc',
    campaign: 'first10',
    content: 'ad-1',
    term: 'teleprompter',
    referrer: 'https://reddit.com/r/something',
    landing: 'https://clickprompt.app/?utm_source=reddit',
    ts: '2026-11-27T13:00:00.000Z',
    extra: 'drop-me',
    campaign_inject: '<script>',
  });
  assert.equal(r.status, 200);
  const form = parseForm(stripeCalls[0].body);
  assert.equal(form['metadata[attr_source]'], 'reddit');
  assert.equal(form['metadata[attr_medium]'], 'cpc');
  assert.equal(form['metadata[attr_campaign]'], 'first10');
  assert.equal(form['metadata[attr_content]'], 'ad-1');
  assert.equal(form['metadata[attr_term]'], 'teleprompter');
  assert.equal(form['metadata[attr_referrer]'], 'https://reddit.com/r/something');
  assert.equal(form['metadata[attr_landing]'], 'https://clickprompt.app/?utm_source=reddit');
  assert.equal(form['metadata[attr_ts]'], '2026-11-27T13:00:00.000Z');
  assert.equal(form['subscription_data[metadata][attr_source]'], 'reddit');
  assert.ok(!form['metadata[attr_extra]']);
  assert.ok(!form['metadata[extra]']);
});

test('sanitizeAttribution drops non-printable and unknown keys', () => {
  assert.equal(sanitizeAttribution(null), null);
  assert.equal(sanitizeAttribution('reddit'), null);
  const got = sanitizeAttribution({
    source: 'red\x01dit',
    medium: 'x'.repeat(300),
    campaign: 'first10',
    evil: 'nope',
  });
  assert.equal(got.source, undefined);
  assert.equal(got.campaign, 'first10');
  assert.ok(!got.evil);
  assert.equal(got.medium.length, 200);
});

test('buildStripeCheckoutForm encodes success and cancel URLs on clickprompt.app', () => {
  const body = buildStripeCheckoutForm({
    mode: 'subscription',
    priceId: 'price_monthly',
    origin: 'https://clickprompt.app',
    token: 'sub:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    plan: 'monthly',
  });
  const form = parseForm(body);
  assert.equal(form.success_url, 'https://clickprompt.app/?checkout=done');
  assert.equal(form.cancel_url, 'https://clickprompt.app/?checkout=cancel');
});

test('stripeReturnOrigin always uses clickprompt.app', () => {
  assert.equal(stripeReturnOrigin('https://clickprompt.app'), 'https://clickprompt.app');
  assert.equal(stripeReturnOrigin('https://www.clickprompt.app'), 'https://www.clickprompt.app');
  assert.equal(stripeReturnOrigin('https://evil.example'), 'https://clickprompt.app');
  assert.equal(stripeReturnOrigin('https://teleprompter.pages.dev'), 'https://clickprompt.app');
});

test('webhook signature: valid, invalid, and stale', async () => {
  const secret = 'whsec_test_secret';
  const raw = '{"id":"evt_1","type":"ping"}';
  const now = 1_700_000_000; // unix seconds
  const nowMs = now * 1000;
  const valid = await signStripe(secret, raw, now);
  assert.equal(await verifyStripeSignature(raw, valid, secret, nowMs), true);

  const bad = valid.slice(0, -2) + '00';
  assert.equal(await verifyStripeSignature(raw, bad, secret, nowMs), false);
  assert.equal(await verifyStripeSignature(raw, valid, 'whsec_other', nowMs), false);
  assert.equal(await verifyStripeSignature(raw, '', secret, nowMs), false);
  assert.equal(await verifyStripeSignature(raw, valid, '', nowMs), false);

  const stale = await signStripe(secret, raw, now - 301);
  assert.equal(await verifyStripeSignature(raw, stale, secret, nowMs), false);
  const almost = await signStripe(secret, raw, now - 299);
  assert.equal(await verifyStripeSignature(raw, almost, secret, nowMs), true);
});

test('signed checkout.session.completed unlocks a lifetime purchase', async () => {
  const kv = memoryKv();
  const token = 'sub:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const raw = JSON.stringify({
    id: 'evt_lifetime_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_life',
        mode: 'payment',
        payment_status: 'paid',
        metadata: { unlock_token: token, plan: 'lifetime' },
        customer_details: { email: 'buyer@example.com' },
      },
    },
  });
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signStripe(stripeEnv.STRIPE_WEBHOOK_SECRET, raw, ts);
  const r = await worker.fetch(
    new Request('https://x.test/api/stripe-webhook', {
      method: 'POST',
      headers: { 'Stripe-Signature': sig, 'Content-Type': 'application/json' },
      body: raw,
    }),
    { ...stripeEnv, KV: kv },
    { waitUntil() {} }
  );
  assert.equal(r.status, 200);
  const rec = await kv.get('sub:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'json');
  assert.equal(rec.status, 'lifetime');
  assert.equal(rec.provider, 'stripe');
  assert.equal(rec.email, 'buyer@example.com');
});

test('unsigned or live-key webhook is refused', async () => {
  const raw = JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signStripe(stripeEnv.STRIPE_WEBHOOK_SECRET, raw, ts);
  const bad = await worker.fetch(
    new Request('https://x.test/api/stripe-webhook', {
      method: 'POST',
      headers: { 'Stripe-Signature': 't=' + ts + ',v1=deadbeef', 'Content-Type': 'application/json' },
      body: raw,
    }),
    { ...stripeEnv, KV: memoryKv() },
    { waitUntil() {} }
  );
  assert.equal(bad.status, 401);

  const live = await worker.fetch(
    new Request('https://x.test/api/stripe-webhook', {
      method: 'POST',
      headers: { 'Stripe-Signature': sig, 'Content-Type': 'application/json' },
      body: raw,
    }),
    { ...stripeEnv, STRIPE_SECRET_KEY: 'sk_live_abc', KV: memoryKv() },
    { waitUntil() {} }
  );
  assert.equal(live.status, 503);
});
