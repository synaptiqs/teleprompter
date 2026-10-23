// LOCAL TEST ONLY: node --test test/  (no network; Lemon Squeezy faked)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
let sent = [];
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.lemonsqueezy.com/v1/checkouts') throw new Error('blocked ' + url);
  const b = JSON.parse(init.body); sent.push(b.data.attributes.product_options.enabled_variants[0]);
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
