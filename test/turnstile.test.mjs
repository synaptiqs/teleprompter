// LOCAL TEST ONLY: node --test test/turnstile.test.mjs  (no network; siteverify faked)
import test from 'node:test';
import assert from 'node:assert/strict';
let calls = 0;
globalThis.fetch = async (url, init) => {
  if (url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('blocked ' + url);
  calls++; return new Response(JSON.stringify({ success: init.body.get('response') === 'PASS' }));
};
const mod = await import('../worker/script-api.js');
const worker = mod.default;
const env = { TURNSTILE_SECRET: 'test-secret' };
const gen = (e, body) => worker.fetch(new Request('https://x.test/api/generate-script', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://clickprompt.app' }, body: JSON.stringify(body) }), e, { waitUntil() {} });
test('free tier without a token -> 403 human_check', async () => {
  const r = await gen(env, { name: 'a' }); assert.equal(r.status, 403); assert.equal((await r.json()).code, 'human_check');
});
test('free tier with a failing token -> 403', async () => { assert.equal((await gen(env, { 'cf-turnstile-response': 'FAIL' })).status, 403); });
test('passing token gets past the check', async () => { assert.notEqual((await gen(env, { 'cf-turnstile-response': 'PASS' })).status, 403); });
test('no secret set -> check is off', async () => { calls = 0; assert.notEqual((await gen({}, {})).status, 403); assert.equal(calls, 0); });
test('helper: siteverify outage fails closed', async () => {
  const f = globalThis.fetch; globalThis.fetch = async () => { throw new Error('down'); };
  assert.equal(await mod._turnstileOk(new Request('https://x.test'), env, 'PASS'), false); globalThis.fetch = f;
});
