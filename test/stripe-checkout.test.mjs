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
let stripeInvoiceGets = {};
let stripeInvoiceGetErrors = {};
let stripeChargeGets = {};
let stripeChargeGetErrors = {};
let stripeSubscriptionGets = {};
let stripeSubscriptionGetErrors = {};

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
    const resourceGet = (kind, map, errMap) => {
      const m = href.match(new RegExp('^https://api\\.stripe\\.com/v1/' + kind + '/([^?]+)'));
      if (!m || (init && init.method && init.method !== 'GET')) return null;
      const id = decodeURIComponent(m[1]);
      if (errMap[id]) {
        const fail = errMap[id];
        if (typeof fail === 'function') return fail();
        if (fail instanceof Error) throw fail;
        return new Response(JSON.stringify({ error: { message: 'unavailable' } }), { status: Number(fail) || 500 });
      }
      if (map[id]) {
        return new Response(JSON.stringify(map[id]), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: 'missing' } }), { status: 404 });
    };
    const invoiceRes = resourceGet('invoices', stripeInvoiceGets, stripeInvoiceGetErrors);
    if (invoiceRes) return invoiceRes;
    const chargeRes = resourceGet('charges', stripeChargeGets, stripeChargeGetErrors);
    if (chargeRes) return chargeRes;
    const subRes = resourceGet('subscriptions', stripeSubscriptionGets, stripeSubscriptionGetErrors);
    if (subRes) return subRes;
    throw new Error('unexpected stripe ' + href);
  };
}

beforeEach(() => {
  stripeCalls = [];
  stripeSessionExpands = {};
  stripeSessionExpandErrors = {};
  stripeInvoiceGets = {};
  stripeInvoiceGetErrors = {};
  stripeChargeGets = {};
  stripeChargeGetErrors = {};
  stripeSubscriptionGets = {};
  stripeSubscriptionGetErrors = {};
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

async function paidMonthlyCheckout(env, opts) {
  const hex = opts.hex;
  return signedWebhook(env, {
    id: opts.eventId || ('evt_' + opts.sessionId),
    type: 'checkout.session.completed',
    livemode: false,
    created: opts.created,
    data: {
      object: {
        id: opts.sessionId,
        mode: 'subscription',
        payment_status: 'paid',
        payment_intent: opts.paymentIntent,
        invoice: opts.invoice,
        metadata: { unlock_token: 'sub:' + hex, plan: 'monthly' },
        line_items: catalogLineItems('monthly'),
        subscription: opts.subscription,
        latest_charge: opts.charge,
      },
    },
  });
}

function catalogItems(plan, { unitAmount, amountTotal } = {}) {
  const items = catalogLineItems(plan);
  if (unitAmount !== undefined) items.data[0].price.unit_amount = unitAmount;
  if (amountTotal !== undefined) items.data[0].amount_total = amountTotal;
  return items;
}

function subscriptionItems(plan, extras = {}) {
  const catalog = catalogLineItems(plan).data[0];
  return {
    data: [{
      quantity: extras.quantity != null ? extras.quantity : 1,
      current_period_end: extras.current_period_end,
      price: {
        id: catalog.price.id,
        currency: extras.currency || 'usd',
        unit_amount: extras.unitAmount != null ? extras.unitAmount : catalog.price.unit_amount,
      },
    }],
  };
}

function wirePaymentRefs({ invoice, charge, paymentIntent, subscription }) {
  if (invoice) {
    stripeInvoiceGets[invoice] = {
      id: invoice,
      object: 'invoice',
      payment_intent: paymentIntent,
      charge,
      subscription,
      livemode: false,
    };
  }
  if (charge) {
    stripeChargeGets[charge] = {
      id: charge,
      object: 'charge',
      payment_intent: paymentIntent,
      invoice,
      subscription,
      livemode: false,
    };
  }
}

async function subscriptionCheckoutInvoiceOnly(env, opts) {
  const hex = opts.hex;
  return signedWebhook(env, {
    id: opts.eventId || ('evt_' + opts.sessionId),
    type: 'checkout.session.completed',
    livemode: false,
    created: opts.created,
    data: {
      object: {
        id: opts.sessionId,
        mode: 'subscription',
        payment_status: 'paid',
        invoice: opts.invoice,
        metadata: { unlock_token: 'sub:' + hex, plan: 'monthly' },
        line_items: catalogLineItems('monthly'),
        subscription: opts.subscription,
      },
    },
  });
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
  const granted = await paidMonthlyCheckout(env, {
    hex,
    sessionId: 'cs_order_1',
    subscription: 'sub_order_1',
    created: 1_500,
  });
  assert.equal(granted.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'active');

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
    const first = await paidMonthlyCheckout(env, {
      hex: hexA,
      sessionId: 'cs_bound_1',
      subscription: 'sub_bound_1',
      created: 3_000,
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
  let r = await paidMonthlyCheckout(env, {
    hex,
    sessionId: 'cs_term_1',
    subscription: 'sub_term_1',
    paymentIntent: 'pi_term_1',
    created: 12_000,
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
  r = await paidMonthlyCheckout(env, {
    hex: hex2,
    sessionId: 'cs_term_2',
    subscription: 'sub_term_2',
    created: 13_000,
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
  let r = await paidMonthlyCheckout(env, {
    hex,
    sessionId: 'cs_tie',
    subscription: 'sub_tie',
    created: 13_900,
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'active');

  r = await signedWebhook(env, {
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
  // No payment_intent and no identity after a permanent charge
  // lookup miss: 5xx without dedupe. Customer id is still not
  // used to revoke the other purchase.
  assert.equal(r.status, 500);
  assert.equal(await kv.get('stripe:evt:evt_two_customer_only'), null);
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

test('configured unit_amount must match; amount_total may differ', async () => {
  const kv = memoryKv();
  const env = { ...stripeEnv, KV: kv, STRIPE_PRICE_AMOUNT_MONTHLY: '399' };

  // unit_amount 399 with a promo total of 50 must still grant.
  const hexPromo50 = 'd1'.repeat(16);
  let r = await signedWebhook(env, {
    id: 'evt_unit_ok_total_50',
    type: 'checkout.session.completed',
    livemode: false,
    created: 23_000,
    data: {
      object: {
        id: 'cs_unit_ok_total_50',
        mode: 'subscription',
        payment_status: 'paid',
        amount_total: 50,
        metadata: { unlock_token: 'sub:' + hexPromo50, plan: 'monthly' },
        line_items: catalogItems('monthly', { unitAmount: 399, amountTotal: 50 }),
        subscription: 'sub_unit_ok_total_50',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hexPromo50, 'json')).status, 'active');

  // unit_amount 50 is rejected even if the total is 50.
  const hexUnit50 = 'd2'.repeat(16);
  r = await signedWebhook(env, {
    id: 'evt_unit_50',
    type: 'checkout.session.completed',
    livemode: false,
    created: 23_001,
    data: {
      object: {
        id: 'cs_unit_50',
        mode: 'subscription',
        payment_status: 'paid',
        amount_total: 50,
        metadata: { unlock_token: 'sub:' + hexUnit50, plan: 'monthly' },
        line_items: catalogItems('monthly', { unitAmount: 50, amountTotal: 50 }),
        subscription: 'sub_unit_50',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + hexUnit50, 'json'), null);

  // Missing unit_amount is rejected when the env amount is set.
  const hexMissing = 'd3'.repeat(16);
  const missingItems = catalogLineItems('monthly');
  delete missingItems.data[0].price.unit_amount;
  r = await signedWebhook(env, {
    id: 'evt_unit_missing',
    type: 'checkout.session.completed',
    livemode: false,
    created: 23_002,
    data: {
      object: {
        id: 'cs_unit_missing',
        mode: 'subscription',
        payment_status: 'paid',
        amount_total: 399,
        metadata: { unlock_token: 'sub:' + hexMissing, plan: 'monthly' },
        line_items: missingItems,
        subscription: 'sub_unit_missing',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + hexMissing, 'json'), null);

  // Promo total 299 with unit 399 grants.
  const hexPromo = 'd4'.repeat(16);
  r = await signedWebhook(env, {
    id: 'evt_promo_299',
    type: 'checkout.session.completed',
    livemode: false,
    created: 23_003,
    data: {
      object: {
        id: 'cs_promo_299',
        mode: 'subscription',
        payment_status: 'paid',
        amount_total: 299,
        metadata: { unlock_token: 'sub:' + hexPromo, plan: 'monthly' },
        line_items: catalogItems('monthly', { unitAmount: 399, amountTotal: 299 }),
        subscription: 'sub_promo_299',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hexPromo, 'json')).status, 'active');

  // A string unit_amount is rejected even when it equals the catalog amount.
  const hexString = 'd6'.repeat(16);
  const stringItems = catalogItems('monthly', { unitAmount: 399, amountTotal: 399 });
  stringItems.data[0].price.unit_amount = '399';
  r = await signedWebhook(env, {
    id: 'evt_unit_string',
    type: 'checkout.session.completed',
    livemode: false,
    created: 23_005,
    data: {
      object: {
        id: 'cs_unit_string',
        mode: 'subscription',
        payment_status: 'paid',
        amount_total: 399,
        metadata: { unlock_token: 'sub:' + hexString, plan: 'monthly' },
        line_items: stringItems,
        subscription: 'sub_unit_string',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + hexString, 'json'), null);

  // Tax-inclusive total 430 with unit 399 grants.
  const hexTax = 'd5'.repeat(16);
  r = await signedWebhook(env, {
    id: 'evt_tax_430',
    type: 'checkout.session.completed',
    livemode: false,
    created: 23_004,
    data: {
      object: {
        id: 'cs_tax_430',
        mode: 'subscription',
        payment_status: 'paid',
        amount_total: 430,
        metadata: { unlock_token: 'sub:' + hexTax, plan: 'monthly' },
        line_items: catalogItems('monthly', { unitAmount: 399, amountTotal: 430 }),
        subscription: 'sub_tax_430',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hexTax, 'json')).status, 'active');
});

test('dispute before checkout stores a pending grant; won close applies it and never grants from a refund skip', async () => {
  const kv = memoryKv();
  const hex = 'e1'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  // Realistic non-overlapping ids: the dispute carries PI + charge
  // only, and the subscription checkout carries invoice + subscription
  // only. The canonical resolver fills the gaps from fixtures.
  wirePaymentRefs({
    invoice: 'in_before',
    charge: 'ch_before',
    paymentIntent: 'pi_before',
    subscription: 'sub_after_dp',
  });

  let r = await signedWebhook(env, {
    id: 'evt_dp_first',
    type: 'charge.dispute.created',
    livemode: false,
    created: 30_000,
    data: {
      object: {
        id: 'dp_before',
        object: 'dispute',
        payment_intent: 'pi_before',
        charge: 'ch_before',
        status: 'needs_response',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.ok(await kv.get('stripe:disputed:pi_before'));
  assert.ok(await kv.get('stripe:disputed:ch_before'));
  assert.ok(await kv.get('stripe:disputed:in_before'));

  r = await subscriptionCheckoutInvoiceOnly(env, {
    hex,
    sessionId: 'cs_after_dp',
    invoice: 'in_before',
    subscription: 'sub_after_dp',
    created: 30_001,
    eventId: 'evt_cs_after_dp',
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + hex, 'json'), null);
  assert.ok(await kv.get('stripe:evt:evt_cs_after_dp'));
  const pending = await kv.get('stripe:grant:pi_before', 'json');
  assert.equal(pending.hex, hex);
  assert.equal(pending.plan, 'monthly');
  assert.equal(pending.mode, 'subscription');
  assert.equal(pending.subscription, 'sub_after_dp');
  assert.equal(pending.session, 'cs_after_dp');
  assert.equal(pending.invoice, 'in_before');
  assert.equal(pending.charge, 'ch_before');
  assert.ok(!Object.prototype.hasOwnProperty.call(pending, 'email'));
  assert.equal((await me(env, 'sub:' + hex).then((res) => res.json())).unlocked, false);

  r = await subscriptionCheckoutInvoiceOnly(env, {
    hex,
    sessionId: 'cs_after_dp',
    invoice: 'in_before',
    subscription: 'sub_after_dp',
    created: 30_001,
    eventId: 'evt_cs_after_dp',
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + hex, 'json'), null);

  r = await signedWebhook(env, {
    id: 'evt_dp_won_deferred',
    type: 'charge.dispute.closed',
    livemode: false,
    created: 30_002,
    data: {
      object: {
        id: 'dp_before',
        object: 'dispute',
        payment_intent: 'pi_before',
        charge: 'ch_before',
        status: 'won',
      },
    },
  });
  assert.equal(r.status, 200);
  const rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'active');
  assert.equal(rec.stripe_subscription_id, 'sub_after_dp');
  assert.equal(rec.email, null);
  assert.equal((await me(env, 'sub:' + hex).then((res) => res.json())).unlocked, true);
  assert.equal(await kv.get('stripesub:sub_after_dp'), hex);
  assert.equal(await kv.get('stripepi:pi_before'), hex);
  assert.equal(await kv.get('stripeinv:in_before'), hex);

  const hexRefund = 'e2'.repeat(16);
  wirePaymentRefs({
    invoice: 'in_rf_first',
    charge: 'ch_rf_first',
    paymentIntent: 'pi_rf_first',
    subscription: 'sub_rf_first',
  });
  r = await signedWebhook(env, {
    id: 'evt_rf_first',
    type: 'charge.refunded',
    livemode: false,
    created: 30_100,
    data: {
      object: {
        id: 'ch_rf_first',
        object: 'charge',
        refunded: true,
        amount: 399,
        amount_refunded: 399,
        currency: 'usd',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.ok(await kv.get('stripe:refunded:pi_rf_first'));
  r = await subscriptionCheckoutInvoiceOnly(env, {
    hex: hexRefund,
    sessionId: 'cs_rf_first',
    invoice: 'in_rf_first',
    subscription: 'sub_rf_first',
    created: 30_101,
    eventId: 'evt_cs_rf_first',
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + hexRefund, 'json'), null);
  assert.equal(await kv.get('stripe:grant:pi_rf_first'), null);
  r = await signedWebhook(env, {
    id: 'evt_rf_won',
    type: 'charge.dispute.closed',
    livemode: false,
    created: 30_102,
    data: {
      object: {
        id: 'dp_rf_none',
        object: 'dispute',
        payment_intent: 'pi_rf_first',
        charge: 'ch_rf_first',
        status: 'won',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + hexRefund, 'json'), null);
});

test('expand 404 is a permanent miss; 429 and 5xx stay transient', async () => {
  const kv = memoryKv();
  const env = { ...stripeEnv, KV: kv };

  const permanent = {
    id: 'evt_expand_404',
    type: 'checkout.session.completed',
    livemode: false,
    created: 31_000,
    data: {
      object: {
        id: 'cs_expand_404',
        mode: 'subscription',
        payment_status: 'paid',
        metadata: { unlock_token: 'sub:' + 'e3'.repeat(16), plan: 'monthly' },
        subscription: 'sub_expand_404',
      },
    },
  };
  stripeSessionExpandErrors.cs_expand_404 = 404;
  let r = await signedWebhook(env, permanent);
  assert.equal(r.status, 200);
  assert.ok(await kv.get('stripe:evt:evt_expand_404'));
  assert.equal(await kv.get('sub:' + 'e3'.repeat(16), 'json'), null);

  const hex429 = 'e4'.repeat(16);
  const transient429 = {
    id: 'evt_expand_429',
    type: 'checkout.session.completed',
    livemode: false,
    created: 31_001,
    data: {
      object: {
        id: 'cs_expand_429',
        mode: 'subscription',
        payment_status: 'paid',
        metadata: { unlock_token: 'sub:' + hex429, plan: 'monthly' },
        subscription: 'sub_expand_429',
      },
    },
  };
  stripeSessionExpandErrors.cs_expand_429 = 429;
  r = await signedWebhook(env, transient429);
  assert.equal(r.status, 500);
  assert.equal(await kv.get('stripe:evt:evt_expand_429'), null);
  assert.equal(await kv.get('sub:' + hex429, 'json'), null);

  const hex500 = 'e5'.repeat(16);
  const transient500 = {
    id: 'evt_expand_500',
    type: 'checkout.session.completed',
    livemode: false,
    created: 31_002,
    data: {
      object: {
        id: 'cs_expand_500',
        mode: 'subscription',
        payment_status: 'paid',
        metadata: { unlock_token: 'sub:' + hex500, plan: 'monthly' },
        subscription: 'sub_expand_500',
      },
    },
  };
  stripeSessionExpandErrors.cs_expand_500 = 500;
  r = await signedWebhook(env, transient500);
  assert.equal(r.status, 500);
  assert.equal(await kv.get('stripe:evt:evt_expand_500'), null);
  assert.equal(await kv.get('sub:' + hex500, 'json'), null);
});

test('warning_closed restores Pro like a won dispute', async () => {
  const kv = memoryKv();
  const hex = 'e6'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  let r = await paidMonthlyCheckout(env, {
    hex,
    sessionId: 'cs_warn',
    subscription: 'sub_warn',
    paymentIntent: 'pi_warn',
    created: 32_000,
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'active');

  r = await signedWebhook(env, {
    id: 'evt_warn_open',
    type: 'charge.dispute.created',
    livemode: false,
    created: 32_001,
    data: {
      object: {
        id: 'dp_warn',
        object: 'dispute',
        payment_intent: 'pi_warn',
        status: 'warning_needs_response',
      },
    },
  });
  assert.equal(r.status, 200);
  let rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
  assert.equal(rec.revoke_reason, 'dispute');
  assert.equal(rec.delete_at, null);

  r = await signedWebhook(env, {
    id: 'evt_warn_closed',
    type: 'charge.dispute.closed',
    livemode: false,
    created: 32_002,
    data: {
      object: {
        id: 'dp_warn',
        object: 'dispute',
        payment_intent: 'pi_warn',
        status: 'warning_closed',
      },
    },
  });
  assert.equal(r.status, 200);
  rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'active');
  assert.equal(rec.revoke_reason, null);
  assert.equal((await me(env, 'sub:' + hex).then((res) => res.json())).unlocked, true);
});

test('unknown dispute close status starts the deletion clock and does not restore', async () => {
  const kv = memoryKv();
  const hex = 'e7'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  const logs = [];
  const orig = console.log;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  let r;
  try {
    r = await paidMonthlyCheckout(env, {
      hex,
      sessionId: 'cs_unknown_close',
      subscription: 'sub_unknown_close',
      paymentIntent: 'pi_unknown_close',
      created: 33_000,
    });
    assert.equal(r.status, 200);

    r = await signedWebhook(env, {
      id: 'evt_unknown_open',
      type: 'charge.dispute.created',
      livemode: false,
      created: 33_001,
      data: {
        object: {
          id: 'dp_unknown',
          object: 'dispute',
          payment_intent: 'pi_unknown_close',
          status: 'needs_response',
        },
      },
    });
    assert.equal(r.status, 200);

    r = await signedWebhook(env, {
      id: 'evt_unknown_closed',
      type: 'charge.dispute.closed',
      livemode: false,
      created: 33_002,
      data: {
        object: {
          id: 'dp_unknown',
          object: 'dispute',
          payment_intent: 'pi_unknown_close',
          status: 'something_else',
        },
      },
    });
    assert.equal(r.status, 200);
  } finally {
    console.log = orig;
  }
  const rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
  assert.ok(rec.delete_at);
  assert.equal(rec.cancel_pending, true);
  assert.equal((await me(env, 'sub:' + hex).then((res) => res.json())).unlocked, false);
  assert.ok(logs.some((line) => /unhandled status/.test(line) && /something_else/.test(line)));
});

test('invoice-only refund tombstones the invoice and a resolved payment_intent', async () => {
  const kv = memoryKv();
  const hex = 'e8'.repeat(16);
  const env = { ...stripeEnv, KV: kv };

  // Refund arrives first, carrying only an invoice id. The invoice
  // tombstone must block the later checkout even though the session
  // also has a payment_intent the refund never saw.
  let r = await signedWebhook(env, {
    id: 'evt_inv_only_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 34_000,
    data: {
      object: {
        id: 'ch_inv_only',
        object: 'charge',
        invoice: 'in_inv_only',
        refunded: true,
        amount: 399,
        amount_refunded: 399,
        currency: 'usd',
      },
    },
  });
  // Permanent 4xx left no payment_intent and no identity, so the
  // webhook is 5xx without a dedupe write. The invoice (and charge)
  // ids we already had are still tombstoned.
  assert.equal(r.status, 500);
  assert.equal(await kv.get('stripe:evt:evt_inv_only_refund'), null);
  assert.ok(await kv.get('stripe:refunded:in_inv_only'));
  assert.ok(await kv.get('stripe:refunded:ch_inv_only'));
  assert.equal(await kv.get('stripe:refunded:pi_inv_only'), null);

  r = await paidMonthlyCheckout(env, {
    hex,
    sessionId: 'cs_inv_only',
    subscription: 'sub_inv_only',
    paymentIntent: 'pi_inv_only',
    invoice: 'in_inv_only',
    created: 34_001,
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + hex, 'json'), null);
  assert.equal((await me(env, 'sub:' + hex).then((res) => res.json())).unlocked, false);

  // After a grant, an invoice-only refund can also resolve the PI
  // from the stripe:invpi map written at checkout time.
  const hex2 = 'e9'.repeat(16);
  r = await paidMonthlyCheckout(env, {
    hex: hex2,
    sessionId: 'cs_invpi',
    subscription: 'sub_invpi',
    paymentIntent: 'pi_invpi',
    invoice: 'in_invpi',
    created: 34_100,
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex2, 'json')).status, 'active');
  assert.equal(await kv.get('stripe:invpi:in_invpi'), 'pi_invpi');

  r = await signedWebhook(env, {
    id: 'evt_invpi_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 34_101,
    data: {
      object: {
        id: 'ch_invpi',
        object: 'charge',
        invoice: 'in_invpi',
        refunded: true,
        amount: 399,
        amount_refunded: 399,
        currency: 'usd',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.ok(await kv.get('stripe:refunded:in_invpi'));
  assert.ok(await kv.get('stripe:refunded:pi_invpi'));
  assert.equal((await kv.get('sub:' + hex2, 'json')).status, 'refunded');
});

test('subscription deleted before checkout writes a tombstone and skips the later grant', async () => {
  const kv = memoryKv();
  const hex = 'ea'.repeat(16);
  const env = { ...stripeEnv, KV: kv };

  const rDel = await signedWebhook(env, {
    id: 'evt_del_first',
    type: 'customer.subscription.deleted',
    livemode: false,
    created: 35_000,
    data: {
      object: {
        id: 'sub_del_first',
        status: 'canceled',
        // No unlock_token: the tombstone must still be written.
      },
    },
  });
  assert.equal(rDel.status, 200);
  assert.ok(await kv.get('stripe:deleted:sub_del_first'));
  assert.equal(await kv.get('sub:' + hex, 'json'), null);

  const rGrant = await paidMonthlyCheckout(env, {
    hex,
    sessionId: 'cs_del_first',
    subscription: 'sub_del_first',
    paymentIntent: 'pi_del_first',
    created: 35_001,
  });
  assert.equal(rGrant.status, 200);
  assert.equal(await kv.get('sub:' + hex, 'json'), null);
  assert.equal((await me(env, 'sub:' + hex).then((res) => res.json())).unlocked, false);
});

test('subscription.updated sent before checkout stays locked even with catalog items', async () => {
  const kv = memoryKv();
  const hex = 'eb'.repeat(16);
  const env = { ...stripeEnv, KV: kv, STRIPE_PRICE_AMOUNT_MONTHLY: '399' };

  const r = await signedWebhook(env, {
    id: 'evt_updated_first',
    type: 'customer.subscription.updated',
    livemode: false,
    created: 36_000,
    data: {
      object: {
        id: 'sub_updated_first',
        status: 'active',
        cancel_at_period_end: false,
        metadata: { unlock_token: 'sub:' + hex, plan: 'monthly' },
        items: subscriptionItems('monthly', { unitAmount: 399 }),
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + hex, 'json'), null);
  assert.equal(await kv.get('stripesub:sub_updated_first'), null);
  assert.equal((await me(env, 'sub:' + hex).then((res) => res.json())).unlocked, false);
});

test('full refund with no currency still revokes when amount fields are present', async () => {
  const kv = memoryKv();
  const hex = 'ec'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  let r = await paidMonthlyCheckout(env, {
    hex,
    sessionId: 'cs_no_cur',
    subscription: 'sub_no_cur',
    paymentIntent: 'pi_no_cur',
    created: 37_000,
  });
  assert.equal(r.status, 200);

  r = await signedWebhook(env, {
    id: 'evt_no_cur_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 37_001,
    data: {
      object: {
        id: 'ch_no_cur',
        object: 'charge',
        payment_intent: 'pi_no_cur',
        refunded: true,
        amount: 399,
        amount_refunded: 399,
      },
    },
  });
  assert.equal(r.status, 200);
  const rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
  assert.equal(rec.revoke_reason, 'refund');
});


test('dispute before a non-overlapping checkout then lost leaves Pro locked', async () => {
  const kv = memoryKv();
  const hex = 'f1'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  wirePaymentRefs({
    invoice: 'in_lost_first',
    charge: 'ch_lost_first',
    paymentIntent: 'pi_lost_first',
    subscription: 'sub_lost_first',
  });

  let r = await signedWebhook(env, {
    id: 'evt_lost_first_dp',
    type: 'charge.dispute.created',
    livemode: false,
    created: 40_000,
    data: {
      object: {
        id: 'dp_lost_first',
        object: 'dispute',
        payment_intent: 'pi_lost_first',
        charge: 'ch_lost_first',
        status: 'needs_response',
      },
    },
  });
  assert.equal(r.status, 200);

  r = await subscriptionCheckoutInvoiceOnly(env, {
    hex,
    sessionId: 'cs_lost_first',
    invoice: 'in_lost_first',
    subscription: 'sub_lost_first',
    created: 40_001,
    eventId: 'evt_cs_lost_first',
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + hex, 'json'), null);
  assert.ok(await kv.get('stripe:grant:pi_lost_first', 'json'));

  r = await signedWebhook(env, {
    id: 'evt_lost_first_close',
    type: 'charge.dispute.closed',
    livemode: false,
    created: 40_002,
    data: {
      object: {
        id: 'dp_lost_first',
        object: 'dispute',
        payment_intent: 'pi_lost_first',
        charge: 'ch_lost_first',
        status: 'lost',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + hex, 'json'), null);
  assert.equal((await me(env, 'sub:' + hex).then((res) => res.json())).unlocked, false);
});

test('paid invoice-only checkout then a PI-only dispute lost starts the deletion clock', async () => {
  const kv = memoryKv();
  const hex = 'f2'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  wirePaymentRefs({
    invoice: 'in_grant_then_lost',
    charge: 'ch_grant_then_lost',
    paymentIntent: 'pi_grant_then_lost',
    subscription: 'sub_grant_then_lost',
  });

  let r = await subscriptionCheckoutInvoiceOnly(env, {
    hex,
    sessionId: 'cs_grant_then_lost',
    invoice: 'in_grant_then_lost',
    subscription: 'sub_grant_then_lost',
    created: 41_000,
    eventId: 'evt_cs_grant_then_lost',
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'active');
  assert.equal(await kv.get('stripepi:pi_grant_then_lost'), hex);
  assert.equal(await kv.get('stripecharge:ch_grant_then_lost'), hex);
  assert.equal(await kv.get('stripeinv:in_grant_then_lost'), hex);

  r = await signedWebhook(env, {
    id: 'evt_dp_grant_then_lost',
    type: 'charge.dispute.created',
    livemode: false,
    created: 41_001,
    data: {
      object: {
        id: 'dp_grant_then_lost',
        object: 'dispute',
        payment_intent: 'pi_grant_then_lost',
        charge: 'ch_grant_then_lost',
        status: 'needs_response',
      },
    },
  });
  assert.equal(r.status, 200);
  let rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
  assert.equal(rec.revoke_reason, 'dispute');
  assert.equal(rec.delete_at, null);

  r = await signedWebhook(env, {
    id: 'evt_close_grant_then_lost',
    type: 'charge.dispute.closed',
    livemode: false,
    created: 41_002,
    data: {
      object: {
        id: 'dp_grant_then_lost',
        object: 'dispute',
        payment_intent: 'pi_grant_then_lost',
        charge: 'ch_grant_then_lost',
        status: 'lost',
      },
    },
  });
  assert.equal(r.status, 200);
  rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
  assert.ok(rec.delete_at);
  assert.equal(rec.cancel_pending, true);
  assert.equal((await me(env, 'sub:' + hex).then((res) => res.json())).unlocked, false);
});

test('full refund after a dispute is not undone by a later won close', async () => {
  const kv = memoryKv();
  const hex = 'f3'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  wirePaymentRefs({
    invoice: 'in_dp_then_rf',
    charge: 'ch_dp_then_rf',
    paymentIntent: 'pi_dp_then_rf',
    subscription: 'sub_dp_then_rf',
  });

  let r = await subscriptionCheckoutInvoiceOnly(env, {
    hex,
    sessionId: 'cs_dp_then_rf',
    invoice: 'in_dp_then_rf',
    subscription: 'sub_dp_then_rf',
    created: 42_000,
    eventId: 'evt_cs_dp_then_rf',
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'active');

  r = await signedWebhook(env, {
    id: 'evt_dp_then_rf_open',
    type: 'charge.dispute.created',
    livemode: false,
    created: 42_001,
    data: {
      object: {
        id: 'dp_then_rf',
        object: 'dispute',
        payment_intent: 'pi_dp_then_rf',
        charge: 'ch_dp_then_rf',
        status: 'needs_response',
      },
    },
  });
  assert.equal(r.status, 200);
  let rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
  assert.equal(rec.revoke_reason, 'dispute');
  assert.equal(rec.delete_at, null);

  r = await signedWebhook(env, {
    id: 'evt_dp_then_rf_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 42_002,
    data: {
      object: {
        id: 'ch_dp_then_rf',
        object: 'charge',
        refunded: true,
        amount: 399,
        amount_refunded: 399,
        currency: 'usd',
      },
    },
  });
  assert.equal(r.status, 200);
  rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
  assert.equal(rec.revoke_reason, 'refund');
  assert.ok(rec.delete_at);
  assert.equal(rec.cancel_pending, true);
  assert.ok(await kv.get('stripe:refunded:pi_dp_then_rf'));

  r = await signedWebhook(env, {
    id: 'evt_dp_then_rf_won',
    type: 'charge.dispute.closed',
    livemode: false,
    created: 42_003,
    data: {
      object: {
        id: 'dp_then_rf',
        object: 'dispute',
        payment_intent: 'pi_dp_then_rf',
        charge: 'ch_dp_then_rf',
        status: 'won',
      },
    },
  });
  assert.equal(r.status, 200);
  rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
  assert.equal(rec.revoke_reason, 'refund');
  assert.ok(rec.delete_at);
  assert.equal((await me(env, 'sub:' + hex).then((res) => res.json())).unlocked, false);
});

test('stripe:invpi mapping is write-once and refuses a different payment_intent', async () => {
  const kv = memoryKv();
  const hex = 'f4'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  const logs = [];
  const orig = console.log;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  let r;
  try {
    r = await paidMonthlyCheckout(env, {
      hex,
      sessionId: 'cs_invpi_once',
      subscription: 'sub_invpi_once',
      paymentIntent: 'pi_invpi_once',
      invoice: 'in_invpi_once',
      created: 43_000,
    });
    assert.equal(r.status, 200);
    assert.equal(await kv.get('stripe:invpi:in_invpi_once'), 'pi_invpi_once');

    r = await signedWebhook(env, {
      id: 'evt_invpi_other',
      type: 'invoice.paid',
      livemode: false,
      created: 43_001,
      data: {
        object: {
          id: 'in_invpi_once',
          object: 'invoice',
          payment_intent: 'pi_invpi_other',
        },
      },
    });
    assert.equal(r.status, 200);
  } finally {
    console.log = orig;
  }
  assert.equal(await kv.get('stripe:invpi:in_invpi_once'), 'pi_invpi_once');
  assert.ok(logs.some((line) => /invoice payment_intent does not match stored mapping/.test(line)));
});

test('charge-only refund fetches the charge to tombstone the payment_intent', async () => {
  const kv = memoryKv();
  const hex = 'f5'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  wirePaymentRefs({
    invoice: 'in_ch_only',
    charge: 'ch_only',
    paymentIntent: 'pi_ch_only',
    subscription: 'sub_ch_only',
  });

  let r = await subscriptionCheckoutInvoiceOnly(env, {
    hex,
    sessionId: 'cs_ch_only',
    invoice: 'in_ch_only',
    subscription: 'sub_ch_only',
    created: 44_000,
    eventId: 'evt_cs_ch_only',
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'active');

  r = await signedWebhook(env, {
    id: 'evt_ch_only_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 44_001,
    data: {
      object: {
        id: 'ch_only',
        object: 'charge',
        refunded: true,
        amount: 399,
        amount_refunded: 399,
        currency: 'usd',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.ok(await kv.get('stripe:refunded:ch_only'));
  assert.ok(await kv.get('stripe:refunded:pi_ch_only'));
  assert.ok(await kv.get('stripe:refunded:in_ch_only'));
  const rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'refunded');
  assert.equal(rec.revoke_reason, 'refund');
  assert.equal((await me(env, 'sub:' + hex).then((res) => res.json())).unlocked, false);
});

test('invoice fetch for refund refs is transient on 5xx and permanent on 404', async () => {
  const kv = memoryKv();
  const env = { ...stripeEnv, KV: kv };

  stripeInvoiceGetErrors.in_fetch_500 = 500;
  const event500 = {
    id: 'evt_inv_fetch_500',
    type: 'charge.refunded',
    livemode: false,
    created: 45_000,
    data: {
      object: {
        id: 'ch_inv_fetch_500',
        object: 'charge',
        invoice: 'in_fetch_500',
        refunded: true,
        amount: 399,
        amount_refunded: 399,
        currency: 'usd',
      },
    },
  };
  let r = await signedWebhook(env, event500);
  assert.equal(r.status, 500);
  assert.equal(await kv.get('stripe:evt:evt_inv_fetch_500'), null);
  assert.equal(await kv.get('stripe:refunded:in_fetch_500'), null);

  stripeInvoiceGetErrors.in_fetch_404 = 404;
  r = await signedWebhook(env, {
    id: 'evt_inv_fetch_404',
    type: 'charge.refunded',
    livemode: false,
    created: 45_001,
    data: {
      object: {
        id: 'ch_inv_fetch_404',
        object: 'charge',
        invoice: 'in_fetch_404',
        refunded: true,
        amount: 399,
        amount_refunded: 399,
        currency: 'usd',
      },
    },
  });
  assert.equal(r.status, 500);
  assert.equal(await kv.get('stripe:evt:evt_inv_fetch_404'), null);
  assert.ok(await kv.get('stripe:refunded:in_fetch_404'));
  assert.ok(await kv.get('stripe:refunded:ch_inv_fetch_404'));
  assert.equal(await kv.get('stripe:refunded:pi_missing'), null);
});

test('subscription.updated uses item price ids when metadata.plan is stale', async () => {
  const kv = memoryKv();
  const hex = 'f6'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  let r = await paidMonthlyCheckout(env, {
    hex,
    sessionId: 'cs_plan_stale',
    subscription: 'sub_plan_stale',
    paymentIntent: 'pi_plan_stale',
    created: 46_000,
  });
  assert.equal(r.status, 200);
  let rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'active');
  assert.equal(rec.last_event_created, 46_000);

  r = await signedWebhook(env, {
    id: 'evt_plan_stale_yearly',
    type: 'customer.subscription.updated',
    livemode: false,
    created: 46_100,
    data: {
      object: {
        id: 'sub_plan_stale',
        status: 'active',
        cancel_at_period_end: false,
        metadata: { unlock_token: 'sub:' + hex, plan: 'monthly' },
        items: subscriptionItems('yearly'),
      },
    },
  });
  assert.equal(r.status, 200);
  rec = await kv.get('sub:' + hex, 'json');
  assert.equal(rec.status, 'active');
  assert.equal(rec.last_event_created, 46_100);
  assert.equal((await me(env, 'sub:' + hex).then((res) => res.json())).unlocked, true);
});

test('subscription.updated without items is 5xx on a transient fetch and a no-op on 404', async () => {
  const kv = memoryKv();
  const hex = 'f7'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  let r = await paidMonthlyCheckout(env, {
    hex,
    sessionId: 'cs_items_fetch',
    subscription: 'sub_items_fetch',
    paymentIntent: 'pi_items_fetch',
    created: 47_000,
  });
  assert.equal(r.status, 200);

  stripeSubscriptionGetErrors.sub_items_fetch = 500;
  r = await signedWebhook(env, {
    id: 'evt_items_fetch_500',
    type: 'customer.subscription.updated',
    livemode: false,
    created: 47_100,
    data: {
      object: {
        id: 'sub_items_fetch',
        status: 'active',
        cancel_at_period_end: false,
        metadata: { unlock_token: 'sub:' + hex, plan: 'monthly' },
      },
    },
  });
  assert.equal(r.status, 500);
  assert.equal(await kv.get('stripe:evt:evt_items_fetch_500'), null);
  assert.equal((await kv.get('sub:' + hex, 'json')).last_event_created, 47_000);

  delete stripeSubscriptionGetErrors.sub_items_fetch;
  stripeSubscriptionGetErrors.sub_items_fetch = 404;
  r = await signedWebhook(env, {
    id: 'evt_items_fetch_404',
    type: 'customer.subscription.updated',
    livemode: false,
    created: 47_200,
    data: {
      object: {
        id: 'sub_items_fetch',
        status: 'active',
        cancel_at_period_end: false,
        metadata: { unlock_token: 'sub:' + hex, plan: 'monthly' },
      },
    },
  });
  assert.equal(r.status, 200);
  assert.ok(await kv.get('stripe:evt:evt_items_fetch_404'));
  assert.equal((await kv.get('sub:' + hex, 'json')).last_event_created, 47_000);
});

test('charge-only lifetime refund fetches the charge once and does not look up a subscription', async () => {
  const kv = memoryKv();
  const hex = 'a1'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  let r = await signedWebhook(env, {
    id: 'evt_life_once_grant',
    type: 'checkout.session.completed',
    livemode: false,
    created: 50_000,
    data: {
      object: {
        id: 'cs_life_once',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_life_once',
        metadata: { unlock_token: 'sub:' + hex, plan: 'lifetime' },
        line_items: catalogLineItems('lifetime'),
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'lifetime');

  stripeCalls = [];
  stripeChargeGets.ch_life_once = {
    id: 'ch_life_once',
    object: 'charge',
    payment_intent: 'pi_life_once',
    livemode: false,
  };
  r = await signedWebhook(env, {
    id: 'evt_life_once_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 50_001,
    data: {
      object: {
        id: 'ch_life_once',
        object: 'charge',
        refunded: true,
        amount: 5900,
        amount_refunded: 5900,
        currency: 'usd',
      },
    },
  });
  assert.equal(r.status, 200);
  const chargeGets = stripeCalls.filter((c) => c.method === 'GET' && /\/charges\/ch_life_once/.test(c.url));
  const invoiceGets = stripeCalls.filter((c) => c.method === 'GET' && /\/invoices\//.test(c.url));
  const subGets = stripeCalls.filter((c) => c.method === 'GET' && /\/subscriptions\//.test(c.url));
  assert.equal(chargeGets.length, 1);
  assert.equal(invoiceGets.length, 0);
  assert.equal(subGets.length, 0);
  assert.ok(await kv.get('stripe:refunded:ch_life_once'));
  assert.ok(await kv.get('stripe:refunded:pi_life_once'));
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'refunded');
});

test('webhook deadline exceeded returns 500 without a dedupe key', async () => {
  const kv = memoryKv();
  const env = { ...stripeEnv, KV: kv, STRIPE_WEBHOOK_BUDGET_MS: '20' };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return origFetch(url, init);
  };
  let r;
  try {
    r = await signedWebhook(env, {
      id: 'evt_budget_deadline',
      type: 'charge.refunded',
      livemode: false,
      created: 51_000,
      data: {
        object: {
          id: 'ch_budget_deadline',
          object: 'charge',
          refunded: true,
          amount: 399,
          amount_refunded: 399,
          currency: 'usd',
        },
      },
    });
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(r.status, 500);
  assert.equal(await kv.get('stripe:evt:evt_budget_deadline'), null);
});

test('charge A linked to invoice B does not touch buyer B', async () => {
  const kv = memoryKv();
  const hexA = 'a2'.repeat(16);
  const hexB = 'a3'.repeat(16);
  const env = { ...stripeEnv, KV: kv };

  let r = await signedWebhook(env, {
    id: 'evt_poison_a_grant',
    type: 'checkout.session.completed',
    livemode: false,
    created: 52_000,
    data: {
      object: {
        id: 'cs_poison_a',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_poison_a',
        latest_charge: 'ch_poison_a',
        metadata: { unlock_token: 'sub:' + hexA, plan: 'lifetime' },
        line_items: catalogLineItems('lifetime'),
      },
    },
  });
  assert.equal(r.status, 200);
  r = await paidMonthlyCheckout(env, {
    hex: hexB,
    sessionId: 'cs_poison_b',
    subscription: 'sub_poison_b',
    paymentIntent: 'pi_poison_b',
    invoice: 'in_poison_b',
    charge: 'ch_poison_b',
    created: 52_001,
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hexA, 'json')).status, 'lifetime');
  assert.equal((await kv.get('sub:' + hexB, 'json')).status, 'active');

  stripeChargeGets.ch_poison_a = {
    id: 'ch_poison_a',
    object: 'charge',
    payment_intent: 'pi_poison_a',
    invoice: 'in_poison_b',
    livemode: false,
  };
  r = await signedWebhook(env, {
    id: 'evt_poison_a_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 52_002,
    data: {
      object: {
        id: 'ch_poison_a',
        object: 'charge',
        refunded: true,
        amount: 5900,
        amount_refunded: 5900,
        currency: 'usd',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hexA, 'json')).status, 'refunded');
  assert.equal((await kv.get('sub:' + hexB, 'json')).status, 'active');
  assert.ok(await kv.get('stripe:refunded:ch_poison_a'));
  assert.ok(await kv.get('stripe:refunded:pi_poison_a'));
  assert.equal(await kv.get('stripe:refunded:in_poison_b'), null);
  assert.equal((await me(env, 'sub:' + hexB).then((res) => res.json())).unlocked, true);
});

test('invoice.paid with a new payment_intent does not write stripepi or touch the buyer', async () => {
  const kv = memoryKv();
  const hex = 'a4'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  const logs = [];
  const orig = console.log;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  let r;
  try {
    r = await paidMonthlyCheckout(env, {
      hex,
      sessionId: 'cs_pi_evil',
      subscription: 'sub_pi_evil',
      paymentIntent: 'pi_good',
      invoice: 'in_pi_evil',
      created: 53_000,
    });
    assert.equal(r.status, 200);
    assert.equal(await kv.get('stripe:invpi:in_pi_evil'), 'pi_good');
    assert.equal(await kv.get('stripepi:pi_good'), hex);

    r = await signedWebhook(env, {
      id: 'evt_pi_evil_paid',
      type: 'invoice.paid',
      livemode: false,
      created: 53_001,
      data: {
        object: {
          id: 'in_pi_evil',
          object: 'invoice',
          payment_intent: 'pi_evil',
        },
      },
    });
    assert.equal(r.status, 200);
  } finally {
    console.log = orig;
  }
  assert.equal(await kv.get('stripe:invpi:in_pi_evil'), 'pi_good');
  assert.equal(await kv.get('stripepi:pi_good'), hex);
  assert.equal(await kv.get('stripepi:pi_evil'), null);
  assert.ok(logs.some((line) => /invoice payment_intent does not match stored mapping/.test(line)));

  r = await signedWebhook(env, {
    id: 'evt_pi_evil_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 53_002,
    data: {
      object: {
        id: 'ch_pi_evil',
        object: 'charge',
        payment_intent: 'pi_evil',
        refunded: true,
        amount: 399,
        amount_refunded: 399,
        currency: 'usd',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'active');
  assert.equal((await me(env, 'sub:' + hex).then((res) => res.json())).unlocked, true);
});

test('charge-only 404 refund tombstones the charge and a later checkout with that charge is skipped', async () => {
  const kv = memoryKv();
  const hex = 'a5'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  stripeChargeGetErrors.ch_404_later = 404;

  let r = await signedWebhook(env, {
    id: 'evt_ch_404_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 54_000,
    data: {
      object: {
        id: 'ch_404_later',
        object: 'charge',
        refunded: true,
        amount: 399,
        amount_refunded: 399,
        currency: 'usd',
      },
    },
  });
  assert.equal(r.status, 500);
  assert.equal(await kv.get('stripe:evt:evt_ch_404_refund'), null);
  assert.ok(await kv.get('stripe:refunded:ch_404_later'));

  delete stripeChargeGetErrors.ch_404_later;
  wirePaymentRefs({
    invoice: 'in_404_later',
    charge: 'ch_404_later',
    paymentIntent: 'pi_404_later',
    subscription: 'sub_404_later',
  });
  r = await subscriptionCheckoutInvoiceOnly(env, {
    hex,
    sessionId: 'cs_404_later',
    invoice: 'in_404_later',
    subscription: 'sub_404_later',
    created: 54_001,
    eventId: 'evt_cs_404_later',
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('sub:' + hex, 'json'), null);
  assert.equal((await me(env, 'sub:' + hex).then((res) => res.json())).unlocked, false);
});

test('mixed invoice A and charge B event fails closed and touches neither buyer', async () => {
  const kv = memoryKv();
  const hexA = 'a6'.repeat(16);
  const hexB = 'a7'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  wirePaymentRefs({
    invoice: 'in_mix_a',
    charge: 'ch_mix_a',
    paymentIntent: 'pi_mix_a',
    subscription: 'sub_mix_a',
  });
  let r = await subscriptionCheckoutInvoiceOnly(env, {
    hex: hexA,
    sessionId: 'cs_mix_a',
    invoice: 'in_mix_a',
    subscription: 'sub_mix_a',
    created: 55_000,
    eventId: 'evt_cs_mix_a',
  });
  assert.equal(r.status, 200);
  wirePaymentRefs({
    invoice: 'in_mix_b',
    charge: 'ch_mix_b',
    paymentIntent: 'pi_mix_b',
    subscription: 'sub_mix_b',
  });
  r = await subscriptionCheckoutInvoiceOnly(env, {
    hex: hexB,
    sessionId: 'cs_mix_b',
    invoice: 'in_mix_b',
    subscription: 'sub_mix_b',
    created: 55_001,
    eventId: 'evt_cs_mix_b',
  });
  assert.equal(r.status, 200);
  assert.equal((await kv.get('sub:' + hexA, 'json')).status, 'active');
  assert.equal((await kv.get('sub:' + hexB, 'json')).status, 'active');

  r = await signedWebhook(env, {
    id: 'evt_mix_ab_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 55_002,
    data: {
      object: {
        id: 'ch_mix_b',
        object: 'charge',
        invoice: 'in_mix_a',
        refunded: true,
        amount: 399,
        amount_refunded: 399,
        currency: 'usd',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.ok(await kv.get('stripe:evt:evt_mix_ab_refund'));
  assert.equal((await kv.get('sub:' + hexA, 'json')).status, 'active');
  assert.equal((await kv.get('sub:' + hexB, 'json')).status, 'active');
  assert.equal(await kv.get('stripe:refunded:in_mix_a'), null);
  assert.equal(await kv.get('stripe:refunded:ch_mix_b'), null);
  assert.equal(await kv.get('stripe:refunded:pi_mix_a'), null);
  assert.equal(await kv.get('stripe:refunded:pi_mix_b'), null);
  assert.equal((await me(env, 'sub:' + hexA).then((res) => res.json())).unlocked, true);
  assert.equal((await me(env, 'sub:' + hexB).then((res) => res.json())).unlocked, true);
});

test('fetched livemode mismatch fails closed without a revoke', async () => {
  const kv = memoryKv();
  const hex = 'a8'.repeat(16);
  const env = { ...stripeEnv, KV: kv };
  let r = await signedWebhook(env, {
    id: 'evt_lm_grant',
    type: 'checkout.session.completed',
    livemode: false,
    created: 56_000,
    data: {
      object: {
        id: 'cs_lm',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_lm',
        latest_charge: 'ch_lm',
        metadata: { unlock_token: 'sub:' + hex, plan: 'lifetime' },
        line_items: catalogLineItems('lifetime'),
      },
    },
  });
  assert.equal(r.status, 200);

  stripeChargeGets.ch_lm = {
    id: 'ch_lm',
    object: 'charge',
    payment_intent: 'pi_lm',
    livemode: true,
  };
  r = await signedWebhook(env, {
    id: 'evt_lm_refund',
    type: 'charge.refunded',
    livemode: false,
    created: 56_001,
    data: {
      object: {
        id: 'ch_lm',
        object: 'charge',
        refunded: true,
        amount: 5900,
        amount_refunded: 5900,
        currency: 'usd',
      },
    },
  });
  assert.equal(r.status, 200);
  assert.ok(await kv.get('stripe:evt:evt_lm_refund'));
  assert.equal((await kv.get('sub:' + hex, 'json')).status, 'lifetime');
  assert.equal(await kv.get('stripe:refunded:ch_lm'), null);
  assert.equal((await me(env, 'sub:' + hex).then((res) => res.json())).unlocked, true);
});
