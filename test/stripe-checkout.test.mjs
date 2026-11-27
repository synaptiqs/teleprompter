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
  assert.equal(form['metadata[attr_referrer]'], 'reddit.com');
  assert.equal(form['metadata[attr_landing]'], '/');
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
        metadata: { unlock_token: token, plan: 'monthly' },
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
        metadata: { unlock_token: token, plan: 'monthly' },
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
        metadata: { unlock_token: token, plan: 'monthly' },
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
        metadata: { unlock_token: token2, plan: 'monthly' },
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
        metadata: { unlock_token: token2, plan: 'monthly' },
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
        metadata: { unlock_token: token, plan: 'monthly' },
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
        metadata: { unlock_token: subToken, plan: 'lifetime' },
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
        metadata: { unlock_token: token, plan: 'lifetime' },
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
        metadata: { unlock_token: 'sub:' + hex, plan: 'monthly' },
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
    data: { object: { id: 'cs_x', mode: 'subscription', payment_status: 'paid', metadata: { unlock_token: 'sub:' + 'ae'.repeat(16), plan: 'monthly' } } },
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

  const raw = JSON.stringify({
    id: 'evt_prev',
    type: 'ping',
    livemode: false,
    data: { object: {} },
  });
  const ts = Math.floor(Date.now() / 1000);
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
