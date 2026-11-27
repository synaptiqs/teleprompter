// LOCAL TEST ONLY: node --test test/  (no network)
import test from 'node:test';
import assert from 'node:assert/strict';
import attr from '../attribution.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    _data: data
  };
}

test('sanitizes UTM values to [a-z0-9_-] and caps length', () => {
  assert.equal(attr.sanitizeUtm('Reddit'), 'reddit');
  assert.equal(attr.sanitizeUtm('first 10!'), 'first10');
  assert.equal(attr.sanitizeUtm('ok_name-1'), 'ok_name-1');
  assert.equal(attr.sanitizeUtm('x'.repeat(80)).length, 64);
  assert.equal(attr.sanitizeUtm('<script>alert(1)</script>'), 'scriptalert1script');
});

test('referrer keeps hostname only and drops query strings', () => {
  assert.equal(attr.sanitizeReferrer('https://www.reddit.com/r/foo?token=abc'), 'www.reddit.com');
  assert.equal(attr.sanitizeReferrer('https://facebook.com/'), 'facebook.com');
  assert.equal(attr.sanitizeReferrer('not a url!!!'), 'notaurl');
});

test('landing path drops query and hash', () => {
  assert.equal(attr.sanitizeLanding('/privacy?utm_source=x#top'), '/privacy');
  assert.equal(attr.sanitizeLanding('contact'), '/contact');
  assert.equal(attr.sanitizeLanding(''), '/');
});

test('first-touch capture does not overwrite an existing record', () => {
  const storage = memoryStorage();
  const first = attr.capture({
    utm_source: 'reddit',
    utm_campaign: 'first10',
    referrer: 'https://www.reddit.com/r/x',
    landing: '/',
    timestamp: '2026-11-27T20:00:00Z'
  }, storage);
  assert.equal(first.utm_source, 'reddit');
  assert.equal(first.utm_campaign, 'first10');
  assert.equal(first.referrer, 'www.reddit.com');

  const second = attr.capture({
    utm_source: 'tiktok',
    utm_campaign: 'later',
    landing: '/privacy',
    timestamp: '2026-11-28T20:00:00Z'
  }, storage);
  assert.equal(second.utm_source, 'reddit');
  assert.equal(second.utm_campaign, 'first10');
  assert.equal(second.landing, '/');
  assert.equal(attr.get(storage).utm_source, 'reddit');
});

test('captureFromPage reads UTMs, path, and referrer from a fake window', () => {
  const storage = memoryStorage();
  const win = {
    location: { search: '?utm_source=facebook&utm_campaign=spring&junk=1', pathname: '/terms' },
    document: { referrer: 'https://www.facebook.com/posts/1' },
    localStorage: storage
  };
  const rec = attr.captureFromPage(win, storage);
  assert.equal(rec.utm_source, 'facebook');
  assert.equal(rec.utm_campaign, 'spring');
  assert.equal(rec.landing, '/terms');
  assert.equal(rec.referrer, 'www.facebook.com');
  assert.ok(rec.timestamp);
});

test('toCheckoutCustom flattens a record into string custom data', () => {
  const flat = attr.toCheckoutCustom({
    utm_source: 'tiktok',
    utm_medium: 'cpc',
    referrer: 'https://www.tiktok.com/@x',
    landing: '/',
    timestamp: '2026-11-27T20:00:00Z'
  });
  assert.deepEqual(flat, {
    utm_source: 'tiktok',
    utm_medium: 'cpc',
    attr_referrer: 'www.tiktok.com',
    attr_landing: '/',
    attr_ts: '2026-11-27T20:00:00Z'
  });
});

test('junk or non-object input is rejected', () => {
  assert.equal(attr.sanitizeRecord(null), null);
  assert.equal(attr.sanitizeRecord('reddit'), null);
  assert.equal(attr.sanitizeRecord(['utm_source']), null);
});

import fs from 'node:fs';

test('every public page loads attribution.js', () => {
  for (const f of ['index.html', 'privacy.html', 'terms.html', 'contact.html', 'refund.html']) {
    const html = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.ok(html.includes('attribution.js'), f + ' is missing attribution.js');
  }
});

test('no Google Analytics snippets were added, and the Meta Pixel snippet is unchanged in place', () => {
  for (const f of ['index.html', 'privacy.html', 'terms.html', 'contact.html', 'refund.html', 'app.js', 'attribution.js']) {
    const s = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.ok(!/googletagmanager|google-analytics\.com|gtag\s*\(/i.test(s), f + ' has a GA snippet');
  }
  const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(index.includes("fbq('init', '1425895313089708')"));
  assert.ok(index.includes("fbq('track', 'PageView')"));
});

test('throwing localStorage does not break get, capture, captureFromPage, or attachTo', () => {
  const boom = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); }
  };
  assert.equal(attr.get(boom), null);
  assert.equal(attr.capture({ utm_source: 'reddit' }, boom), null);
  const win = {
    location: { search: '?utm_source=reddit', pathname: '/' },
    document: { referrer: '' },
    localStorage: boom
  };
  assert.equal(attr.captureFromPage(win, boom), null);
  const body = attr.attachTo({ email: 'a@example.com' }, boom);
  assert.equal(body.email, 'a@example.com');
  assert.equal(body.attribution, undefined);
});

test('raw localStorage values larger than 4 KB are discarded before JSON.parse', () => {
  const storage = memoryStorage();
  storage.setItem(attr.STORAGE_KEY, '{"utm_source":"' + 'x'.repeat(5000) + '"}');
  assert.ok(storage.getItem(attr.STORAGE_KEY).length > 4096);
  assert.equal(attr.get(storage), null);
});

test('first-touch expires at 90 days; 89 keeps, 90 and 91 replace or clear', () => {
  const day = 24 * 60 * 60 * 1000;
  const iso = (offset) => new Date(Date.now() + offset).toISOString();

  const keep = memoryStorage();
  attr.capture({ utm_source: 'reddit', landing: '/', timestamp: iso(-89 * day) }, keep);
  const kept = attr.capture({ utm_source: 'tiktok', landing: '/later', timestamp: iso(0) }, keep);
  assert.equal(kept.utm_source, 'reddit');

  const at90 = memoryStorage();
  at90.setItem(attr.STORAGE_KEY, JSON.stringify({
    utm_source: 'reddit', landing: '/', timestamp: iso(-90 * day)
  }));
  const replaced = attr.capture({ utm_source: 'tiktok', landing: '/later', timestamp: iso(0) }, at90);
  assert.equal(replaced.utm_source, 'tiktok');

  const at91 = memoryStorage();
  at91.setItem(attr.STORAGE_KEY, JSON.stringify({
    utm_source: 'reddit', landing: '/', timestamp: iso(-91 * day)
  }));
  const replaced91 = attr.capture({ utm_source: 'facebook', landing: '/x', timestamp: iso(0) }, at91);
  assert.equal(replaced91.utm_source, 'facebook');

  const clear = memoryStorage();
  clear.setItem(attr.STORAGE_KEY, JSON.stringify({
    utm_source: 'reddit', landing: '/', timestamp: iso(-90 * day)
  }));
  const cleared = attr.capture({ landing: '/' }, clear);
  assert.equal(cleared, null);
  assert.equal(clear.getItem(attr.STORAGE_KEY), null);
});

test('missing, invalid, or future timestamps are treated as expired', () => {
  const storage = memoryStorage();
  storage.setItem(attr.STORAGE_KEY, JSON.stringify({ utm_source: 'reddit', landing: '/' }));
  const replaced = attr.capture({ utm_source: 'tiktok', landing: '/', timestamp: new Date().toISOString() }, storage);
  assert.equal(replaced.utm_source, 'tiktok');

  const future = memoryStorage();
  future.setItem(attr.STORAGE_KEY, JSON.stringify({
    utm_source: 'reddit', landing: '/', timestamp: new Date(Date.now() + 60 * 1000).toISOString()
  }));
  const replacedFuture = attr.capture({ utm_source: 'linkedin', landing: '/', timestamp: new Date().toISOString() }, future);
  assert.equal(replacedFuture.utm_source, 'linkedin');
});

test('captureFromPage reads UTM parameter names case-insensitively', () => {
  const storage = memoryStorage();
  const win = {
    location: { search: '?UTM_SOURCE=Reddit&Utm_Campaign=Spring', pathname: '/' },
    document: { referrer: '' },
    localStorage: storage
  };
  const rec = attr.captureFromPage(win, storage);
  assert.equal(rec.utm_source, 'reddit');
  assert.equal(rec.utm_campaign, 'spring');
});
