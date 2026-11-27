// LOCAL TEST ONLY: node --test test/  (no network; Lemon Squeezy faked)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
let sent = [];
let lastCheckout = null;
let turnstileSuccess = true;
let turnstilePayload = { hostname: 'clickprompt.app', action: 'launch' };
let turnstileHang = false;
let lastTurnstile = null;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
    lastTurnstile = init;
    if (turnstileHang) {
      await new Promise((resolve, reject) => {
        const abort = () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (init && init.signal) {
          if (init.signal.aborted) { abort(); return; }
          init.signal.addEventListener('abort', abort, { once: true });
        }
      });
    }
    return new Response(JSON.stringify({
      success: turnstileSuccess,
      hostname: turnstilePayload.hostname,
      action: turnstilePayload.action
    }), { status: 200 });
  }
  if (u !== 'https://api.lemonsqueezy.com/v1/checkouts') throw new Error('blocked ' + url);
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
  const ttls = new Map();
  const store = {
    _gets: 0,
    async get(key, type) {
      store._gets += 1;
      if (!data.has(key)) return null;
      const v = data.get(key);
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, val, opts) {
      data.set(key, typeof val === 'string' ? val : JSON.stringify(val));
      if (opts && opts.expirationTtl) ttls.set(key, opts.expirationTtl);
    },
    async delete(key) { data.delete(key); ttls.delete(key); },
    _data: data,
    _ttls: ttls
  };
  return store;
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

test('checkout redirect_url allowlists production and Pages previews, otherwise falls back', async () => {
  const { _allowedCheckoutOrigin: allowed } = await import('../worker/script-api.js');
  assert.equal(allowed('https://clickprompt.app'), 'https://clickprompt.app');
  assert.equal(allowed('https://www.clickprompt.app/path'), 'https://www.clickprompt.app');
  assert.equal(allowed('https://teleprompter-5fz.pages.dev'), 'https://teleprompter-5fz.pages.dev');
  assert.equal(allowed('https://0d3a072d.teleprompter-5fz.pages.dev'), 'https://0d3a072d.teleprompter-5fz.pages.dev');
  assert.equal(allowed('http://clickprompt.app'), 'https://clickprompt.app');
  assert.equal(allowed('https://evil.com'), 'https://clickprompt.app');
  assert.equal(allowed('https://evil-teleprompter-5fz.pages.dev'), 'https://clickprompt.app');
  assert.equal(allowed('https://clickprompt.app.evil.com'), 'https://clickprompt.app');
  assert.equal(allowed('javascript:alert(1)'), 'https://clickprompt.app');

  lastCheckout = null;
  const r = await checkoutWith(base, { origin: 'https://evil.example' });
  assert.equal(r.status, 200);
  assert.equal(lastCheckout.data.attributes.product_options.redirect_url, 'https://clickprompt.app/?checkout=done');

  lastCheckout = null;
  const r2 = await checkoutWith(base, { origin: 'https://abc.teleprompter-5fz.pages.dev' });
  assert.equal(r2.status, 200);
  assert.equal(lastCheckout.data.attributes.product_options.redirect_url, 'https://abc.teleprompter-5fz.pages.dev/?checkout=done');
});

const launch = (env, body, ip, opts = {}) => {
  const headers = {
    Origin: 'https://clickprompt.app',
    'CF-Connecting-IP': ip || '203.0.113.10',
    ...(opts.headers || {})
  };
  if (opts.contentType !== false && !('Content-Type' in headers)) {
    headers['Content-Type'] = opts.contentType || 'application/json';
  }
  if (opts.contentLength !== undefined) headers['Content-Length'] = String(opts.contentLength);
  const bodyInit = opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(body);
  return worker.fetch(new Request('https://x.test/api/launch-notify', {
    method: 'POST', headers, body: bodyInit
  }), env, { waitUntil() {} });
};

test('launch-notify stores email and attribution, first signup wins, always {ok:true}', async () => {
  const kv = memoryKv();
  const env = { LAUNCH_KV: kv };
  const r = await launch(env, {
    email: 'Alex@Example.com',
    attribution: { utm_source: 'tiktok', utm_campaign: 'first10', landing: '/' }
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body, { ok: true });
  assert.equal(Object.keys(body).includes('already'), false);
  const recKey = [...kv._data.keys()].find((k) => k.startsWith('launch:'));
  const rec = JSON.parse(kv._data.get(recKey));
  assert.equal(rec.email, 'alex@example.com');
  assert.equal(rec.attribution.utm_source, 'tiktok');
  assert.equal(kv._ttls.get(recKey), 365 * 24 * 60 * 60);

  const again = await launch(env, {
    email: 'alex@example.com',
    attribution: { utm_source: 'facebook' }
  });
  const againBody = await again.json();
  assert.equal(again.status, 200);
  assert.deepEqual(againBody, { ok: true });
  const rec2 = JSON.parse(kv._data.get(recKey));
  assert.equal(rec2.attribution.utm_source, 'tiktok');
});

test('launch-notify rejects a bad email and returns {ok:true} for a filled honeypot without storing', async () => {
  const kv = memoryKv();
  const bad = await launch({ LAUNCH_KV: kv }, { email: 'not-an-email' }, '203.0.113.11');
  assert.equal(bad.status, 400);
  const getsBefore = kv._gets;
  const hp = await launch({ LAUNCH_KV: kv }, { email: 'ok@example.com', hp_website_url: 'Bot Co' }, '203.0.113.12');
  assert.equal(hp.status, 200);
  assert.deepEqual(await hp.json(), { ok: true });
  assert.ok(![...kv._data.values()].some((v) => String(v).includes('ok@example.com')));
  assert.ok(kv._gets > getsBefore, 'honeypot path performs a KV get');
});

test('launch-notify returns 503 when LAUNCH_KV is missing, including if only main KV is bound', async () => {
  const none = await launch({}, { email: 'a@example.com' }, '203.0.113.13');
  assert.equal(none.status, 503);
  const onlyMain = await launch({ KV: memoryKv() }, { email: 'b@example.com' }, '203.0.113.13');
  assert.equal(onlyMain.status, 503);
});

test('launch-notify KV throttle is 5 per hour and buckets IPv6 by /64', async () => {
  const kv = memoryKv();
  const env = { LAUNCH_KV: kv };
  for (let i = 0; i < 5; i++) {
    const r = await launch(env, { email: `user${i}@example.com` }, '203.0.113.14');
    assert.equal(r.status, 200, 'attempt ' + i);
  }
  const blocked = await launch(env, { email: 'last@example.com' }, '203.0.113.14');
  assert.equal(blocked.status, 429);

  const v6a = '2001:db8:abcd:0012:ffff::1';
  const v6b = '2001:db8:abcd:12:1::aaaa';
  const v6other = '2001:db8:abcd:0013::1';
  for (let i = 0; i < 5; i++) {
    const ip = i % 2 === 0 ? v6a : v6b;
    const r = await launch(env, { email: `v6${i}@example.com` }, ip);
    assert.equal(r.status, 200, 'v6 attempt ' + i);
  }
  const v6blocked = await launch(env, { email: 'v6last@example.com' }, v6a);
  assert.equal(v6blocked.status, 429);
  const v6ok = await launch(env, { email: 'v6other@example.com' }, v6other);
  assert.equal(v6ok.status, 200);

  const { _throttleIpKey: key } = await import('../worker/script-api.js');
  assert.equal(key(v6a), key(v6b));
  assert.notEqual(key(v6a), key(v6other));
  assert.equal(key('::ffff:203.0.113.10'), '203.0.113.10');
  for (const k of kv._data.keys()) {
    if (String(k).startsWith('launchthrottle:')) {
      assert.equal(/203\.0\.113|2001:db8/.test(k), false, k);
      assert.match(k, /^launchthrottle:\d+:[0-9a-f]{64}$/);
    }
  }
});

test('LAUNCH_RATE_LIMITER is used when bound, with KV throttle as fallback', async () => {
  const kv = memoryKv();
  let seen = [];
  const limiterFail = { limit: async ({ key }) => { seen.push(key); return { success: false }; } };
  const limited = await launch({ LAUNCH_KV: kv, LAUNCH_RATE_LIMITER: limiterFail }, { email: 'rate@example.com' }, '203.0.113.20');
  assert.equal(limited.status, 429);
  assert.deepEqual(seen, ['203.0.113.20']);
  assert.ok(![...kv._data.values()].some((v) => String(v).includes('rate@example.com')));

  seen = [];
  const limiterOk = { limit: async ({ key }) => { seen.push(key); return { success: true }; } };
  const ok = await launch({ LAUNCH_KV: kv, LAUNCH_RATE_LIMITER: limiterOk }, { email: 'rateok@example.com' }, '203.0.113.21');
  assert.equal(ok.status, 200);
  assert.deepEqual(seen, ['203.0.113.21']);
  // Rate limiter handled the throttle, so no launchthrottle key is required.
  assert.ok([...kv._data.keys()].some((k) => k.startsWith('launch:')));
});

test('launch-notify requires application/json and rejects bodies over 8 KB', async () => {
  const env = { LAUNCH_KV: memoryKv() };
  const noType = await launch(env, { email: 'a@example.com' }, '203.0.113.30', { contentType: false });
  assert.equal(noType.status, 415);
  const textType = await launch(env, { email: 'a@example.com' }, '203.0.113.30', { contentType: 'text/plain' });
  assert.equal(textType.status, 415);
  const tooLongHeader = await launch(env, { email: 'a@example.com' }, '203.0.113.30', { contentLength: 9000 });
  assert.equal(tooLongHeader.status, 413);
  const huge = JSON.stringify({ email: 'a@example.com', pad: 'x'.repeat(9000) });
  const tooLongBody = await launch(env, {}, '203.0.113.30', { rawBody: huge });
  assert.equal(tooLongBody.status, 413);
  const withCharset = await launch(env, { email: 'charset@example.com' }, '203.0.113.30', { contentType: 'application/json; charset=utf-8' });
  assert.equal(withCharset.status, 200);
});

test('Turnstile is required only when TURNSTILE_SECRET is set', async () => {
  const kv = memoryKv();
  const env = { LAUNCH_KV: kv, TURNSTILE_SECRET: 'test-secret' };
  turnstileSuccess = false;
  const missing = await launch(env, { email: 'ts@example.com' }, '203.0.113.40');
  assert.equal(missing.status, 403);
  const missingBody = await missing.json();
  assert.equal(missingBody.code, 'human_check');
  assert.ok(![...kv._data.values()].some((v) => String(v).includes('ts@example.com')));

  turnstileSuccess = true;
  const ok = await launch(env, { email: 'ts@example.com', 'cf-turnstile-response': 'token-ok' }, '203.0.113.41');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });

  const off = await launch({ LAUNCH_KV: memoryKv() }, { email: 'nots@example.com' }, '203.0.113.42');
  assert.equal(off.status, 200);
});

test('frontend uses one generic launch success message and handles 404/405', () => {
  const js = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(js.includes('You are on the list. We will email you when the store goes live.'));
  assert.ok(!js.includes('You are already on the list'));
  assert.ok(js.includes('result._status === 404') && js.includes('result._status === 405'));
  assert.ok(!js.includes('cf-turnstile-response'));
  assert.ok(!js.includes('window.turnstile'));
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!/challenges\.cloudflare\.com\/turnstile|cf-turnstile|0x4AAAAAAFimE5/.test(html));
  assert.equal((html.match(/name="hp_website_url"/g) || []).length, 2);
  assert.ok(!html.includes('name="company"'));
  const notices = html.match(/<p class="launch-notice">[\s\S]*?<\/p>/g) || [];
  assert.equal(notices.length, 2);
  for (const n of notices) {
    assert.ok(n.includes('email and the marketing source'));
    assert.ok(n.includes('href="/privacy"'));
  }
});

test('LAUNCH_RATE_LIMITER {} falls through to the KV throttle; success:false still rejects', async () => {
  const kv = memoryKv();
  const limiterEmpty = { limit: async () => ({}) };
  const env = { LAUNCH_KV: kv, LAUNCH_RATE_LIMITER: limiterEmpty };
  for (let i = 0; i < 5; i++) {
    const r = await launch(env, { email: `empty${i}@example.com` }, '203.0.113.50');
    assert.equal(r.status, 200, 'empty limiter attempt ' + i);
  }
  const blocked = await launch(env, { email: 'empty6@example.com' }, '203.0.113.50');
  assert.equal(blocked.status, 429);
  assert.ok([...kv._data.keys()].some((k) => String(k).startsWith('launchthrottle:')));
});

test('throttleIpKey strips a zone index first and treats dotted, expanded, and hex IPv4-mapped as IPv4', async () => {
  const { _throttleIpKey: key } = await import('../worker/script-api.js');
  assert.equal(key('::ffff:203.0.113.10'), '203.0.113.10');
  assert.equal(key('::ffff:203.0.113.10%eth0'), '203.0.113.10');
  assert.equal(key('0:0:0:0:0:ffff:203.0.113.10'), '203.0.113.10');
  assert.equal(key('::ffff:cb00:710a'), '203.0.113.10');
  assert.equal(key('0:0:0:0:0:ffff:cb00:710a'), '203.0.113.10');
  assert.equal(key('::FFFF:CB00:710A%wlan0'), '203.0.113.10');
});

test('20 KB stream with Content-Length 100 is rejected without reading it all', async () => {
  let produced = 0;
  let delivered = 0;
  let cancelled = false;
  const limit = 20 * 1024;
  const chunk = 1024;
  const stream = new ReadableStream({
    pull(controller) {
      if (produced >= limit) {
        controller.close();
        return;
      }
      const buf = new Uint8Array(Math.min(chunk, limit - produced));
      buf.fill(120);
      produced += buf.byteLength;
      controller.enqueue(buf);
    }
  }, { highWaterMark: 1 });
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Content-Length': '100',
    Origin: 'https://clickprompt.app',
    'CF-Connecting-IP': '203.0.113.99'
  });
  const req = {
    method: 'POST',
    url: 'https://x.test/api/launch-notify',
    headers,
    body: {
      getReader() {
        const reader = stream.getReader();
        return {
          async read() {
            const step = await reader.read();
            if (step.value) delivered += step.value.byteLength;
            return step;
          },
          async cancel() {
            cancelled = true;
            return reader.cancel();
          }
        };
      },
      async cancel() {
        cancelled = true;
        try { await stream.cancel(); } catch (e) {}
      }
    }
  };
  const r = await worker.fetch(req, { LAUNCH_KV: memoryKv() }, { waitUntil() {} });
  assert.equal(r.status, 413);
  assert.equal(cancelled, true);
  assert.ok(delivered <= 8192 + chunk, 'worker read ' + delivered + ' bytes before cancel');
  assert.ok(delivered > 8192, 'the abort happens once the cap is exceeded');
  assert.ok(produced < limit, 'must not produce the full 20 KB stream, produced ' + produced);
});

test('known path with the wrong method returns 405 and Allow', async () => {
  const r = await worker.fetch(new Request('https://x.test/api/launch-notify', { method: 'GET' }), {}, { waitUntil() {} });
  assert.equal(r.status, 405);
  assert.ok((r.headers.get('Allow') || '').includes('POST'));
  const me = await worker.fetch(new Request('https://x.test/api/me', { method: 'POST' }), {}, { waitUntil() {} });
  assert.equal(me.status, 405);
  assert.ok((me.headers.get('Allow') || '').includes('GET'));
});

test('turnstileOk requires an allowed hostname, action launch, and fails closed on abort', async () => {
  const { _turnstileOk: turnstileOk } = await import('../worker/script-api.js');
  const req = new Request('https://x.test/', { headers: { 'CF-Connecting-IP': '203.0.113.70' } });
  const env = { TURNSTILE_SECRET: 'test-secret' };

  turnstileHang = false;
  turnstileSuccess = true;
  turnstilePayload = { hostname: 'clickprompt.app', action: 'launch' };
  assert.equal(await turnstileOk(req, env, 'tok'), true);
  assert.ok(lastTurnstile && lastTurnstile.signal, 'AbortSignal is passed to siteverify');

  turnstilePayload = { hostname: 'evil.com', action: 'launch' };
  assert.equal(await turnstileOk(req, env, 'tok'), false);

  turnstilePayload = { hostname: 'clickprompt.app', action: 'generate' };
  assert.equal(await turnstileOk(req, env, 'tok'), false);

  turnstilePayload = { hostname: 'abc.teleprompter-5fz.pages.dev', action: 'launch' };
  assert.equal(await turnstileOk(req, env, 'tok'), true);

  turnstilePayload = { hostname: 'clickprompt.app', action: 'launch' };
  turnstileHang = true;
  assert.equal(await turnstileOk(req, env, 'tok'), false);
  turnstileHang = false;
});

test('honeypot submissions go through Turnstile and a KV get before {ok:true}', async () => {
  const kv = memoryKv();
  const env = { LAUNCH_KV: kv, TURNSTILE_SECRET: 'test-secret' };
  turnstileSuccess = false;
  turnstilePayload = { hostname: 'clickprompt.app', action: 'launch' };
  const denied = await launch(env, { email: 'hp@example.com', hp_website_url: 'https://spam.example', 'cf-turnstile-response': 'bad' }, '203.0.113.60');
  assert.equal(denied.status, 403);
  assert.ok(![...kv._data.values()].some((v) => String(v).includes('hp@example.com')));

  turnstileSuccess = true;
  const getsBefore = kv._gets;
  const ok = await launch(env, { email: 'hp@example.com', hp_website_url: 'https://spam.example', 'cf-turnstile-response': 'token-ok' }, '203.0.113.61');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.ok(kv._gets > getsBefore, 'honeypot performs a KV get');
  assert.ok(![...kv._data.values()].some((v) => String(v).includes('hp@example.com')));
});

test('emails longer than 254 characters are rejected with the generic 400, not truncated', async () => {
  const kv = memoryKv();
  const local = 'a'.repeat(64);
  const domain = 'x'.repeat(190) + '.com'; // local@domain > 254
  const long = local + '@' + domain;
  assert.ok(long.length > 254);
  const r = await launch({ LAUNCH_KV: kv }, { email: long }, '203.0.113.80');
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error, 'Please enter a valid email address.');
  assert.ok(![...kv._data.values()].some((v) => String(v).includes(local)));
});

test('Worker drops attribution older than 90 days or more than 1 day in the future', async () => {
  const { _sanitizeAttribution: sanitize } = await import('../worker/script-api.js');
  const day = 24 * 60 * 60 * 1000;
  const iso = (ms) => new Date(ms).toISOString();
  const now = Date.now();
  const fresh = sanitize({ utm_source: 'reddit', timestamp: iso(now - 89 * day) });
  assert.equal(fresh.utm_source, 'reddit');
  const at90 = sanitize({ utm_source: 'reddit', timestamp: iso(now - 90 * day) });
  assert.deepEqual(at90, {});
  const at91 = sanitize({ utm_source: 'reddit', timestamp: iso(now - 91 * day) });
  assert.deepEqual(at91, {});
  const skewed = sanitize({ utm_source: 'reddit', timestamp: iso(now + 12 * 60 * 60 * 1000) });
  assert.equal(skewed.utm_source, 'reddit');
  const tooFuture = sanitize({ utm_source: 'reddit', timestamp: iso(now + 25 * 60 * 60 * 1000) });
  assert.deepEqual(tooFuture, {});

  lastCheckout = null;
  const r = await checkoutWith(base, {
    attribution: { utm_source: 'reddit', timestamp: iso(now - 91 * day) }
  });
  assert.equal(r.status, 200);
  assert.equal(lastCheckout.data.attributes.checkout_data.custom.utm_source, undefined);
});

test('app.js wraps cookie and attribution access in try/catch and uses hp_website_url', () => {
  const js = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(js.includes('document.cookie.match'));
  assert.ok(js.indexOf('try {') < js.indexOf('document.cookie.match'));
  assert.ok(js.includes('input[name="hp_website_url"]'));
  assert.ok(!js.includes('input[name="company"]'));
  assert.ok(js.includes('ClickPromptAttribution.attachTo') || js.includes('proceed without attribution'));
});

test('README documents rate-limiter-before-redeploy, the commented wrangler snippet, and the deletion runbook', () => {
  const md = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(md.includes('LAUNCH_RATE_LIMITER') && md.includes('before the Worker is redeployed') || md.includes('before that redeploy'));
  assert.ok(md.includes('# [[unsafe.bindings]]') && md.includes('# name = "LAUNCH_RATE_LIMITER"'));
  assert.ok(md.includes("sha256") || md.includes('SHA-256'));
  assert.ok(md.includes('wrangler kv key delete'));
  assert.ok(md.includes('0d3a072d-8d93-45f5-b3f1-70870a445457'));
  assert.ok(md.includes('56737990-2d7f-4178-a376-8ef429683125'));
  assert.ok(!fs.existsSync(new URL('../wrangler.toml', import.meta.url)));
});

test('privacy.html says first-touch source data stays on the device and expires after 90 days', () => {
  const html = fs.readFileSync(new URL('../privacy.html', import.meta.url), 'utf8');
  assert.ok(html.includes('First-touch source data stays on the device') || html.includes('first-touch source data stays on the device'));
  assert.ok(html.includes('expires after 90 days'));
});
