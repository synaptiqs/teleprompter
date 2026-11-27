// LOCAL TEST ONLY: node --test test/  (no network; Lemon Squeezy faked)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
let sent = [];
let lastCheckout = null;
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.lemonsqueezy.com/v1/checkouts') throw new Error('blocked ' + url);
  const b = JSON.parse(init.body);
  lastCheckout = b;
  sent.push(b.data.attributes.product_options.enabled_variants[0]);
  return new Response(JSON.stringify({ data: { attributes: { url: 'https://example.invalid/checkout' } } }), { status: 201 });
};
const worker = (await import('../worker/script-api.js')).default;
const base = { LEMONSQUEEZY_API_KEY: 'k', LEMONSQUEEZY_STORE_ID: '1', LEMONSQUEEZY_VARIANT_ID: '111', LEMONSQUEEZY_VARIANT_ID_LIFETIME: '333' };
const checkout = (env, plan) => worker.fetch(new Request('https://x.test/api/checkout', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://clickprompt.app' }, body: JSON.stringify({ plan, origin: 'https://clickprompt.app' }) }), env, { waitUntil() {} });
test('yearly reads LEMONSQUEEZY_VARIANT_ID_ANNUAL (live name)', async () => {
  sent = []; const r = await checkout({ ...base, LEMONSQUEEZY_VARIANT_ID_ANNUAL: '222' }, 'yearly');
  assert.equal(r.status, 200); assert.deepEqual(sent, ['222']);
});
test('"annual" alias also resolves', async () => {
  sent = []; await checkout({ ...base, LEMONSQUEEZY_VARIANT_ID_ANNUAL: '222' }, 'annual'); assert.deepEqual(sent, ['222']);
});
test('falls back to LEMONSQUEEZY_VARIANT_ID_YEARLY', async () => {
  sent = []; const r = await checkout({ ...base, LEMONSQUEEZY_VARIANT_ID_YEARLY: '224' }, 'yearly');
  assert.equal(r.status, 200); assert.deepEqual(sent, ['224']);
});
test('_ANNUAL wins when both are set', async () => {
  sent = []; await checkout({ ...base, LEMONSQUEEZY_VARIANT_ID_ANNUAL: '222', LEMONSQUEEZY_VARIANT_ID_YEARLY: '224' }, 'yearly'); assert.deepEqual(sent, ['222']);
});
test('yearly with neither set -> 503, no LS call', async () => {
  sent = []; const r = await checkout(base, 'yearly'); assert.equal(r.status, 503); assert.deepEqual(sent, []);
});
test('monthly and lifetime unchanged', async () => {
  sent = []; await checkout(base, 'monthly'); await checkout(base, 'lifetime'); assert.deepEqual(sent, ['111', '333']);
});
test('no hard-coded hosted checkout links in the frontend', () => {
  for (const f of ['app.js', 'index.html']) {
    const s = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.ok(!/SHARE_CHECKOUT_URL|lemonsqueezy\.com\/checkout\/buy|b043d615/.test(s), f);
  }
});
test('preview vars map plans to TEST-mode variants', async () => {
  const pv = JSON.parse(fs.readFileSync(new URL('../worker/preview.vars.json', import.meta.url), 'utf8'));
  const env = { LEMONSQUEEZY_API_KEY: 'k', LEMONSQUEEZY_STORE_ID: '1', ...pv };
  sent = []; for (const p of ['monthly', 'yearly', 'lifetime']) assert.equal((await checkout(env, p)).status, 200);
  assert.deepEqual(sent, ['2287468', '2287471', '2287475']);
});

function memoryKv() {
  const data = new Map();
  return {
    async get(key, type) {
      if (!data.has(key)) return null;
      const v = data.get(key);
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, val) { data.set(key, typeof val === 'string' ? val : JSON.stringify(val)); },
    async delete(key) { data.delete(key); },
    _data: data
  };
}

const checkoutWith = (env, body) => worker.fetch(new Request('https://x.test/api/checkout', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://clickprompt.app' },
  body: JSON.stringify({ plan: 'monthly', origin: 'https://clickprompt.app', ...body }) }), env, { waitUntil() {} });

test('checkout forwards sanitized attribution as Lemon Squeezy custom data', async () => {
  lastCheckout = null;
  const env = { ...base, LEMONSQUEEZY_VARIANT_ID_ANNUAL: '222' };
  const r = await checkoutWith(env, {
    attribution: {
      utm_source: 'Reddit',
      utm_campaign: 'first 10!',
      utm_medium: 'social',
      referrer: 'https://www.reddit.com/r/foo?token=abc',
      landing: '/?utm_source=reddit',
      timestamp: '2026-11-27T20:00:00Z',
      unlock_token: 'should-not-win'
    }
  });
  assert.equal(r.status, 200);
  const custom = lastCheckout.data.attributes.checkout_data.custom;
  assert.equal(custom.utm_source, 'reddit');
  assert.equal(custom.utm_campaign, 'first10');
  assert.equal(custom.utm_medium, 'social');
  assert.equal(custom.attr_referrer, 'www.reddit.com');
  assert.equal(custom.attr_landing, '/');
  assert.equal(custom.attr_ts, '2026-11-27T20:00:00Z');
  assert.equal(custom.unlock_token.slice(0, 4), 'sub:');
  assert.notEqual(custom.unlock_token, 'should-not-win');
});

test('checkout still works when attribution is missing or junk (live Worker may ignore it)', async () => {
  lastCheckout = null;
  const r1 = await checkoutWith(base, {});
  assert.equal(r1.status, 200);
  assert.equal(lastCheckout.data.attributes.checkout_data.custom.utm_source, undefined);
  const r2 = await checkoutWith(base, { attribution: 'not-an-object' });
  assert.equal(r2.status, 200);
  const r3 = await checkoutWith(base, { attribution: ['utm_source'] });
  assert.equal(r3.status, 200);
});

const launch = (env, body, ip) => worker.fetch(new Request('https://x.test/api/launch-notify', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://clickprompt.app', 'CF-Connecting-IP': ip || '203.0.113.10' },
  body: JSON.stringify(body) }), env, { waitUntil() {} });

test('launch-notify stores email and attribution, first signup wins', async () => {
  const kv = memoryKv();
  const env = { KV: kv };
  const r = await launch(env, {
    email: 'Alex@Example.com',
    attribution: { utm_source: 'tiktok', utm_campaign: 'first10', landing: '/' }
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual({ ok: body.ok, already: body.already }, { ok: true, already: undefined });
  assert.equal(kv._data.size, 2); // launch record + throttle key
  const rec = JSON.parse([...kv._data.values()].find((v) => v.includes('alex@example.com')));
  assert.equal(rec.email, 'alex@example.com');
  assert.equal(rec.attribution.utm_source, 'tiktok');
  assert.equal(rec.attribution.utm_campaign, 'first10');

  const again = await launch(env, {
    email: 'alex@example.com',
    attribution: { utm_source: 'facebook' }
  });
  const againBody = await again.json();
  assert.equal(again.status, 200);
  assert.equal(againBody.already, true);
  const rec2 = JSON.parse([...kv._data.values()].find((v) => v.includes('alex@example.com')));
  assert.equal(rec2.attribution.utm_source, 'tiktok');
});

test('launch-notify rejects a bad email and ignores a filled honeypot', async () => {
  const kv = memoryKv();
  const bad = await launch({ KV: kv }, { email: 'not-an-email' }, '203.0.113.11');
  assert.equal(bad.status, 400);
  const hp = await launch({ KV: kv }, { email: 'ok@example.com', company: 'Bot Co' }, '203.0.113.12');
  assert.equal(hp.status, 200);
  assert.equal((await hp.json()).ok, true);
  assert.ok(![...kv._data.values()].some((v) => String(v).includes('ok@example.com')));
});

test('launch-notify returns 503 when no KV is bound, and 429 after too many tries', async () => {
  const none = await launch({}, { email: 'a@example.com' }, '203.0.113.13');
  assert.equal(none.status, 503);
  const kv = memoryKv();
  const env = { KV: kv };
  for (let i = 0; i < 5; i++) {
    const r = await launch(env, { email: `user${i}@example.com` }, '203.0.113.14');
    assert.equal(r.status, 200, 'attempt ' + i);
  }
  const blocked = await launch(env, { email: 'last@example.com' }, '203.0.113.14');
  assert.equal(blocked.status, 429);
});

test('optional LAUNCH_KV binding is used when present', async () => {
  const launchNs = memoryKv();
  const mainKv = memoryKv();
  const r = await launch({ KV: mainKv, LAUNCH_KV: launchNs }, { email: 'iso@example.com' }, '203.0.113.15');
  assert.equal(r.status, 200);
  assert.ok([...launchNs._data.values()].some((v) => String(v).includes('iso@example.com')));
  assert.ok(![...mainKv._data.values()].some((v) => String(v).includes('iso@example.com')));
});
