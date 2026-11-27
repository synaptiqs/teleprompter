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
let stripeSessionExpands = {};
let stripeSessionExpandErrors = {};

function parseForm(body) {
  return Object.fromEntries(new URLSearchParams(body));
}

function catalogLineItems(plan) {
  const catalog = {
    monthly: { id: 'price_monthly', unit_amount: 399 },
    yearly: { id: 'price_yearly', unit_amount: 2900 },
    lifetime: { id: 'price_lifetime', unit_amount: 5900 },
  };
  const p = catalog[plan];
  return {
    data: [{
      quantity: 1,
      currency: 'usd',
      amount_total: p.unit_amount,
      price: { id: p.id, currency: 'usd', unit_amount: p.unit_amount },
    }],
  };
}

function me(env, token) {
  return worker.fetch(
    new Request('https://x.test/api/me?token=' + encodeURIComponent(token)),
    env,
    { waitUntil() {} }
  );
}

function stripeFetch() {
  return async (url, init) => {
    const href = String(url);
    if (!href.startsWith('https://api.stripe.com/v1/')) throw new Error('blocked ' + href);
    stripeCalls.push({ url: href, method: (init && init.method) || 'GET', headers: init && init.headers, body: init && init.body });
    if (href.endsWith('/checkout/sessions') && init && init.method === 'POST') {
      return new Response(JSON.stringify({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' }), { status: 200 });
    }
    const sessionGet = href.match(/^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/([^?]+)/);
    if (sessionGet && (!init || !init.method || init.method === 'GET')) {
      const sid = decodeURIComponent(sessionGet[1]);
      if (stripeSessionExpandErrors[sid]) {
        const fail = stripeSessionExpandErrors[sid];
        if (typeof fail === 'function') return fail();
        if (fail instanceof Error) throw fail;
        return new Response(JSON.stringify({ error: { message: 'unavailable' } }), { status: Number(fail) || 500 });
      }
      if (stripeSessionExpands[sid]) {
        return new Response(JSON.stringify(stripeSessionExpands[sid]), { status: 200 });
      }
    }
    throw new Error('unexpected stripe ' + href);
  };
}

beforeEach(() => {
  stripeCalls = [];
  stripeSessionExpands = {};
  stripeSessionExpandErrors = {};
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
  assert.throws(
    () => assertStripeTestMode({ STRIPE_SECRET_KEY: 'rk_live_abc' }),
    (e) => e.status === 503 && /STRIPE_ALLOW_LIVE=true/.test(e.message) && !/rk_live_/.test(e.message)
  );
  assert.throws(
    () => assertStripeTestMode({ STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_ALLOW_LIVE: 'TRUE' }),
    (e) => e.status === 503
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
  assert.equal(stripeCalls[0].headers['Stripe-Version'], '2025-03-31.basil');
  assert.match(stripeCalls[0].headers['Idempotency-Key'], /^cp_checkout_sub:[0-9a-f]{32}$/);
  const form = parseForm(stripeCalls[0].body);
  assert.equal(form.mode, 'subscription');
  assert.equal(form['line_items[0][price]'], 'price_monthly');
  assert.equal(form['line_items[0][quantity]'], '1');
  assert.equal(form['payment_method_types[0]'], 'card');
  assert.equal(form.success_url, 'https://clickprompt.app/?checkout=done');
  assert.equal(form.cancel_url, 'https://clickprompt.app/?checkout=cancel');
  assert.equal(form['metadata[unlock_token]'], data.token);
  assert.equal(form['metadata[plan]'], 'monthly');
  assert.equal(form['subscription_data[metadata][unlock_token]'], data.token);
  assert.equal(form.client_reference_id, data.token);
});

test('session creation: yearly uses the yearly price', async () => {
  const r = await checkout(stripeEnv, 'yearly');
  assert.equal(r.status, 200);
  assert.equal(parseForm(stripeCalls[0].body).mode, 'subscription');
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
  assert.equal(form['metadata[attr_referrer]'], 'reddit.com');
  assert.equal(form['metadata[attr_landing]'], '/');
  assert.equal(form['metadata[attr_timestamp]'], '2026-11-27T13:00:00.000Z');
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
  const urls = sanitizeAttribution({
    referrer: 'https://reddit.com/r/something?utm=1',
    landing: 'https://clickprompt.app/pricing?utm_source=reddit#hash',
  });
  assert.equal(urls.referrer, 'reddit.com');
  assert.equal(urls.landing, '/pricing');
  assert.ok(!String(urls.referrer).includes('?'));
  assert.ok(!String(urls.landing).includes('?'));
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
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'cs_test_life',
        mode: 'payment',
        payment_status: 'paid',
        metadata: { unlock_token: token, plan: 'lifetime' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_lifetime', currency: 'usd' } }] },
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

test('unsigned webhook returns 400', async () => {
  const raw = JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', livemode: false, data: { object: {} } });
  const ts = Math.floor(Date.now() / 1000);
  const bad = await worker.fetch(
    new Request('https://x.test/api/stripe-webhook', {
      method: 'POST',
      headers: { 'Stripe-Signature': 't=' + ts + ',v1=deadbeef', 'Content-Type': 'application/json' },
      body: raw,
    }),
    { ...stripeEnv, KV: memoryKv() },
    { waitUntil() {} }
  );
  assert.equal(bad.status, 400);
});

function webhookRequest(raw, env, sig) {
  return worker.fetch(
    new Request('https://x.test/api/stripe-webhook', {
      method: 'POST',
      headers: { 'Stripe-Signature': sig, 'Content-Type': 'application/json' },
      body: raw,
    }),
    env,
    { waitUntil() {} }
  );
}

async function signedWebhook(env, event) {
  const raw = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signStripe(env.STRIPE_WEBHOOK_SECRET || stripeEnv.STRIPE_WEBHOOK_SECRET, raw, ts);
  return webhookRequest(raw, env, sig);
}

test('checkout errors stay generic and do not echo Stripe details', async () => {
  globalThis.fetch = async (url, init) => {
    stripeCalls.push({ url: String(url), headers: init && init.headers, body: init && init.body });
    return new Response(JSON.stringify({ error: { message: 'No such price: price_secret_detail', code: 'resource_missing' } }), { status: 400 });
  };
  const r = await checkout(stripeEnv, 'monthly');
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.equal(body.error, 'Could not start checkout. Try again.');
  assert.doesNotMatch(body.error, /price_secret_detail|resource_missing|sk_test_/);
});

test('signed subscription completed with payment_status unpaid writes no active record', async () => {
  const kv = memoryKv();
  const token = 'sub:' + 'c'.repeat(32);
  const r = await signedWebhook({ ...stripeEnv, KV: kv }, {
    id: 'evt_unpaid_1',
    type: 'checkout.session.completed',
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'cs_unpaid',
        mode: 'subscription',
        payment_status: 'unpaid',
        metadata: { unlock_token: token, plan: 'monthly' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_monthly', currency: 'usd' } }] },
        subscription: 'sub_unpaid',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + 'c'.repeat(32)), null);
});

test('signed subscription completed with missing payment_status writes nothing', async () => {
  const kv = memoryKv();
  const token = 'sub:' + 'd'.repeat(32);
  const r = await signedWebhook({ ...stripeEnv, KV: kv }, {
    id: 'evt_missing_ps',
    type: 'checkout.session.completed',
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'cs_missing',
        mode: 'subscription',
        metadata: { unlock_token: token, plan: 'monthly' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_monthly', currency: 'usd' } }] },
        subscription: 'sub_missing',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + 'd'.repeat(32)), null);
});

test('no_payment_required and async_payment_succeeded grant; async_payment_failed does not revoke', async () => {
  const kv = memoryKv();
  const token = 'sub:' + 'e'.repeat(32);
  let r = await signedWebhook({ ...stripeEnv, KV: kv }, {
    id: 'evt_npr',
    type: 'checkout.session.completed',
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'cs_npr',
        mode: 'subscription',
        payment_status: 'no_payment_required',
        metadata: { unlock_token: token, plan: 'monthly' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_monthly', currency: 'usd' } }] },
        subscription: 'sub_npr',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + 'e'.repeat(32), 'json')).status, 'active');

  const token2 = 'sub:' + 'f'.repeat(32);
  r = await signedWebhook({ ...stripeEnv, KV: kv }, {
    id: 'evt_async_ok',
    type: 'checkout.session.async_payment_succeeded',
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'cs_async_ok',
        mode: 'subscription',
        payment_status: 'paid',
        metadata: { unlock_token: token2, plan: 'monthly' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_monthly', currency: 'usd' } }] },
        subscription: 'sub_async',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + 'f'.repeat(32), 'json')).status, 'active');

  r = await signedWebhook({ ...stripeEnv, KV: kv }, {
    id: 'evt_async_fail',
    type: 'checkout.session.async_payment_failed',
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'cs_async_ok',
        mode: 'subscription',
        payment_status: 'unpaid',
        metadata: { unlock_token: token2, plan: 'monthly' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_monthly', currency: 'usd' } }] },
        subscription: 'sub_async',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + 'f'.repeat(32), 'json')).status, 'active');
});

test('lifetime grant requires meta.plan lifetime and does not overwrite a subscriber', async () => {
  const kv = memoryKv();
  const token = 'sub:' + 'aa'.repeat(16);
  let r = await signedWebhook({ ...stripeEnv, KV: kv }, {
    id: 'evt_not_life',
    type: 'checkout.session.completed',
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'cs_not_life',
        mode: 'payment',
        payment_status: 'paid',
        metadata: { unlock_token: token, plan: 'monthly' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_monthly', currency: 'usd' } }] }
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + 'aa'.repeat(16)), null);

  const subToken = 'sub:' + 'ab'.repeat(16);
  await kv.put('sub:' + 'ab'.repeat(16), JSON.stringify({ status: 'active', stripe_subscription_id: 'sub_keep', updated_at: Date.now() }));
  r = await signedWebhook({ ...stripeEnv, KV: kv }, {
    id: 'evt_life_over',
    type: 'checkout.session.completed',
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'cs_life_over',
        mode: 'payment',
        payment_status: 'paid',
        metadata: { unlock_token: subToken, plan: 'lifetime' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_lifetime', currency: 'usd' } }] }
      },
    },
  });
  assert.equal(r.status, 200);
  const rec = await kv.get('sub:' + 'ab'.repeat(16), 'json');
  assert.equal(rec.status, 'active');
  assert.equal(rec.stripe_subscription_id, 'sub_keep');
});

test('refund and dispute end Pro for a lifetime purchase', async () => {
  const kv = memoryKv();
  const hex = 'ac'.repeat(16);
  const token = 'sub:' + hex;
  const created = Math.floor(Date.now() / 1000);
  let r = await signedWebhook({ ...stripeEnv, KV: kv }, {
    id: 'evt_life_paid',
    type: 'checkout.session.completed',
    livemode: false,
    created,
    data: {
      object: {
        id: 'cs_life_paid',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_life',
        metadata: { unlock_token: token, plan: 'lifetime' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_lifetime', currency: 'usd' } }] },
        customer_details: { email: 'buyer@example.com' },
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'lifetime');

  r = await signedWebhook({ ...stripeEnv, KV: kv }, {
    id: 'evt_refunded',
    type: 'charge.refunded',
    livemode: false,
    created: created + 1,
    data: { object: { id: 'ch_life', object: 'charge', payment_intent: 'pi_life', refunded: true } },
  });
  assert.equal(r.status, 200);
  let rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
  assert.ok(rec.ends_at);
  assert.ok(Date.parse(rec.ends_at) <= Date.now());

  await kv.put('sub:' + hex, JSON.stringify({ status: 'lifetime', updated_at: Date.now() }));
  await kv.put('stripepi:pi_life', hex);
  r = await signedWebhook({ ...stripeEnv, KV: kv }, {
    id: 'evt_dispute',
    type: 'charge.dispute.created',
    livemode: false,
    created: created + 2,
    data: { object: { id: 'dp_life', object: 'dispute', payment_intent: 'pi_life' } },
  });
  assert.equal(r.status, 200);
  rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
});

test('out-of-order checkout.session.completed does not override a cancelled subscriber', async () => {
  const kv = memoryKv();
  const hex = 'ad'.repeat(16);
  const now = Date.now();
  await kv.put('sub:' + hex, JSON.stringify({
    status: 'cancelled',
    cancel_pending: true,
    stripe_subscription_id: 'sub_j',
    updated_at: now,
  }));
  const r = await signedWebhook({ ...stripeEnv, KV: kv }, {
    id: 'evt_late_completed',
    type: 'checkout.session.completed',
    livemode: false,
    created: Math.floor(now / 1000) - 30,
    data: {
      object: {
        id: 'cs_late',
        mode: 'subscription',
        payment_status: 'paid',
        metadata: { unlock_token: 'sub:' + hex, plan: 'monthly' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_monthly', currency: 'usd' } }] },
        subscription: 'sub_j',
      },
    },
  });
  assert.equal(r.status, 200);
  const rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'cancelled');
  assert.equal(rec.cancel_pending, true);
});

test('livemode must match the secret key mode', async () => {
  const kv = memoryKv();
  const event = {
    id: 'evt_live_1',
    type: 'checkout.session.completed',
    livemode: true,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'cs_x', mode: 'subscription', payment_status: 'paid', metadata: { unlock_token: 'sub:' + 'ae'.repeat(16), plan: 'monthly' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_monthly', currency: 'usd' } }] } } },
  };
  let r = await signedWebhook({ ...stripeEnv, KV: kv }, event);
  assert.equal(r.status, 400);

  r = await signedWebhook({ ...stripeEnv, STRIPE_SECRET_KEY: 'sk_live_abc', KV: kv }, event);
  assert.equal(r.status, 400);

  r = await signedWebhook({ ...stripeEnv, STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_ALLOW_LIVE: 'true', KV: kv }, event);
  assert.equal(r.status, 200);

  const testEvent = { ...event, id: 'evt_test_mismatch', livemode: false };
  r = await signedWebhook({ ...stripeEnv, STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_ALLOW_LIVE: 'true', KV: kv }, testEvent);
  assert.equal(r.status, 400);
});

test('empty event id is rejected; previous webhook secret is accepted', async () => {
  const kv = memoryKv();
  let r = await signedWebhook({ ...stripeEnv, KV: kv }, {
    id: '',
    type: 'checkout.session.completed',
    livemode: false,
    data: { object: {} },
  });
  assert.equal(r.status, 400);

  const ts = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({
    id: 'evt_prev',
    type: 'ping',
    livemode: false,
    created: ts,
    data: { object: {} },
  });
  const sig = await signStripe('whsec_previous', raw, ts);
  r = await webhookRequest(raw, { ...stripeEnv, STRIPE_WEBHOOK_SECRET_PREV: 'whsec_previous', KV: kv }, sig);
  assert.equal(r.status, 200);
  assert.ok(await kv.get('stripe:evt:evt_prev'));
});

test('oversized webhook is 413; non-POST is 405 without CORS', async () => {
  const tooBig = await worker.fetch(
    new Request('https://x.test/api/stripe-webhook', {
      method: 'POST',
      headers: { 'Content-Length': '2000000', 'Stripe-Signature': 't=1,v1=ab', 'Content-Type': 'application/json' },
      body: '{}',
    }),
    { ...stripeEnv, KV: memoryKv() },
    { waitUntil() {} }
  );
  assert.equal(tooBig.status, 413);

  const get = await worker.fetch(
    new Request('https://x.test/api/stripe-webhook', { method: 'GET' }),
    { ...stripeEnv, KV: memoryKv() },
    { waitUntil() {} }
  );
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST');
  assert.equal(get.headers.get('Access-Control-Allow-Origin'), null);

  const opt = await worker.fetch(
    new Request('https://x.test/api/stripe-webhook', { method: 'OPTIONS' }),
    { ...stripeEnv, KV: memoryKv() },
    { waitUntil() {} }
  );
  assert.equal(opt.status, 405);
  assert.equal(opt.headers.get('Access-Control-Allow-Origin'), null);
});

test('strict digits are required in the Stripe-Signature timestamp', async () => {
  const secret = 'whsec_test_secret';
  const raw = '{"id":"evt_1","type":"ping"}';
  const now = 1700000000;
  const valid = await signStripe(secret, raw, now);
  const tampered = valid.replace('t=' + now, 't=1700000000e0');
  assert.equal(await verifyStripeSignature(raw, tampered, secret, now * 1000), false);
});

test('Stripe plan allowlist is exact and rejects everything else with a generic 400', async () => {
  const rejected = [
    'Yearly',
    'LIFETIME',
    'annual',
    'price_x',
    '',
    'monthly ',
    "monthly'; DROP TABLE",
    'storage250',
    12,
    true,
    { plan: 'monthly' },
    ['monthly'],
  ];
  for (const plan of rejected) {
    stripeCalls = [];
    const r = await worker.fetch(
      new Request('https://x.test/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://clickprompt.app' },
        body: JSON.stringify({ plan, origin: 'https://clickprompt.app' }),
      }),
      stripeEnv,
      { waitUntil() {} }
    );
    assert.equal(r.status, 400, String(plan));
    const body = await r.json();
    assert.equal(body.error, "That plan isn't available.");
    assert.doesNotMatch(body.error, /Yearly|LIFETIME|annual|price_x|storage250|DROP TABLE/i);
    assert.deepEqual(stripeCalls, []);
  }
  for (const plan of ['monthly', 'yearly', 'lifetime']) {
    stripeCalls = [];
    const r = await checkout(stripeEnv, plan);
    assert.equal(r.status, 200, plan);
    assert.equal(stripeCalls.length, 1);
  }
});

test('older Stripe events are ignored once a newer created timestamp is stored', async () => {
  const kv = memoryKv();
  const hex = 'd'.repeat(32);
  const token = 'sub:' + hex;
  const env = { ...stripeEnv, KV: kv };
  const ends = 1_900_000_000;
  const newer = await signedWebhook(env, {
    id: 'evt_sub_newer_cancel',
    type: 'customer.subscription.updated',
    livemode: false,
    created: 2_000,
    data: {
      object: {
        id: 'sub_order_1',
        status: 'active',
        cancel_at_period_end: true,
        items: { data: [{ current_period_end: ends }] },
        metadata: { unlock_token: token, plan: 'monthly' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_monthly', currency: 'usd' } }] }
      },
    },
  });
  assert.equal(newer.status, 200);
  let rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'cancelled');
  assert.equal(rec.cancel_pending, true);
  assert.equal(rec.last_event_created, 2_000);

  const older = await signedWebhook(env, {
    id: 'evt_sub_older_clear',
    type: 'customer.subscription.updated',
    livemode: false,
    created: 1_000,
    data: {
      object: {
        id: 'sub_order_1',
        status: 'active',
        cancel_at_period_end: false,
        items: { data: [{ current_period_end: ends }] },
        metadata: { unlock_token: token, plan: 'monthly' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_monthly', currency: 'usd' } }] }
      },
    },
  });
  assert.equal(older.status, 200);
  rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'cancelled');
  assert.equal(rec.cancel_pending, true);
  assert.equal(rec.last_event_created, 2_000);

  const deletedHex = 'e'.repeat(32);
  await kv.put('sub:' + deletedHex, JSON.stringify({
    status: 'cancelled',
    deleted: true,
    deleted_at: 1,
    last_event_created: 5_000,
    stripe_subscription_id: 'sub_deleted_1',
    provider: 'stripe',
  }));
  const afterDelete = await signedWebhook(env, {
    id: 'evt_checkout_after_delete',
    type: 'checkout.session.completed',
    livemode: false,
    created: 6_000,
    data: {
      object: {
        id: 'cs_after_delete',
        mode: 'subscription',
        payment_status: 'paid',
        subscription: 'sub_deleted_1',
        metadata: { unlock_token: 'sub:' + deletedHex, plan: 'monthly' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_monthly', currency: 'usd' } }] }
      },
    },
  });
  assert.equal(afterDelete.status, 200);
  rec = await kv.get('sub:' + deletedHex, 'json');
  assert.equal(rec.deleted, true);
  assert.equal(rec.status, 'cancelled');
  assert.notEqual(rec.status, 'active');
});

test('bound stripesub mapping is trusted over a disagreeing unlock_token', async () => {
  const kv = memoryKv();
  const hexA = 'a'.repeat(32);
  const hexB = 'b'.repeat(32);
  const env = { ...stripeEnv, KV: kv };
  const logs = [];
  const orig = console.log;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  try {
    const first = await signedWebhook(env, {
      id: 'evt_bind_first',
      type: 'customer.subscription.updated',
      livemode: false,
      created: 3_000,
      data: {
        object: {
          id: 'sub_bound_1',
          status: 'active',
          cancel_at_period_end: false,
          metadata: { unlock_token: 'sub:' + hexA, plan: 'monthly' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_monthly', currency: 'usd' } }] }
        },
      },
    });
    assert.equal(first.status, 200);
    assert.equal(await kv.get('stripesub:sub_bound_1'), hexA);
    let recA = await kv.get('sub:' + hexA, 'json');
    assert.equal(recA.status, 'active');

    const second = await signedWebhook(env, {
      id: 'evt_bind_retarget',
      type: 'customer.subscription.updated',
      livemode: false,
      created: 4_000,
      data: {
        object: {
          id: 'sub_bound_1',
          status: 'active',
          cancel_at_period_end: true,
          metadata: { unlock_token: 'sub:' + hexB, plan: 'monthly' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_monthly', currency: 'usd' } }] }
        },
      },
    });
    assert.equal(second.status, 200);
  } finally {
    console.log = orig;
  }
  assert.equal(await kv.get('stripesub:sub_bound_1'), hexA);
  const recA = await kv.get('sub:' + hexA, 'json');
  assert.equal(recA.status, 'cancelled');
  assert.equal(recA.cancel_pending, true);
  assert.equal(await kv.get('sub:' + hexB, 'json'), null);
  assert.ok(logs.some((line) => /unlock_token does not match stored mapping/.test(line)));
  assert.ok(logs.every((line) => !line.includes(hexA) && !line.includes(hexB) && !line.includes('sub:')));
});

test('webhook secret that does not start with whsec_ returns 503 and is not processed', async () => {
  const kv = memoryKv();
  const raw = JSON.stringify({
    id: 'evt_bad_secret',
    type: 'checkout.session.completed',
    livemode: false,
    created: 1,
    data: {
      object: {
        id: 'cs_bad_secret',
        mode: 'subscription',
        payment_status: 'paid',
        metadata: { unlock_token: 'sub:' + 'f'.repeat(32), plan: 'monthly' }, line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_monthly', currency: 'usd' } }] }
      },
    },
  });
  for (const secret of ['', 'sk_test_not_a_webhook', 'whsec', 'WHSEC_test', ' secret_x ']) {
    const env = { ...stripeEnv, STRIPE_WEBHOOK_SECRET: secret, KV: kv };
    const r = await worker.fetch(
      new Request('https://x.test/api/stripe-webhook', {
        method: 'POST',
        headers: { 'Stripe-Signature': 't=1,v1=ab', 'Content-Type': 'application/json' },
        body: raw,
      }),
      env,
      { waitUntil() {} }
    );
    assert.equal(r.status, 503, String(secret));
    const body = await r.json();
    assert.equal(body.error, 'STRIPE_WEBHOOK_SECRET is missing or invalid.');
    assert.equal(await kv.get('stripe:evt:evt_bad_secret'), null);
    assert.equal(await kv.get('sub:' + 'f'.repeat(32)), null);
  }
});

test('PR #14 attribution keys map into Stripe metadata and drop illegal UTM characters', async () => {
  const r = await checkout(stripeEnv, 'monthly', {
    utm_source: 'reddit',
    utm_medium: 'cpc',
    utm_campaign: 'first10',
    utm_content: 'ad-1',
    utm_term: 'teleprompter',
    referrer: 'https://reddit.com/r/something?x=1',
    landing: 'https://clickprompt.app/pricing?utm_source=reddit',
    timestamp: '2026-11-27T13:00:00.000Z',
  });
  assert.equal(r.status, 200);
  const form = parseForm(stripeCalls[0].body);
  assert.equal(form['metadata[attr_source]'], 'reddit');
  assert.equal(form['metadata[attr_medium]'], 'cpc');
  assert.equal(form['metadata[attr_campaign]'], 'first10');
  assert.equal(form['metadata[attr_content]'], 'ad-1');
  assert.equal(form['metadata[attr_term]'], 'teleprompter');
  assert.equal(form['metadata[attr_referrer]'], 'reddit.com');
  assert.equal(form['metadata[attr_landing]'], '/pricing');
  assert.equal(form['metadata[attr_timestamp]'], '2026-11-27T13:00:00.000Z');
  assert.ok(!form['metadata[attr_utm_source]']);

  stripeCalls = [];
  const dropped = sanitizeAttribution({
    utm_source: 'google ads',
    utm_medium: 'cpc+foo',
    utm_campaign: 'ok_campaign',
    utm_content: 'foo@bar',
    utm_term: 'a?b',
  });
  assert.deepEqual(dropped, { campaign: 'ok_campaign' });
});

test('customer_email is sent only when the server already has one', async () => {
  const kv = memoryKv();
  const hex = '11'.repeat(16);
  await kv.put('sub:' + hex, JSON.stringify({ status: 'active', email: 'known@example.com', provider: 'stripe' }));
  let r = await worker.fetch(
    new Request('https://x.test/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://clickprompt.app' },
      body: JSON.stringify({
        plan: 'monthly',
        origin: 'https://clickprompt.app',
        token: 'sub:' + hex,
        email: 'client@example.com',
      }),
    }),
    { ...stripeEnv, KV: kv },
    { waitUntil() {} }
  );
  assert.equal(r.status, 200);
  assert.equal(parseForm(stripeCalls[0].body).customer_email, 'known@example.com');

  stripeCalls = [];
  r = await worker.fetch(
    new Request('https://x.test/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://clickprompt.app' },
      body: JSON.stringify({
        plan: 'monthly',
        origin: 'https://clickprompt.app',
        email: 'client@example.com',
      }),
    }),
    stripeEnv,
    { waitUntil() {} }
  );
  assert.equal(r.status, 200);
  assert.equal(parseForm(stripeCalls[0].body).customer_email, undefined);
});

test('STRIPE_SECRET_KEY with zero-width characters is refused and live-key warning omits the value', async () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  try {
    assert.throws(
      () => assertStripeTestMode({ STRIPE_SECRET_KEY: 'sk_test_abc\u200B' }),
      (e) => e.status === 503 && /not configured/.test(e.message)
    );
    assert.throws(
      () => assertStripeTestMode({ STRIPE_SECRET_KEY: 'sk_live_abc' }),
      (e) => e.status === 503 && /STRIPE_ALLOW_LIVE=true/.test(e.message)
    );
  } finally {
    console.warn = orig;
  }
  assert.equal(assertStripeTestMode({ STRIPE_SECRET_KEY: '  sk_test_abc  ' }), 'sk_test_abc');
  assert.ok(warnings.some((args) => args[0] === 'stripe secret key refused'));
  assert.ok(warnings.some((args) => args[0] === 'stripe live key refused'));
  assert.ok(warnings.every((args) => args.length === 1 && !String(args[0]).includes('sk_') && !String(args[0]).includes('abc')));
  const r = await checkout({ ...stripeEnv, STRIPE_SECRET_KEY: 'sk_test_abc\u200D' }, 'monthly');
  assert.equal(r.status, 503);
  assert.deepEqual(stripeCalls, []);
});

test('partial refund keeps access; full refund and refund.created behave correctly', async () => {
  const kv = memoryKv();
  const hex = 'c0'.repeat(16);
  const token = 'sub:' + hex;
  const env = { ...stripeEnv, KV: kv };
  let r = await signedWebhook(env, {
    id: 'evt_partial_grant',
    type: 'checkout.session.completed',
    livemode: false,
    created: 10_000,
    data: {
      object: {
        id: 'cs_partial',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_partial',
        metadata: { unlock_token: token, plan: 'lifetime' },
        line_items: catalogLineItems('lifetime'),
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'lifetime');

  r = await signedWebhook(env, {
    id: 'evt_partial_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 10_001,
    data: {
      object: {
        id: 'ch_partial',
        object: 'charge',
        payment_intent: 'pi_partial',
        refunded: false,
        amount: 5900,
        amount_refunded: 1000,
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'lifetime');

  r = await signedWebhook(env, {
    id: 'evt_refund_created_only',
    type: 'refund.created',
    livemode: false,
    created: 10_002,
    data: {
      object: {
        id: 're_partial',
        object: 'refund',
        payment_intent: 'pi_partial',
        charge: 'ch_partial',
        amount: 5900,
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'lifetime');

  r = await signedWebhook(env, {
    id: 'evt_full_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 10_003,
    data: {
      object: {
        id: 'ch_partial',
        object: 'charge',
        payment_intent: 'pi_partial',
        refunded: false,
        amount: 5900,
        amount_refunded: 5900,
      },
    },
  });
  assert.equal(r.status, 200);
  const rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
  assert.equal(rec.revoke_reason, 'refund');
});

test('charge.dispute.created revokes Pro; won dispute restores it', async () => {
  const kv = memoryKv();
  const hex = 'c1'.repeat(16);
  const token = 'sub:' + hex;
  const env = { ...stripeEnv, KV: kv };
  let r = await signedWebhook(env, {
    id: 'evt_dp_grant',
    type: 'checkout.session.completed',
    livemode: false,
    created: 11_000,
    data: {
      object: {
        id: 'cs_dp',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_dp',
        metadata: { unlock_token: token, plan: 'lifetime' },
        line_items: catalogLineItems('lifetime'),
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'lifetime');

  r = await signedWebhook(env, {
    id: 'evt_dp_created',
    type: 'charge.dispute.created',
    livemode: false,
    created: 11_001,
    data: {
      object: {
        id: 'dp_one',
        object: 'dispute',
        payment_intent: 'pi_dp',
        charge: 'ch_dp',
        status: 'needs_response',
      },
    },
  });
  assert.equal(r.status, 200);
  let rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
  assert.equal(rec.revoke_reason, 'dispute');
  assert.equal(rec.revoke_dispute_id, 'dp_one');

  r = await signedWebhook(env, {
    id: 'evt_dp_other_won',
    type: 'charge.dispute.closed',
    livemode: false,
    created: 11_002,
    data: {
      object: {
        id: 'dp_other',
        object: 'dispute',
        payment_intent: 'pi_dp',
        status: 'won',
      },
    },
  });
  assert.equal(r.status, 200);
  rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');

  r = await signedWebhook(env, {
    id: 'evt_dp_won',
    type: 'charge.dispute.closed',
    livemode: false,
    created: 11_003,
    data: {
      object: {
        id: 'dp_one',
        object: 'dispute',
        payment_intent: 'pi_dp',
        status: 'won',
      },
    },
  });
  assert.equal(r.status, 200);
  rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'lifetime');
  assert.equal(rec.revoke_reason, null);
});

test('customer.subscription.updated does not restore a terminal revoke or deleted subscription', async () => {
  const kv = memoryKv();
  const hex = 'c2'.repeat(16);
  const token = 'sub:' + hex;
  const env = { ...stripeEnv, KV: kv };
  let r = await signedWebhook(env, {
    id: 'evt_term_active',
    type: 'customer.subscription.updated',
    livemode: false,
    created: 12_000,
    data: {
      object: {
        id: 'sub_term_1',
        status: 'active',
        cancel_at_period_end: false,
        metadata: { unlock_token: token, plan: 'monthly' },
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'active');

  r = await signedWebhook(env, {
    id: 'evt_term_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 12_001,
    data: {
      object: {
        id: 'ch_term',
        object: 'charge',
        subscription: 'sub_term_1',
        refunded: true,
        amount: 399,
        amount_refunded: 399,
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'refunded');

  r = await signedWebhook(env, {
    id: 'evt_term_later_active',
    type: 'customer.subscription.updated',
    livemode: false,
    created: 12_500,
    data: {
      object: {
        id: 'sub_term_1',
        status: 'active',
        cancel_at_period_end: false,
        metadata: { unlock_token: token, plan: 'monthly' },
      },
    },
  });
  assert.equal(r.status, 200);
  let rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
  assert.equal(rec.revoke_reason, 'refund');

  const hex2 = 'c3'.repeat(16);
  const token2 = 'sub:' + hex2;
  r = await signedWebhook(env, {
    id: 'evt_term_del_active',
    type: 'customer.subscription.updated',
    livemode: false,
    created: 13_000,
    data: {
      object: {
        id: 'sub_term_2',
        status: 'active',
        metadata: { unlock_token: token2, plan: 'monthly' },
      },
    },
  });
  assert.equal(r.status, 200);
  r = await signedWebhook(env, {
    id: 'evt_term_deleted',
    type: 'customer.subscription.deleted',
    livemode: false,
    created: 13_001,
    data: {
      object: {
        id: 'sub_term_2',
        status: 'canceled',
        metadata: { unlock_token: token2, plan: 'monthly' },
      },
    },
  });
  assert.equal(r.status, 200);
  rec = await kv.get('sub:' + hex2, 'json');
  assert.equal(rec.subscription_deleted, true);

  r = await signedWebhook(env, {
    id: 'evt_term_del_restore',
    type: 'customer.subscription.updated',
    livemode: false,
    created: 13_500,
    data: {
      object: {
        id: 'sub_term_2',
        status: 'active',
        cancel_at_period_end: false,
        metadata: { unlock_token: token2, plan: 'monthly' },
      },
    },
  });
  assert.equal(r.status, 200);
  rec = await kv.get('sub:' + hex2, 'json');
  assert.notEqual(rec.status, 'active');
  assert.equal(rec.subscription_deleted, true);

  r = await signedWebhook(env, {
    id: 'evt_term_new_sub',
    type: 'customer.subscription.updated',
    livemode: false,
    created: 12_600,
    data: {
      object: {
        id: 'sub_term_new',
        status: 'active',
        cancel_at_period_end: false,
        metadata: { unlock_token: token, plan: 'monthly' },
      },
    },
  });
  assert.equal(r.status, 200);
  rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
  assert.notEqual(rec.stripe_subscription_id, 'sub_term_new');
  assert.equal(await kv.get('stripesub:sub_term_new'), null);
});

test('tied event.created lets a revoke win; signed events missing created are rejected', async () => {
  const kv = memoryKv();
  const hex = 'c4'.repeat(16);
  const token = 'sub:' + hex;
  const env = { ...stripeEnv, KV: kv };
  let r = await signedWebhook(env, {
    id: 'evt_tie_cancel',
    type: 'customer.subscription.updated',
    livemode: false,
    created: 14_000,
    data: {
      object: {
        id: 'sub_tie',
        status: 'active',
        cancel_at_period_end: true,
        metadata: { unlock_token: token, plan: 'monthly' },
      },
    },
  });
  assert.equal(r.status, 200);
  let rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'cancelled');
  assert.equal(rec.cancel_pending, true);
  assert.equal(rec.last_event_created, 14_000);

  r = await signedWebhook(env, {
    id: 'evt_tie_clear',
    type: 'customer.subscription.updated',
    livemode: false,
    created: 14_000,
    data: {
      object: {
        id: 'sub_tie',
        status: 'active',
        cancel_at_period_end: false,
        metadata: { unlock_token: token, plan: 'monthly' },
      },
    },
  });
  assert.equal(r.status, 200);
  rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'cancelled');
  assert.equal(rec.cancel_pending, true);

  const missing = {
    id: 'evt_missing_created',
    type: 'customer.subscription.updated',
    livemode: false,
    data: {
      object: {
        id: 'sub_tie',
        status: 'active',
        cancel_at_period_end: false,
        metadata: { unlock_token: token, plan: 'monthly' },
      },
    },
  };
  r = await signedWebhook(env, missing);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /created/i);
  assert.equal(await kv.get('stripe:evt:evt_missing_created'), null);
  rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'cancelled');
});

test('revoke does not use customer id when two lifetime purchases share a customer', async () => {
  const kv = memoryKv();
  const hexA = 'c5'.repeat(16);
  const hexB = 'c6'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  let r = await signedWebhook(env, {
    id: 'evt_two_a',
    type: 'checkout.session.completed',
    livemode: false,
    created: 15_000,
    data: {
      object: {
        id: 'cs_two_a',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_two_a',
        customer: 'cus_shared',
        metadata: { unlock_token: 'sub:' + hexA, plan: 'lifetime' },
        line_items: catalogLineItems('lifetime'),
      },
    },
  });
  assert.equal(r.status, 200);
  r = await signedWebhook(env, {
    id: 'evt_two_b',
    type: 'checkout.session.completed',
    livemode: false,
    created: 15_001,
    data: {
      object: {
        id: 'cs_two_b',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_two_b',
        customer: 'cus_shared',
        metadata: { unlock_token: 'sub:' + hexB, plan: 'lifetime' },
        line_items: catalogLineItems('lifetime'),
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hexA, 'json')).status, 'lifetime');
  assert.equal((await kv.get('sub:' + hexB, 'json')).status, 'lifetime');
  assert.equal(await kv.get('stripecust:cus_shared'), hexB);

  r = await signedWebhook(env, {
    id: 'evt_two_refund_a',
    type: 'charge.refunded',
    livemode: false,
    created: 15_002,
    data: {
      object: {
        id: 'ch_two_a',
        object: 'charge',
        payment_intent: 'pi_two_a',
        customer: 'cus_shared',
        refunded: true,
        amount: 5900,
        amount_refunded: 5900,
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hexA, 'json')).status, 'refunded');
  assert.equal((await kv.get('sub:' + hexB, 'json')).status, 'lifetime');

  r = await signedWebhook(env, {
    id: 'evt_two_customer_only',
    type: 'charge.refunded',
    livemode: false,
    created: 15_003,
    data: {
      object: {
        id: 'ch_unknown',
        object: 'charge',
        customer: 'cus_shared',
        refunded: true,
        amount: 5900,
        amount_refunded: 5900,
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hexB, 'json')).status, 'lifetime');
});

test('unknown or mismatched line-item price does not grant Pro', async () => {
  const kv = memoryKv();
  const hex = 'c7'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  let r = await signedWebhook(env, {
    id: 'evt_price_mismatch',
    type: 'checkout.session.completed',
    livemode: false,
    created: 16_000,
    data: {
      object: {
        id: 'cs_price_bad',
        mode: 'subscription',
        payment_status: 'paid',
        metadata: { unlock_token: 'sub:' + hex, plan: 'monthly' },
        line_items: { data: [{ quantity: 1, currency: 'usd', price: { id: 'price_unknown', currency: 'usd' } }] },
        subscription: 'sub_price_bad',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + hex, 'json'), null);

  const hex2 = 'c8'.repeat(16);
  stripeSessionExpands.cs_price_expand = {
    id: 'cs_price_expand',
    line_items: catalogLineItems('monthly'),
  };
  r = await signedWebhook(env, {
    id: 'evt_price_expand',
    type: 'checkout.session.completed',
    livemode: false,
    created: 16_001,
    data: {
      object: {
        id: 'cs_price_expand',
        mode: 'subscription',
        payment_status: 'paid',
        metadata: { unlock_token: 'sub:' + hex2, plan: 'monthly' },
        subscription: 'sub_price_expand',
      },
    },
  });
  assert.equal(r.status, 200);
  const rec = await kv.get('sub:' + hex2, 'json');
  assert.equal(rec.status, 'active');
  assert.ok(stripeCalls.some((c) => String(c.url).includes('/checkout/sessions/cs_price_expand') && String(c.url).includes('expand')));
});

test('sk_test_ and rk_test_ are test keys; anything else fails closed', async () => {
  assert.equal(assertStripeTestMode({ STRIPE_SECRET_KEY: 'rk_test_abc' }), 'rk_test_abc');
  assert.equal(
    assertStripeTestMode({ STRIPE_SECRET_KEY: 'rk_live_abc', STRIPE_ALLOW_LIVE: 'true' }),
    'rk_live_abc'
  );
  assert.throws(
    () => assertStripeTestMode({ STRIPE_SECRET_KEY: 'pk_test_abc' }),
    (e) => e.status === 503 && /not configured/.test(e.message) && !/pk_test_/.test(e.message)
  );
  assert.throws(
    () => assertStripeTestMode({ STRIPE_SECRET_KEY: 'not_a_stripe_key' }),
    (e) => e.status === 503
  );
  const r = await checkout({ ...stripeEnv, STRIPE_SECRET_KEY: 'rk_test_abc' }, 'monthly');
  assert.equal(r.status, 200);
  assert.equal(stripeCalls[0].headers.Authorization, 'Bearer rk_test_abc');
});

test('zero-width webhook secrets are refused and the 503 names STRIPE_WEBHOOK_SECRET', async () => {
  const kv = memoryKv();
  const raw = JSON.stringify({
    id: 'evt_zw_secret',
    type: 'checkout.session.completed',
    livemode: false,
    created: 1,
    data: { object: {} },
  });
  const r = await worker.fetch(
    new Request('https://x.test/api/stripe-webhook', {
      method: 'POST',
      headers: { 'Stripe-Signature': 't=1,v1=ab', 'Content-Type': 'application/json' },
      body: raw,
    }),
    { ...stripeEnv, STRIPE_WEBHOOK_SECRET: 'whsec_test_secret\u200B', KV: kv },
    { waitUntil() {} }
  );
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.match(body.error, /STRIPE_WEBHOOK_SECRET/);
  assert.doesNotMatch(body.error, /whsec_/);
  assert.equal(await kv.get('stripe:evt:evt_zw_secret'), null);
});

test('webhook bodies over 1 MB are rejected even without Content-Length', async () => {
  const body = '{"id":"evt_huge","pad":"' + 'a'.repeat(1048576) + '"}';
  const r = await worker.fetch(
    new Request('https://x.test/api/stripe-webhook', {
      method: 'POST',
      headers: { 'Stripe-Signature': 't=1,v1=ab', 'Content-Type': 'application/json' },
      body,
    }),
    { ...stripeEnv, KV: memoryKv() },
    { waitUntil() {} }
  );
  assert.equal(r.status, 413);
});

test('expand fetch failure returns 5xx without a dedupe key; a retry then grants', async () => {
  const kv = memoryKv();
  const hex = 'c9'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  const event = {
    id: 'evt_expand_retry',
    type: 'checkout.session.completed',
    livemode: false,
    created: 17_000,
    data: {
      object: {
        id: 'cs_expand_retry',
        mode: 'subscription',
        payment_status: 'paid',
        metadata: { unlock_token: 'sub:' + hex, plan: 'monthly' },
        subscription: 'sub_expand_retry',
      },
    },
  };

  stripeSessionExpandErrors.cs_expand_retry = new Error('network down');
  let r = await signedWebhook(env, event);
  assert.equal(r.status, 500);
  const body = await r.json();
  assert.match(body.error, /Try again/);
  assert.equal(await kv.get('stripe:evt:evt_expand_retry'), null);
  assert.equal(await kv.get('sub:' + hex, 'json'), null);

  delete stripeSessionExpandErrors.cs_expand_retry;
  stripeSessionExpands.cs_expand_retry = {
    id: 'cs_expand_retry',
    line_items: catalogLineItems('monthly'),
  };
  r = await signedWebhook(env, event);
  assert.equal(r.status, 200);
  const rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'active');
  assert.ok(await kv.get('stripe:evt:evt_expand_retry'));
});

test('refund carrying only an invoice id revokes the matching purchase', async () => {
  const kv = memoryKv();
  const hex = 'ca'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  let r = await signedWebhook(env, {
    id: 'evt_inv_grant',
    type: 'checkout.session.completed',
    livemode: false,
    created: 18_000,
    data: {
      object: {
        id: 'cs_inv_only',
        mode: 'payment',
        payment_status: 'paid',
        invoice: 'in_only',
        metadata: { unlock_token: 'sub:' + hex, plan: 'lifetime' },
        line_items: catalogLineItems('lifetime'),
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'lifetime');
  assert.equal(await kv.get('stripeinv:in_only'), hex);

  r = await signedWebhook(env, {
    id: 'evt_inv_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 18_001,
    data: {
      object: {
        id: 'ch_unmapped',
        object: 'charge',
        invoice: 'in_only',
        refunded: true,
        amount: 5900,
        amount_refunded: 5900,
      },
    },
  });
  assert.equal(r.status, 200);
  const rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
  assert.equal(rec.revoke_reason, 'refund');
});

test('unbound subscription.updated cannot restore a refunded record; a new paid checkout can', async () => {
  const kv = memoryKv();
  const subHex = 'cb'.repeat(16);
  const lifeHex = 'cc'.repeat(16);
  const env = { ...stripeEnv, KV: kv };

  let r = await signedWebhook(env, {
    id: 'evt_paid_sub_grant',
    type: 'checkout.session.completed',
    livemode: false,
    created: 19_000,
    data: {
      object: {
        id: 'cs_paid_sub',
        mode: 'subscription',
        payment_status: 'paid',
        payment_intent: 'pi_paid_sub',
        subscription: 'sub_paid_old',
        metadata: { unlock_token: 'sub:' + subHex, plan: 'monthly' },
        line_items: catalogLineItems('monthly'),
      },
    },
  });
  assert.equal(r.status, 200);
  r = await signedWebhook(env, {
    id: 'evt_paid_sub_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 19_001,
    data: {
      object: {
        id: 'ch_paid_sub',
        object: 'charge',
        payment_intent: 'pi_paid_sub',
        subscription: 'sub_paid_old',
        refunded: true,
        amount: 399,
        amount_refunded: 399,
        currency: 'usd',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + subHex, 'json')).status, 'refunded');

  r = await signedWebhook(env, {
    id: 'evt_paid_sub_unbound',
    type: 'customer.subscription.updated',
    livemode: false,
    created: 19_100,
    data: {
      object: {
        id: 'sub_paid_unbound',
        status: 'active',
        cancel_at_period_end: false,
        metadata: { unlock_token: 'sub:' + subHex, plan: 'monthly' },
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + subHex, 'json')).status, 'refunded');
  assert.equal(await kv.get('stripesub:sub_paid_unbound'), null);

  r = await signedWebhook(env, {
    id: 'evt_paid_sub_new_checkout',
    type: 'checkout.session.completed',
    livemode: false,
    created: 19_200,
    data: {
      object: {
        id: 'cs_paid_sub_new',
        mode: 'subscription',
        payment_status: 'paid',
        payment_intent: 'pi_paid_sub_new',
        subscription: 'sub_paid_new',
        metadata: { unlock_token: 'sub:' + subHex, plan: 'monthly' },
        line_items: catalogLineItems('monthly'),
      },
    },
  });
  assert.equal(r.status, 200);
  let rec = await kv.get('sub:' + subHex, 'json');
  assert.equal(rec.status, 'active');
  assert.equal(rec.stripe_subscription_id, 'sub_paid_new');
  assert.equal(await kv.get('stripesub:sub_paid_new'), subHex);

  r = await signedWebhook(env, {
    id: 'evt_paid_life_grant',
    type: 'checkout.session.completed',
    livemode: false,
    created: 19_300,
    data: {
      object: {
        id: 'cs_paid_life',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_paid_life',
        metadata: { unlock_token: 'sub:' + lifeHex, plan: 'lifetime' },
        line_items: catalogLineItems('lifetime'),
      },
    },
  });
  assert.equal(r.status, 200);
  r = await signedWebhook(env, {
    id: 'evt_paid_life_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 19_301,
    data: {
      object: {
        id: 'ch_paid_life',
        object: 'charge',
        payment_intent: 'pi_paid_life',
        refunded: true,
        amount: 5900,
        amount_refunded: 5900,
        currency: 'usd',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + lifeHex, 'json')).status, 'refunded');

  r = await signedWebhook(env, {
    id: 'evt_paid_life_unbound',
    type: 'customer.subscription.updated',
    livemode: false,
    created: 19_400,
    data: {
      object: {
        id: 'sub_life_unbound',
        status: 'active',
        metadata: { unlock_token: 'sub:' + lifeHex, plan: 'monthly' },
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + lifeHex, 'json')).status, 'refunded');
  assert.equal(await kv.get('stripesub:sub_life_unbound'), null);

  r = await signedWebhook(env, {
    id: 'evt_paid_life_new_checkout',
    type: 'checkout.session.completed',
    livemode: false,
    created: 19_500,
    data: {
      object: {
        id: 'cs_paid_life_new',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_paid_life_new',
        metadata: { unlock_token: 'sub:' + lifeHex, plan: 'lifetime' },
        line_items: catalogLineItems('lifetime'),
      },
    },
  });
  assert.equal(r.status, 200);
  rec = await kv.get('sub:' + lifeHex, 'json');
  assert.equal(rec.status, 'lifetime');
  const meRes = await me(env, 'sub:' + lifeHex);
  assert.equal((await meRes.json()).unlocked, true);
});

test('a long open dispute does not start hard deletion, and a later win restores', async () => {
  const kv = memoryKv();
  const hex = 'cd'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  let r = await signedWebhook(env, {
    id: 'evt_long_dp_grant',
    type: 'checkout.session.completed',
    livemode: false,
    created: 20_000,
    data: {
      object: {
        id: 'cs_long_dp',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_long_dp',
        metadata: { unlock_token: 'sub:' + hex, plan: 'lifetime' },
        line_items: catalogLineItems('lifetime'),
      },
    },
  });
  assert.equal(r.status, 200);

  r = await signedWebhook(env, {
    id: 'evt_long_dp_created',
    type: 'charge.dispute.created',
    livemode: false,
    created: 20_001,
    data: {
      object: {
        id: 'dp_long',
        object: 'dispute',
        payment_intent: 'pi_long_dp',
        charge: 'ch_long_dp',
        status: 'needs_response',
      },
    },
  });
  assert.equal(r.status, 200);
  let rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
  assert.equal(rec.revoke_reason, 'dispute');
  assert.equal(rec.delete_at, null);
  rec.updated_at = Date.now() - 20 * 86400 * 1000;
  await kv.put('sub:' + hex, JSON.stringify(rec));

  r = await signedWebhook(env, {
    id: 'evt_long_dp_won',
    type: 'charge.dispute.closed',
    livemode: false,
    created: 20_500,
    data: {
      object: {
        id: 'dp_long',
        object: 'dispute',
        payment_intent: 'pi_long_dp',
        charge: 'ch_long_dp',
        status: 'won',
      },
    },
  });
  assert.equal(r.status, 200);
  rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'lifetime');
  assert.equal(rec.delete_at, null);
  const meRes = await me(env, 'sub:' + hex);
  assert.equal((await meRes.json()).unlocked, true);
});

test('full refund before checkout leaves /api/me locked', async () => {
  const kv = memoryKv();
  const hex = 'ce'.repeat(16);
  const token = 'sub:' + hex;
  const env = { ...stripeEnv, KV: kv };
  let r = await signedWebhook(env, {
    id: 'evt_early_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 300,
    data: {
      object: {
        id: 'ch_early',
        object: 'charge',
        payment_intent: 'pi_early',
        refunded: true,
        amount: 399,
        amount_refunded: 399,
        currency: 'usd',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.ok(await kv.get('stripe:refunded:pi_early'));
  assert.ok(await kv.get('stripe:refunded:ch_early'));

  r = await signedWebhook(env, {
    id: 'evt_late_grant',
    type: 'checkout.session.completed',
    livemode: false,
    created: 100,
    data: {
      object: {
        id: 'cs_early_refund',
        mode: 'subscription',
        payment_status: 'paid',
        payment_intent: 'pi_early',
        subscription: 'sub_early',
        metadata: { unlock_token: token, plan: 'monthly' },
        line_items: catalogLineItems('monthly'),
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + hex, 'json'), null);
  const meRes = await me(env, token);
  const body = await meRes.json();
  assert.equal(meRes.status, 200);
  assert.equal(body.unlocked, false);
});

test('older dispute.created is ignored after a newer won close', async () => {
  const kv = memoryKv();
  const hex = 'cf'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  let r = await signedWebhook(env, {
    id: 'evt_order_dp_grant',
    type: 'checkout.session.completed',
    livemode: false,
    created: 21_000,
    data: {
      object: {
        id: 'cs_order_dp',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_order_dp',
        metadata: { unlock_token: 'sub:' + hex, plan: 'lifetime' },
        line_items: catalogLineItems('lifetime'),
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'lifetime');

  r = await signedWebhook(env, {
    id: 'evt_order_dp_won',
    type: 'charge.dispute.closed',
    livemode: false,
    created: 200,
    data: {
      object: {
        id: 'dp_order',
        object: 'dispute',
        payment_intent: 'pi_order_dp',
        charge: 'ch_order_dp',
        status: 'won',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'lifetime');

  r = await signedWebhook(env, {
    id: 'evt_order_dp_created',
    type: 'charge.dispute.created',
    livemode: false,
    created: 100,
    data: {
      object: {
        id: 'dp_order',
        object: 'dispute',
        payment_intent: 'pi_order_dp',
        charge: 'ch_order_dp',
        status: 'needs_response',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'lifetime');
  const meRes = await me(env, 'sub:' + hex);
  assert.equal((await meRes.json()).unlocked, true);
});

test('refunded:true with a smaller amount_refunded does not revoke', async () => {
  const kv = memoryKv();
  const hex = 'd0'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  let r = await signedWebhook(env, {
    id: 'evt_flag_grant',
    type: 'checkout.session.completed',
    livemode: false,
    created: 22_000,
    data: {
      object: {
        id: 'cs_flag',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_flag',
        metadata: { unlock_token: 'sub:' + hex, plan: 'lifetime' },
        line_items: catalogLineItems('lifetime'),
      },
    },
  });
  assert.equal(r.status, 200);
  r = await signedWebhook(env, {
    id: 'evt_flag_partial',
    type: 'charge.refunded',
    livemode: false,
    created: 22_001,
    data: {
      object: {
        id: 'ch_flag',
        object: 'charge',
        payment_intent: 'pi_flag',
        refunded: true,
        amount: 5900,
        amount_refunded: 1000,
        currency: 'usd',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'lifetime');
});

test('configured amount_total must match before a grant', async () => {
  const kv = memoryKv();
  const hex = 'd1'.repeat(16);
  const env = { ...stripeEnv, KV: kv, STRIPE_PRICE_AMOUNT_MONTHLY: '399' };
  const items = catalogLineItems('monthly');
  items.data[0].amount_total = 100;
  items.data[0].price.unit_amount = 100;
  let r = await signedWebhook(env, {
    id: 'evt_amount_mismatch',
    type: 'checkout.session.completed',
    livemode: false,
    created: 23_000,
    data: {
      object: {
        id: 'cs_amount_bad',
        mode: 'subscription',
        payment_status: 'paid',
        amount_total: 100,
        metadata: { unlock_token: 'sub:' + hex, plan: 'monthly' },
        line_items: items,
        subscription: 'sub_amount_bad',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + hex, 'json'), null);

  const hex2 = 'd2'.repeat(16);
  r = await signedWebhook(env, {
    id: 'evt_amount_ok',
    type: 'checkout.session.completed',
    livemode: false,
    created: 23_001,
    data: {
      object: {
        id: 'cs_amount_ok',
        mode: 'subscription',
        payment_status: 'paid',
        amount_total: 399,
        metadata: { unlock_token: 'sub:' + hex2, plan: 'monthly' },
        line_items: catalogLineItems('monthly'),
        subscription: 'sub_amount_ok',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex2, 'json')).status, 'active');
});
