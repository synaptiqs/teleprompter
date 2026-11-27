/*
 * teleprompter-script-api
 * -----------------------
 * Cloudflare Worker for ClickPrompt (clickprompt.app).
 *
 * Free endpoints (no account needed):
 *   POST /api/generate-script   { name, role, audience, point, lengthSeconds,
 *                                 visitor_id?, token?, platform?, tone? }
 *                               -> { script, remaining, subscribed } via
 *                               Workers AI (Llama 3.3 70b).
 *                               FREE CAP (locked by Tyler, 2026-09-29): 3
 *                               script generations per day per visitor,
 *                               tracked by a first-party visitor cookie
 *                               (cp_vid, sent as visitor_id) with client IP
 *                               as fallback. Displayed as "3 free scripts
 *                               today". Subscribers (valid unlock token)
 *                               have no cap. Downloads stay free; the
 *                               paywall locks SAVING, not downloading.
 *                               429 + code "daily_limit" when the cap hits.
 *                               Thundering-herd guards: per-visitor reset
 *                               hours are staggered across 24h, identical
 *                               simultaneous prompts coalesce into one AI
 *                               call (5-min result cache), generation runs
 *                               behind a small concurrency pool, and a
 *                               per-IP short-window throttle sits in front.
 *
 * MCP connector endpoint (for Meta's Muse connector directory):
 *   POST /mcp                   JSON-RPC 2.0, stateless streamable HTTP.
 *                               Methods: initialize, tools/list, tools/call.
 *                               Tools: generate_script, check_unlock_status,
 *                               redeem_access_code, start_checkout,
 *                               list_scripts, save_script, delete_script.
 *
 * Paywalled: script SAVING (ClickPrompt Pro) is $3.99/month, $29/year,
 * or $59 lifetime via Lemon Squeezy (Synaptiq HQ store, product 1397885),
 * or free forever with an access code. Everything else stays free.
 * Stripe Checkout is also implemented, behind PAYMENT_PROVIDER, in TEST
 * mode only (see below). The live Worker stays on Lemon Squeezy until
 * Tyler flips the switch and deploys.
 *
 *   POST /api/checkout          { origin, plan, token?, attribution? }
 *                               -> { url, token }
 *                               plan is "monthly" | "yearly" | "lifetime".
 *                               Lemon Squeezy also accepts storage add-on
 *                               plans (storage250/500/1000) for existing
 *                               subscribers; the Stripe path does not.
 *                               Optional attribution is {utm_source,
 *                               utm_medium, utm_campaign, utm_content,
 *                               utm_term, referrer, landing, timestamp},
 *                               each sanitized, for first-touch UTM
 *                               from a sibling branch. PAYMENT_PROVIDER
 *                               chooses the path (default lemonsqueezy):
 *                                 lemonsqueezy: hosted LS checkout; needs
 *                                 LEMONSQUEEZY_API_KEY, STORE_ID, and the
 *                                 variant ID for the chosen plan.
 *                                 stripe: Stripe Checkout Session via REST
 *                                 (no SDK). Needs STRIPE_SECRET_KEY
 *                                 (sk_test_... unless STRIPE_ALLOW_LIVE=true,
 *                                 which only Tyler sets) and the price ID
 *                                 for the plan. Test catalog: monthly
 *                                 $3.99/month, yearly $29, lifetime $59
 *                                 (payment mode). Success/cancel URLs are
 *                                 on https://clickprompt.app.
 *   POST /api/webhook           Lemon Squeezy webhook events, verified with
 *                               LEMONSQUEEZY_WEBHOOK_SECRET (HMAC-SHA256 of
 *                               the raw body in the X-Signature header).
 *                               Keeps subscription/order state in KV keyed
 *                               by the opaque unlock token passed as
 *                               custom_data. subscription_* events drive
 *                               monthly/yearly; order_created drives the
 *                               lifetime one-time purchase. A cancelled
 *                               subscription keeps Pro until its paid
 *                               period ends (ends_at). Storage add-on purchases
 *                               (variant IDs in LEMONSQUEEZY_STORAGE_TIERS)
 *                               raise the identity's storage quota.
 *                               Cancellation starts the deletion sequence:
 *                               3 emails over 10 business days, then the
 *                               hard-delete cron removes everything.
 *   POST /api/stripe-webhook    Stripe webhook events, verified with
 *                               STRIPE_WEBHOOK_SECRET (HMAC-SHA256 of
 *                               "timestamp.payload" in Stripe-Signature,
 *                               with a 5-minute timestamp tolerance).
 *                               checkout.session.completed unlocks Pro
 *                               the same way order_created /
 *                               subscription_created do: KV record at
 *                               sub:<hex>, status "active" or "lifetime".
 *                               customer.subscription.updated and
 *                               customer.subscription.deleted keep that
 *                               record in sync (cancel keeps Pro until
 *                               current_period_end, then the same
 *                               deletion sequence). Grants only when
 *                               payment_status is "paid" or
 *                               "no_payment_required". Also handles
 *                               checkout.session.async_payment_succeeded
 *                               (grant) and async_payment_failed (no
 *                               grant, no revoke). Refunds and disputes
 *                               (full charge.refunded, and
 *                               charge.dispute.created) end Pro now, in
 *                               line with the refund policy. Partial
 *                               refunds keep access. A won or
 *                               warning_closed charge.dispute.closed
 *                               restores Pro when that dispute revoked
 *                               it, or applies a deferred checkout grant
 *                               if the paid session was skipped because
 *                               the dispute was already open. Any other
 *                               closed status, including lost or an
 *                               unknown value, leaves access ended and
 *                               starts the deletion clock. Live events
 *                               are accepted only when the secret key is
 *                               sk_live_ and STRIPE_ALLOW_LIVE is the
 *                               exact string "true".
 *   GET  /api/me?token=...     -> { unlocked, via } where via is
 *                               "subscription" | "lifetime" | "code" | null.
 *   POST /api/redeem            { code } -> { unlocked, token, via }.
 *                               Accepts a CLICK-XXXX-XXXX access code (unlocks
 *                               saving for life) OR the Lemon Squeezy license
 *                               key emailed on purchase (validated with the
 *                               public License API; must belong to the Pro
 *                               product). Throttled per IP.
 *   GET    /api/scripts?token=  List saved scripts for this identity.
 *   POST   /api/scripts        { token, title, body } -> save (upsert).
 *   DELETE /api/scripts?id=&token=  Delete one saved script.
 *   POST /api/event             { event } — client analytics counter
 *                               (generated, recording_started, download,
 *                               subscribe). No PII; increments a daily KV
 *                               counter.
 *
 * Paywalled the same way: saved VOICEOVERS (audio-only recordings).
 * Storage: 100 GB base quota per paid identity (video blobs metered;
 * scripts are negligible text), tiered add-ons to 1 TB via the storage
 * products. Audio bytes live in KV until R2 is enabled — the
 * audioPut/audioGet/audioDelete helpers are the seam: bind an R2 bucket
 * as VOICEOVER_AUDIO and they switch over, nothing else changes.
 *
 *   POST   /api/audio?token=..&title=..   Binary audio body -> save
 *                                         (quota-checked).
 *   GET    /api/audio?token=..            List saved voiceovers.
 *   GET    /api/audio?id=..&token=..      Download one voiceover (audio bytes).
 *   DELETE /api/audio?id=..&token=..      Delete one voiceover.
 *
 * Scheduled (cron — configure `triggers.crons = ["0 9 * * *"]` at deploy):
 *   hard-delete sweep: identities past their 10-business-day deletion
 *   window get every KV key destroyed (idempotent; logs timestamp +
 *   account id; writes an alert record on failure). Also sends the
 *   due deletion-sequence emails (day 0/5/10).
 *
 * Identity: the frontend stores one opaque token in localStorage:
 *   "code:CLICKXXXXXXXX" for legacy (unlimited-use) code users, "sub:<hex>"
 *   for subscribers (generated at checkout, matched back via checkout
 *   custom_data on the subscription_created webhook) and for limited-use
 *   giveaway codes (bound on first redemption), or "lic:<license key>" for
 *   buyers who entered their Lemon Squeezy license key. The Worker never
 *   trusts the client claim alone: codes are validated against hashed KV
 *   records, subscriptions against KV state written by the verified webhook,
 *   license keys against the Lemon Squeezy License API (cached in KV).
 *
 * KV layout (namespace bound as KV). Shard-ready: every per-identity key
 * is namespaced under a hash of the identity, so a future shard can be
 * chosen by key prefix without re-keying.
 *   code:<sha256("code:"+CODE)> -> { redeemed: bool, redeemed_at: number|null }
 *                              CODE = normalized code (uppercase, no dashes,
 *                              e.g. CLICKAB12CD34). Limited-use records also
 *                              carry { max_uses, uses, bound_token, tier,
 *                              batch }; legacy records without max_uses stay
 *                              unlimited-use.
 *   lic:<sha256("lic:"+key)> -> { ok, reason, status, product_id,
 *                              variant_id, lifetime, expires_at, checked_at }
 *                              (License API result cache, re-checked every
 *                              6 h; 30-day TTL)
 *   redeemthrottle:<10min>:<ip> -> redeem attempt count (20-min TTL)
 *   sub:<hex>             -> { status, ls_subscription_id, email?,
 *                              storage_tier_gb?, cancel_pending?, ends_at?,
 *                              delete_at?, deleted?, source?, updated_at,
 *                              stripe_subscription_id?, stripe_session_id?,
 *                              provider? }
 *   lssub:<lsSubId>       -> <hex>  (reverse map for later webhook events,
 *                              which may not carry custom_data)
 *   stripesub:<subId>     -> <hex>  (same reverse map for Stripe
 *                              subscription events)
 *   evt:<event_id>        -> { at }  (webhook idempotency; LS signs no
 *                              timestamp, so replays are deduped by id)
 *   scripts:<sha256(token)> -> [ { id, title, body, updatedAt } ]
 *   audio:<sha256(token)>   -> [ { id, title, size, contentType,
 *                              createdAt } ]  (voiceover metadata)
 *   audioblob:<sha256(token)>:<id> -> audio bytes (KV value, 25 MB max;
 *                              R2 object at audio/<hash>/<id> once bound)
 *   storage:<sha256("audio:"+token)> -> { bytes, updated_at } (quota acct)
 *   genlimit:<YYYY-MM-DD-HH>:<identity> -> generation count for the
 *                              visitor's staggered day window
 *                              (identity = v:<visitor_id> | ip:<ip> |
 *                              sub:<sha256(token)>; 2-day TTL)
 *   ipthrottle:<minute>:<ip> -> short-window request count (2-min TTL)
 *   genpool               -> in-flight AI call count (90s TTL, self-heals)
 *   genresult:<promptHash> -> { script, at } (5-min coalescing cache)
 *   geninflight:<promptHash> -> "1" (60s TTL leader lock)
 *   pcard:<platform>      -> { version, updated_at, uses, card } (platform
 *                              card; the KV record IS the cache — card reads
 *                              never trigger AI calls)
 *   pcard:<platform>:prev -> previous card version (fallback)
 *   delqueue:<YYYY-MM-DD> -> [hex...] (identities due for hard delete)
 *   delemail:<hex>        -> { email, sent1, sent2, sent3, delete_at }
 *   dellog:<hex>          -> { at, account, bytes_deleted } (audit trail)
 *   delalert:<ts>:<hex>   -> { error, at } (cron failure alerts)
 *   emaillog:<ts>:<rand>  -> { to, subject, text, at } (queued when no
 *                              email provider is configured)
 *   ev:<YYYY-MM-DD>:<event> -> analytics counter (90-day TTL)
 *
 * Secrets and vars (set via the Workers API; never commit values):
 *   PAYMENT_PROVIDER (var): "lemonsqueezy" | "stripe". Default
 *     lemonsqueezy, so the live site does not change until Tyler
 *     flips this and deploys.
 *   LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_WEBHOOK_SECRET,
 *   LEMONSQUEEZY_STORE_ID (Synaptiq HQ, 485773),
 *   LEMONSQUEEZY_VARIANT_ID (Pro Monthly; $3.99/month is set in Tyler's
 *     Lemon Squeezy dashboard, not in this code),
 *   LEMONSQUEEZY_VARIANT_ID_ANNUAL (Pro Annual $29/year; _YEARLY also accepted),
 *   LEMONSQUEEZY_VARIANT_ID_LIFETIME (Pro Lifetime $59 one-time),
 *   LEMONSQUEEZY_PRODUCT_ID (optional; Pro product for license-key checks,
 *     defaults to 1397885),
 *   LEMONSQUEEZY_STORAGE_TIERS (JSON map variantId -> GB, e.g.
 *     {"123":250,"124":500,"125":1000}),
 *   STRIPE_SECRET_KEY (test key starting with sk_test_; live sk_live_
 *     keys are refused unless STRIPE_ALLOW_LIVE=true, which only Tyler
 *     sets),
 *   STRIPE_WEBHOOK_SECRET (whsec_... from the Stripe test webhook),
 *   STRIPE_WEBHOOK_SECRET_PREV (optional previous secret, for rotation),
 *   STRIPE_PRICE_ID_MONTHLY, STRIPE_PRICE_ID_YEARLY (or _ANNUAL),
 *     STRIPE_PRICE_ID_LIFETIME (confirmed prices $3.99 / $29 / $59),
 *   STRIPE_ALLOW_LIVE (optional; only Tyler may set this to "true"),
 *   EMAIL_API_KEY + EMAIL_FROM (optional; without them, deletion emails
 *     are logged to KV instead of sent — wire a provider before launch)
 *
 * Bindings: AI (Workers AI), KV (this namespace),
 *   VOICEOVER_AUDIO (R2 bucket, optional until R2 is enabled).
 */

// Words per second for natural spoken delivery (~145 wpm).
var WORDS_PER_SECOND = 2.4;

// MODEL COST POLICY (locked by Tyler, 2026-09-28): script generation must
// run on a high-end free model or a very cheap premium model. Reference
// point: Llama 3.3 70B instruct fp8 fast at ~$0.003 per generation — that
// cost profile is what makes unlimited-AI economics work. Any future model
// swap must keep per-script cost under ~$0.01, or it comes back to Tyler
// for approval first. Do not drift this silently.
var MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// GENERATION FREE CAP (locked by Tyler, 2026-09-29 — brief with Grok;
// supersedes the 2026-09-28 30/day rule): 3 script generations per day
// per visitor, displayed as "3 free scripts today". Identity is the
// first-party visitor cookie (cp_vid, passed as visitor_id) with client
// IP as fallback. Subscribers (a valid unlock token) have NO cap — the
// token resolves via resolveUnlock, so paid, code, and lifetime users
// all bypass it. Failed AI calls don't consume quota.
var GENERATIONS_PER_DAY = 3;

// Thundering-herd §8: each visitor's "day" starts at a per-identity hour,
// spreading the reset load across 24 hours instead of one UTC-midnight
// spike. The window label is the UTC date+hour the window started.
async function resetHourFor(identity) {
  var h = await sha256Hex("reset:" + identity);
  return parseInt(h.slice(0, 2), 16) % 24;
}

function windowLabel(nowMs, resetHour) {
  var d = new Date(nowMs);
  var start = Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), resetHour
  );
  if (d.getUTCHours() < resetHour) start -= 86400000;
  var s = new Date(start);
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return s.getUTCFullYear() + "-" + p(s.getUTCMonth() + 1) + "-" +
    p(s.getUTCDate()) + "-" + p(s.getUTCHours());
}

function clientIp(request) {
  if (!request) return "unknown";
  return clean(request.headers.get("CF-Connecting-IP"), 45) || "unknown";
}

// Free-tier identity: visitor cookie first, IP fallback. Never throws.
async function generationIdentity(request, body) {
  body = body || {};
  var vid = clean(body.visitor_id, 64);
  if (/^[0-9a-f]{32}$/.test(vid)) return "v:" + vid;
  return "ip:" + clientIp(request);
}

// Returns { key, remaining, subscribed } or throws 429. remaining is -1
// for subscribers (uncapped). Callers must call recordGenerationSlot on
// success only.
async function generationSlot(env, request, body) {
  if (!env.KV) return { key: null, remaining: -1, subscribed: false };
  body = body || {};
  var token = clean(body.token, 64);
  var subscribed = false;
  var identity;
  if (token) {
    var st = await resolveUnlock(env, token);
    if (st.unlocked) {
      subscribed = true;
      identity = "sub:" + (await sha256Hex("genlimit:" + token));
    }
  }
  if (!subscribed) identity = await generationIdentity(request, body);
  var key = "genlimit:" + windowLabel(Date.now(), await resetHourFor(identity)) +
    ":" + identity;
  var count = Number(await env.KV.get(key)) || 0;
  if (!subscribed && count >= GENERATIONS_PER_DAY) {
    var err = new Error(
      "You've used your 3 free scripts today. Come back tomorrow — or go Pro for unlimited."
    );
    err.status = 429;
    err.code = "daily_limit";
    throw err;
  }
  return {
    key: key,
    identity: identity,
    remaining: subscribed ? -1 : Math.max(0, GENERATIONS_PER_DAY - count),
    subscribed: subscribed,
  };
}

async function recordGenerationSlot(env, slot) {
  if (!env.KV || !slot || !slot.key) return;
  var count = Number(await env.KV.get(slot.key)) || 0;
  // Keys expire after 2 days (auto-cleanup).
  await env.KV.put(slot.key, String(count + 1), { expirationTtl: 172800 });
}

// Per-IP short-window throttle (thundering-herd §8): 10 generate
// requests per minute per IP, separate from the daily free cap.
var IP_THROTTLE_MAX = 10;
async function checkIpThrottle(env, request) {
  if (!env.KV) return;
  var ip = clientIp(request);
  var key = "ipthrottle:" + Math.floor(Date.now() / 60000) + ":" + ip;
  var count = Number(await env.KV.get(key)) || 0;
  if (count >= IP_THROTTLE_MAX) {
    var err = new Error("Too many requests — slow down a moment and try again.");
    err.status = 429;
    err.code = "throttled";
    throw err;
  }
  await env.KV.put(key, String(count + 1), { expirationTtl: 120 });
}

// Redeem throttle: 10 code/license-key attempts per 10 minutes per IP, so
// access codes can't be brute-forced through /api/redeem or the MCP tool.
var REDEEM_THROTTLE_MAX = 10;
async function checkRedeemThrottle(env, request) {
  if (!env.KV || !request) return;
  var ip = clientIp(request);
  var key = "redeemthrottle:" + Math.floor(Date.now() / 600000) + ":" + ip;
  var count = Number(await env.KV.get(key)) || 0;
  if (count >= REDEEM_THROTTLE_MAX) {
    var err = new Error("Too many attempts. Wait a few minutes and try again.");
    err.status = 429;
    err.code = "throttled";
    throw err;
  }
  await env.KV.put(key, String(count + 1), { expirationTtl: 1200 });
}

// Concurrency pool (thundering-herd §8): best-effort KV semaphore capping
// simultaneous AI calls. 90s TTL self-heals leaked slots.
var GEN_POOL_MAX = 5;
async function acquireGenSlot(env) {
  if (!env.KV) return true;
  var count = Number(await env.KV.get("genpool")) || 0;
  if (count >= GEN_POOL_MAX) return false;
  await env.KV.put("genpool", String(count + 1), { expirationTtl: 90 });
  return true;
}

async function releaseGenSlot(env) {
  if (!env.KV) return;
  var count = Number(await env.KV.get("genpool")) || 0;
  if (count > 0) await env.KV.put("genpool", String(count - 1), { expirationTtl: 90 });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Request coalescing (thundering-herd §8): identical simultaneous prompts
// share one AI call. Fresh results (5 min) are served from cache; the
// first request becomes the leader and followers poll briefly.
async function promptHash(answers) {
  return sha256Hex(JSON.stringify([
    answers.name, answers.role, answers.audience, answers.point,
    answers.lengthSeconds, answers.tone, answers.platform,
  ]));
}

async function coalescedResult(env, ph) {
  if (!env.KV) return null;
  var cached = await env.KV.get("genresult:" + ph, "json");
  if (cached && cached.script && cached.at > Date.now() - 300000) {
    return { script: cached.script, cached: true };
  }
  if (await env.KV.get("geninflight:" + ph)) {
    for (var i = 0; i < 20; i++) {
      await sleep(500);
      var r = await env.KV.get("genresult:" + ph, "json");
      if (r && r.script) return { script: r.script, cached: true };
      if (!(await env.KV.get("geninflight:" + ph))) break;
    }
  }
  return null;
}

async function becomeLeader(env, ph) {
  if (!env.KV) return;
  await env.KV.put("geninflight:" + ph, "1", { expirationTtl: 60 });
}

async function publishResult(env, ph, script) {
  if (!env.KV) return;
  await env.KV.put(
    "genresult:" + ph,
    JSON.stringify({ script: script, at: Date.now() }),
    { expirationTtl: 300 }
  );
  await env.KV.delete("geninflight:" + ph);
}

// Lemon Squeezy statuses that count as "paid up". "lifetime" is written by
// the order_created webhook branch for one-time lifetime purchases and
// never expires.
var GOOD_STATUSES = { active: 1, on_trial: 1, lifetime: 1 };

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign(
      { "Content-Type": "application/json; charset=utf-8" },
      cors
    ),
  });
}

function clean(value, max) {
  return (value === undefined || value === null ? "" : String(value))
    .trim()
    .slice(0, max);
}

// ---- crypto helpers (WebCrypto, no dependencies) ----

function bytesToHex(bytes) {
  return Array.prototype.map
    .call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); })
    .join("");
}

async function sha256Hex(text) {
  var digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return bytesToHex(new Uint8Array(digest));
}

function randomHex(nBytes) {
  var a = new Uint8Array(nBytes);
  crypto.getRandomValues(a);
  return bytesToHex(a);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  var out = 0;
  for (var i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// Verify a Lemon Squeezy webhook signature: the X-Signature header carries
// the hex HMAC-SHA256 of the raw request body, keyed with the webhook
// signing secret. LS signs no timestamp, so replay protection is handled
// by event-id dedup in handleWebhook.
async function verifyLemonSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  var key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  var sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody)
  );
  return timingSafeEqual(
    bytesToHex(new Uint8Array(sig)),
    String(header).trim().toLowerCase()
  );
}

// ---- Lemon Squeezy REST (raw fetch; no SDK in Workers) ----

async function lemonPost(apiKey, path, payload) {
  var res = await fetch("https://api.lemonsqueezy.com" + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
    },
    body: JSON.stringify(payload),
  });
  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    var detail =
      (data.errors && data.errors[0] && data.errors[0].detail) ||
      "lemon squeezy error";
    var err = new Error(detail);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}


// ---- payment provider switch ----
// Default is Lemon Squeezy so the live Worker does not change until
// Tyler sets PAYMENT_PROVIDER=stripe and deploys. Unknown values also
// fall back to Lemon Squeezy.

function paymentProvider(env) {
  var raw = String((env && env.PAYMENT_PROVIDER) || "").trim().toLowerCase();
  if (raw === "stripe") return "stripe";
  return "lemonsqueezy";
}

// Keep referrer as a hostname only, and landing as a path only, so
// query strings never land in Stripe metadata.
function attributionHost(value) {
  var raw = clean(String(value || ""), 200);
  if (!raw) return "";
  var url;
  try {
    url = new URL(raw);
  } catch (e) {
    try { url = new URL("https://" + raw); } catch (e2) { return ""; }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  return url.hostname.toLowerCase();
}

function attributionPath(value) {
  var raw = clean(String(value || ""), 200);
  if (!raw) return "";
  var url;
  try {
    url = new URL(raw);
  } catch (e) {
    if (raw.charAt(0) === "/") {
      try { url = new URL("https://clickprompt.app" + raw); } catch (e2) { return ""; }
    } else {
      return "";
    }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  return url.pathname || "/";
}

// One sanitizer for POST /api/checkout attribution. Accepts the PR #14
// client shape (utm_source, utm_medium, utm_campaign, utm_content,
// utm_term, referrer, landing, timestamp) and the shorter aliases.
// UTM values may only use [A-Za-z0-9_.:/-]. Mapped keys become
// Stripe metadata attr_source, attr_medium, and so on. A later rebase
// onto #14 can replace this function with that PR's sanitizer.
var ATTRIBUTION_UTM_MAP = {
  utm_source: "source",
  utm_medium: "medium",
  utm_campaign: "campaign",
  utm_content: "content",
  utm_term: "term",
  source: "source",
  medium: "medium",
  campaign: "campaign",
  content: "content",
  term: "term"
};
var ATTRIBUTION_UTM_CHARS = /^[A-Za-z0-9_.:/-]+$/;

function sanitizeAttribution(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  var out = {};
  Object.keys(ATTRIBUTION_UTM_MAP).forEach(function (k) {
    if (input[k] == null) return;
    var v = clean(String(input[k]), 200);
    if (!v || !ATTRIBUTION_UTM_CHARS.test(v)) return;
    out[ATTRIBUTION_UTM_MAP[k]] = v;
  });
  var referrer = attributionHost(input.referrer);
  if (referrer) out.referrer = referrer;
  var landing = attributionPath(input.landing);
  if (landing) out.landing = landing;
  var ts = input.timestamp != null ? input.timestamp : input.ts;
  if (ts != null) {
    var tsv = clean(String(ts), 200);
    if (tsv && ATTRIBUTION_UTM_CHARS.test(tsv)) out.timestamp = tsv;
  }
  return Object.keys(out).length ? out : null;
}

function applyAttribution(target, attribution, prefix) {
  if (!attribution) return target;
  prefix = prefix || "attr_";
  Object.keys(attribution).forEach(function (k) {
    target[prefix + k] = attribution[k];
  });
  return target;
}

// ---- Stripe REST (raw fetch; no SDK in Workers) ----
// Test-mode only unless Tyler sets STRIPE_ALLOW_LIVE=true.

var STRIPE_API = "https://api.stripe.com/v1";
var STRIPE_API_VERSION = "2025-03-31.basil";
var STRIPE_SIGNATURE_TOLERANCE_SEC = 300;
var STRIPE_REQUEST_TIMEOUT_MS = 15000;
var STRIPE_WEBHOOK_MAX_BYTES = 1048576;
var STRIPE_EVENT_TTL_SEC = 60 * 86400;

var PLAN_PRICE_ENV = {
  monthly: "STRIPE_PRICE_ID_MONTHLY",
  yearly: ["STRIPE_PRICE_ID_YEARLY", "STRIPE_PRICE_ID_ANNUAL"],
  lifetime: "STRIPE_PRICE_ID_LIFETIME",
};

function planPriceId(env, plan) {
  var names = [].concat(PLAN_PRICE_ENV[plan] || []);
  for (var i = 0; i < names.length; i++) {
    var v = String(env[names[i]] || "").trim();
    if (v) return v;
  }
  return "";
}

var STRIPE_ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

// Read the Stripe secret, trimming whitespace and dropping zero-width
// characters. If hidden characters were present, the key is refused.
function readStripeSecretKey(env) {
  var raw = String((env && env.STRIPE_SECRET_KEY) || "");
  var trimmed = raw.trim();
  var stripped = trimmed.replace(STRIPE_ZERO_WIDTH, "");
  return { key: stripped, hiddenChars: stripped !== trimmed };
}

// Classify the secret: sk_live_/rk_live_ are live, sk_test_/rk_test_
// are test, and any other prefix is invalid and fails closed.
function stripeKeyMode(env) {
  var got = readStripeSecretKey(env);
  if (got.hiddenChars || !got.key) return "invalid";
  if (got.key.indexOf("sk_live_") === 0 || got.key.indexOf("rk_live_") === 0) return "live";
  if (got.key.indexOf("sk_test_") === 0 || got.key.indexOf("rk_test_") === 0) return "test";
  return "invalid";
}

// Refuse to call Stripe if the secret is a live key, unless Tyler has
// explicitly set STRIPE_ALLOW_LIVE=true. Unknown prefixes and hidden
// characters fail closed. The key itself is never logged or returned
// in an error. A live-key refusal is warned with no value.
function assertStripeTestMode(env) {
  var got = readStripeSecretKey(env);
  var mode = stripeKeyMode(env);
  if (mode === "invalid") {
    if (got.hiddenChars) {
      try { console.warn("stripe secret key refused"); } catch (e) {}
    }
    throw ApiError(503, "Checkout is not configured yet.");
  }
  if (mode === "live" && !stripeAllowLive(env)) {
    try { console.warn("stripe live key refused"); } catch (e) {}
    throw ApiError(
      503,
      "Stripe live keys are refused unless STRIPE_ALLOW_LIVE=true. Only Tyler sets that."
    );
  }
  return got.key;
}

function stripeAllowLive(env) {
  return String((env && env.STRIPE_ALLOW_LIVE) || "") === "true";
}

function stripeKeyIsLive(env) {
  return stripeKeyMode(env) === "live";
}

// Read a webhook signing secret, trimming whitespace and dropping
// zero-width characters. Hidden characters fail closed.
function readStripeWebhookSecret(secret) {
  var trimmed = String(secret || "").trim();
  var stripped = trimmed.replace(STRIPE_ZERO_WIDTH, "");
  return { secret: stripped, hiddenChars: stripped !== trimmed };
}

function stripeWebhookSecretOk(secret) {
  var got = readStripeWebhookSecret(secret);
  if (got.hiddenChars || !got.secret) return false;
  return got.secret.indexOf("whsec_") === 0;
}

// A live event is accepted only when the secret key is live
// (sk_live_ or rk_live_) and Tyler has set STRIPE_ALLOW_LIVE to the
// exact string "true". A test event (livemode false) is required when
// the key is sk_test_ or rk_test_. Any other key mode fails closed.
function stripeLivemodeAllowed(env, livemode) {
  var mode = stripeKeyMode(env);
  if (mode === "invalid") return false;
  if (livemode === true) return mode === "live" && stripeAllowLive(env);
  if (livemode === false) return mode === "test";
  return false;
}

// Success and cancel URLs always land on clickprompt.app, even if the
// request origin was a preview host.
function stripeReturnOrigin(origin) {
  origin = clean(origin, 120) || "https://clickprompt.app";
  try {
    var u = new URL(origin);
    var host = u.hostname.toLowerCase();
    if (host === "clickprompt.app" || host === "www.clickprompt.app") {
      return u.protocol + "//" + u.host;
    }
  } catch (e) {}
  return "https://clickprompt.app";
}

// Encode Checkout Session fields as application/x-www-form-urlencoded
// for the Stripe REST API. Empty values are omitted.
function stripeForm(params) {
  var body = new URLSearchParams();
  Object.keys(params).forEach(function (k) {
    if (params[k] != null && params[k] !== "") body.append(k, String(params[k]));
  });
  return body.toString();
}

// Build the x-www-form-urlencoded body for POST /v1/checkout/sessions.
// Monthly and yearly are subscriptions; lifetime and storage add-ons are
// one-time payments. Attribution, when present, is copied into session
// metadata (and subscription or payment-intent metadata) as attr_* keys.
function buildStripeCheckoutForm(opts) {
  var token = opts.token;
  var plan = opts.plan;
  var params = {
    mode: opts.mode,
    "line_items[0][price]": opts.priceId,
    "line_items[0][quantity]": "1",
    "payment_method_types[0]": "card",
    success_url: opts.origin + "/?checkout=done",
    cancel_url: opts.origin + "/?checkout=cancel",
    client_reference_id: token,
    "metadata[unlock_token]": token,
    "metadata[plan]": plan,
  };
  // Only prefill email when we already have it on the identity.
  // Never invent an email or take one from the client.
  if (opts.customerEmail) params.customer_email = opts.customerEmail;
  if (opts.storageGb) params["metadata[storage_gb]"] = String(opts.storageGb);
  if (opts.attribution) {
    Object.keys(opts.attribution).forEach(function (k) {
      params["metadata[attr_" + k + "]"] = opts.attribution[k];
    });
  }
  if (opts.mode === "subscription") {
    params["subscription_data[metadata][unlock_token]"] = token;
    params["subscription_data[metadata][plan]"] = plan;
    if (opts.attribution) {
      Object.keys(opts.attribution).forEach(function (k) {
        params["subscription_data[metadata][attr_" + k + "]"] = opts.attribution[k];
      });
    }
  } else {
    params["payment_intent_data[metadata][unlock_token]"] = token;
    params["payment_intent_data[metadata][plan]"] = plan;
    if (opts.storageGb) {
      params["payment_intent_data[metadata][storage_gb]"] = String(opts.storageGb);
    }
    if (opts.attribution) {
      Object.keys(opts.attribution).forEach(function (k) {
        params["payment_intent_data[metadata][attr_" + k + "]"] = opts.attribution[k];
      });
    }
  }
  return stripeForm(params);
}

// Call the Stripe REST API with the pinned Basil version, an optional
// idempotency key (session creates only), and a timeout so a hung
// request fails cleanly. The secret is sent only as a Bearer header
// and is never logged.
async function stripeRequest(secret, method, path, formBody, idempotencyKey) {
  var headers = {
    Authorization: "Bearer " + secret,
    "Content-Type": "application/x-www-form-urlencoded",
    "Stripe-Version": STRIPE_API_VERSION,
  };
  if (idempotencyKey) headers["Idempotency-Key"] = String(idempotencyKey);
  var res = await fetch(STRIPE_API + path, {
    method: method,
    headers: headers,
    body: formBody || undefined,
    signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
  });
  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    var msg = (data.error && data.error.message) || "stripe error";
    var err = new Error(msg);
    err.status = res.status;
    err.stripeCode = data.error && data.error.code;
    throw err;
  }
  return data;
}

// HMAC-SHA-256 of a message, returned as lowercase hex. Used to
// verify the Stripe-Signature header. The message may be a string
// or a Uint8Array of raw body bytes; webhook verification always
// signs the raw bytes, never a decoded string.
async function hmacSha256Hex(secret, message) {
  var key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  var data = message instanceof Uint8Array
    ? message
    : new TextEncoder().encode(String(message || ""));
  var sig = await crypto.subtle.sign("HMAC", key, data);
  return bytesToHex(new Uint8Array(sig));
}

// Stripe-Signature header is "t=<unix>,v1=<hex>[,v1=...]". The signed
// payload is "timestamp.rawBody". Reject signatures older (or newer)
// than toleranceSec (default 300). nowMs is injectable for tests.
async function verifyStripeSignature(rawBody, header, secret, nowMs, toleranceSec) {
  if (!header || !secret) return false;
  var timestamp = "";
  var signatures = [];
  String(header).split(",").forEach(function (part) {
    var cut = part.indexOf("=");
    if (cut < 1) return;
    var k = part.slice(0, cut).trim();
    var v = part.slice(cut + 1).trim();
    if (k === "t") timestamp = v;
    else if (k === "v1") signatures.push(v.toLowerCase());
  });
  if (!timestamp || !signatures.length) return false;
  if (!/^[0-9]+$/.test(timestamp)) return false;
  var ts = Number(timestamp);
  if (!ts) return false;
  var tolerance = (toleranceSec == null ? STRIPE_SIGNATURE_TOLERANCE_SEC : Number(toleranceSec)) * 1000;
  var now = nowMs == null ? Date.now() : nowMs;
  if (Math.abs(now - ts * 1000) > tolerance) return false;
  // Sign timestamp + "." + raw body bytes. If the caller passed a
  // string (unit tests), encode it as UTF-8; live webhooks pass the
  // unread-decoded body bytes from readLimitedBody.
  var bodyBytes = rawBody instanceof Uint8Array
    ? rawBody
    : new TextEncoder().encode(String(rawBody || ""));
  var prefix = new TextEncoder().encode(timestamp + ".");
  var signed = new Uint8Array(prefix.length + bodyBytes.length);
  signed.set(prefix, 0);
  signed.set(bodyBytes, prefix.length);
  var expected = await hmacSha256Hex(secret, signed);
  for (var i = 0; i < signatures.length; i++) {
    if (timingSafeEqual(expected, signatures[i])) return true;
  }
  return false;
}

function stripeSubHex(token) {
  if (typeof token !== "string") return null;
  if (token.indexOf("sub:") === 0 && /^[0-9a-f]{32}$/.test(token.slice(4))) {
    return token.slice(4);
  }
  return null;
}

function stripeStatusFromSubscription(sub) {
  var status = String((sub && sub.status) || "");
  if (status === "canceled") return "cancelled";
  if (status === "trialing") return "on_trial";
  if (status === "active") {
    if (sub.cancel_at_period_end) return "cancelled";
    return "active";
  }
  return status || "unknown";
}

// Billing-period end for a subscription. API version 2025-03-31.basil
// removed current_period_end from the Subscription object and added it
// on each SubscriptionItem; see
// https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
// We still honor a top-level value if an older webhook sends one, then
// fall back to the latest item current_period_end. cancel_at wins when
// Stripe will stop access earlier.
function stripePeriodEndUnix(sub) {
  var cancelAt = Number((sub && sub.cancel_at) || 0);
  if (cancelAt) return cancelAt;
  var top = Number((sub && sub.current_period_end) || 0);
  if (top) return top;
  var items = sub && sub.items && sub.items.data;
  if (!items || !items.length) return 0;
  var max = 0;
  for (var i = 0; i < items.length; i++) {
    var end = Number(items[i] && items[i].current_period_end) || 0;
    if (end > max) max = end;
  }
  return max;
}

function stripeEndsAt(sub) {
  var unix = stripePeriodEndUnix(sub);
  if (!unix) return null;
  return new Date(unix * 1000).toISOString();
}


// Build and send a Stripe Checkout Session for the chosen plan. Test
// mode is required unless Tyler sets STRIPE_ALLOW_LIVE to the exact
// string "true". Client errors stay generic; Stripe's message is
// logged server-side without the secret or the request body.
function isStripeCheckoutPlan(plan) {
  return plan === "monthly" || plan === "yearly" || plan === "lifetime";
}

async function emailForUnlockToken(env, token) {
  token = clean(token, 64);
  if (!env.KV || !token || token.indexOf("sub:") !== 0) return "";
  var hex = token.slice(4);
  if (!/^[0-9a-f]{32}$/.test(hex)) return "";
  var rec = await env.KV.get("sub:" + hex, "json");
  return clean((rec && rec.email) || "", 120);
}

// Build and send a Stripe Checkout Session for an exact plan
// (monthly, yearly, or lifetime). Test mode is required unless
// Tyler sets STRIPE_ALLOW_LIVE to the exact string "true". Client
// errors stay generic; Stripe's message is logged server-side
// without the secret or the request body.
async function doStripeCheckout(env, origin, plan, existingToken, attribution) {
  var secret = assertStripeTestMode(env);
  origin = stripeReturnOrigin(origin);

  // Exact allowlist only. No case folding, no "annual" alias, and no
  // silent default to monthly. The Lemon Squeezy path is unchanged.
  if (!isStripeCheckoutPlan(plan)) {
    throw ApiError(400, "That plan isn't available.");
  }

  var token = "sub:" + randomHex(16);
  var priceId = planPriceId(env, plan);
  var mode = plan === "lifetime" ? "payment" : "subscription";
  if (!priceId) {
    throw ApiError(503, "That plan isn't available yet. Try the monthly plan.");
  }

  var customerEmail = await emailForUnlockToken(env, existingToken);

  var form = buildStripeCheckoutForm({
    mode: mode,
    priceId: priceId,
    origin: origin,
    token: token,
    plan: plan,
    storageGb: 0,
    attribution: attribution,
    customerEmail: customerEmail,
  });

  try {
    var session = await stripeRequest(secret, "POST", "/checkout/sessions", form, "cp_checkout_" + token);
  } catch (e) {
    try {
      console.log("stripe checkout failed", {
        status: e && e.status,
        code: e && e.stripeCode,
        message: e && e.message,
      });
    } catch (ignore) {}
    throw ApiError(502, "Could not start checkout. Try again.");
  }
  if (!session || !session.url) {
    throw ApiError(502, "Could not start checkout. Try again.");
  }
  return { url: session.url, token: token };
}

// Once a Stripe subscription id is bound to an unlock token, that
// mapping is permanent. A later metadata.unlock_token that disagrees
// is ignored (and logged without the token) so a second identity
// cannot be unlocked.
async function bindStripeSub(env, stripeSubId, claimedHex) {
  if (!env.KV || !stripeSubId) return claimedHex || null;
  var existing = await env.KV.get("stripesub:" + stripeSubId);
  if (existing) {
    if (claimedHex && existing !== claimedHex) {
      try { console.log("stripe unlock_token does not match stored mapping"); } catch (e) {}
    }
    return existing;
  }
  if (claimedHex) {
    await env.KV.put("stripesub:" + stripeSubId, claimedHex);
    return claimedHex;
  }
  return null;
}

async function rememberStripeSub(env, stripeSubId, hex) {
  return bindStripeSub(env, stripeSubId, hex);
}

// Store reverse maps from Stripe IDs back to our unlock hex so refund
// and dispute events can find the identity without extra API calls.
async function rememberStripeIds(env, hex, ids) {
  if (!env.KV || !hex || !ids) return;
  if (ids.subscription) await bindStripeSub(env, ids.subscription, hex);
  if (ids.session) await env.KV.put("stripesession:" + ids.session, hex);
  if (ids.paymentIntent) await env.KV.put("stripepi:" + ids.paymentIntent, hex);
  if (ids.customer) await env.KV.put("stripecust:" + ids.customer, hex);
  if (ids.invoice) await env.KV.put("stripeinv:" + ids.invoice, hex);
  if (ids.charge) await env.KV.put("stripecharge:" + ids.charge, hex);
  // Remember payment_intent for an invoice so a later charge.refunded
  // that only carries the invoice id can still tombstone the PI.
  if (ids.invoice && ids.paymentIntent) {
    await env.KV.put("stripe:invpi:" + ids.invoice, ids.paymentIntent);
  }
}

function stripeRefId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value.id) return String(value.id);
  return "";
}

// Look up our unlock hex from IDs on a Stripe object (payment_intent,
// charge, invoice, subscription, session, or customer). Used for
// non-revoke events such as invoice.paid. Customer mappings are
// stored but are not used to revoke access.
async function hexFromStripeRefs(env, obj) {
  if (!env.KV || !obj) return null;
  var meta = obj.metadata || {};
  var hex = stripeSubHex(meta.unlock_token);
  if (hex) return hex;
  var keys = [];
  var pi = stripeRefId(obj.payment_intent);
  var ch = stripeRefId(obj.charge) || (obj.object === "charge" ? String(obj.id || "") : "");
  var inv = stripeRefId(obj.invoice);
  var sub = stripeRefId(obj.subscription);
  var sess = obj.object === "checkout.session" ? String(obj.id || "") : "";
  var cus = stripeRefId(obj.customer);
  if (pi) keys.push("stripepi:" + pi);
  if (ch) keys.push("stripecharge:" + ch);
  if (inv) keys.push("stripeinv:" + inv);
  if (sub) keys.push("stripesub:" + sub);
  if (sess) keys.push("stripesession:" + sess);
  if (cus) keys.push("stripecust:" + cus);
  for (var i = 0; i < keys.length; i++) {
    var found = await env.KV.get(keys[i]);
    if (found) return found;
  }
  return null;
}

// Look up our unlock hex for a refund or dispute. Charge,
// payment_intent, invoice, session, and subscription mappings are
// used. Customer id is never authoritative for a revoke, so two
// purchases on the same customer cannot revoke each other.
async function hexFromStripeRevokeRefs(env, obj) {
  if (!env.KV || !obj) return null;
  var keys = [];
  var pi = stripeRefId(obj.payment_intent);
  var ch = stripeRefId(obj.charge) || (obj.object === "charge" ? String(obj.id || "") : "");
  var inv = stripeRefId(obj.invoice) || (obj.object === "invoice" ? String(obj.id || "") : "");
  var sub = stripeRefId(obj.subscription);
  var sess = stripeRefId(obj.checkout_session) || (obj.object === "checkout.session" ? String(obj.id || "") : "");
  if (pi) keys.push("stripepi:" + pi);
  if (ch) keys.push("stripecharge:" + ch);
  if (inv) keys.push("stripeinv:" + inv);
  if (sess) keys.push("stripesession:" + sess);
  if (sub) keys.push("stripesub:" + sub);
  for (var i = 0; i < keys.length; i++) {
    var found = await env.KV.get(keys[i]);
    if (found) return found;
  }
  return null;
}

// A full refund is a charge with refunded === true, or with
// amount_refunded at least as large as amount. Partial refunds
// keep access. When currency is present it must be usd. When
// currency is missing and amount fields are present, those
// amounts are compared as usd. When currency and amount fields
// are all missing, refunded === true is still enough to revoke.
function isFullStripeRefund(charge) {
  if (!charge) return false;
  var currency = String(charge.currency || "").toLowerCase();
  if (currency && currency !== "usd") return false;
  var hasAmount = charge.amount != null && charge.amount !== "";
  var hasRefunded = charge.amount_refunded != null && charge.amount_refunded !== "";
  if (hasAmount || hasRefunded) {
    var amount = Number(charge.amount);
    var refundedAmt = Number(charge.amount_refunded);
    if (!isFinite(amount) || amount <= 0 || !isFinite(refundedAmt)) return false;
    return refundedAmt >= amount;
  }
  return charge.refunded === true;
}

async function hexFromStripeSubscription(env, sub, metadata) {
  var meta = metadata || (sub && sub.metadata) || {};
  var customToken = meta.unlock_token;
  var hex = stripeSubHex(customToken);
  var stripeSubId = String((sub && sub.id) || "");
  var existing = (env.KV && stripeSubId) ? await env.KV.get("stripesub:" + stripeSubId) : null;
  if (existing) {
    if (hex && existing !== hex) {
      try { console.log("stripe unlock_token does not match stored mapping"); } catch (e) {}
    }
    await rememberStripeIds(env, existing, {
      subscription: stripeSubId,
      customer: stripeRefId(sub && sub.customer),
    });
    return existing;
  }
  // Do not bind a new stripesub:<id> here. Only a paid checkout
  // that already passed payment and catalog checks may create
  // that mapping. Return the token hex so a later paid bind, or
  // a cancel/delete against an existing record, can still find
  // the identity.
  return hex || null;
}

function isSubscriberRecord(rec) {
  if (!rec || !rec.status) return false;
  return rec.status === "active" || rec.status === "on_trial" || rec.status === "cancelled" || !!rec.cancel_pending || !!rec.stripe_subscription_id || !!rec.ls_subscription_id;
}

// Ignore an event whose Stripe created timestamp is older than the
// last applied event on this subscription, and ignore grants after
// the identity has been deleted. Events that would clear a cancel
// or restore access also lose on a created-timestamp tie, so a
// revoke at the same second wins.
function shouldIgnoreOlderEvent(prev, eventCreated, restoresAccess) {
  if (!prev) return false;
  if (prev.deleted) return true;
  var last = Number(prev.last_event_created) || 0;
  var incoming = Number(eventCreated) || 0;
  if (!last || !incoming) return false;
  if (restoresAccess) return incoming <= last;
  return incoming < last;
}

// A full refund, an open or lost dispute, or a deleted subscription
// is terminal. A later subscription.updated must not restore Pro
// unless the subscription id is genuinely new.
function stripeRecordIsTerminal(prev) {
  if (!prev) return false;
  if (prev.subscription_deleted) return true;
  if (prev.status === "refunded" && (prev.revoke_reason === "refund" || prev.revoke_reason === "dispute")) {
    return true;
  }
  return false;
}

// A subscription id counts as new only when stripesub:<id> is already
// bound to this hex by a paid checkout.session.completed (payment and
// catalog checks passed). A missing previous subscription id is not
// treated as new, so a refunded lifetime cannot be restored by a
// loose subscription.updated.
async function isPaidBoundNewSubscription(env, prev, sub, hex) {
  var incoming = String((sub && sub.id) || "");
  if (!incoming || !hex || !env.KV) return false;
  var bound = await env.KV.get("stripesub:" + incoming);
  if (bound !== hex) return false;
  var prevId = String((prev && prev.stripe_subscription_id) || "");
  if (!prevId) return false;
  return incoming !== prevId;
}

function stampLastEvent(rec, eventCreated) {
  var incoming = Number(eventCreated) || 0;
  if (incoming) rec.last_event_created = incoming;
  rec.updated_at = Date.now();
}

// Skip a checkout.session grant when the record is already cancelled,
// refunded, or deleted, or when a newer event has already been applied.
function shouldSkipCheckoutGrant(prev, eventCreated) {
  if (!prev || !prev.status) return false;
  if (prev.deleted) return true;
  if (prev.status === "cancelled" || prev.status === "expired" || prev.status === "refunded" || prev.cancel_pending) {
    return true;
  }
  return shouldIgnoreOlderEvent(prev, eventCreated, true);
}

// Apply a Stripe subscription event to the same KV record shape Lemon
// Squeezy uses, so resolveUnlock / cancel-keeps-Pro / deletion all work
// unchanged. Stripe spells it "canceled"; we store "cancelled".
// Subscription updated/deleted events are the source of truth for status.
async function applyStripeSubscription(env, sub, eventCreated, eventType) {
  if (!env.KV || !sub) return;
  var stripeSubId = String((sub && sub.id) || "");
  var isDeletedEvent = eventType === "customer.subscription.deleted";
  // Even when no sub: record exists yet, a deleted subscription id
  // is tombstoned so a later checkout or subscription grant for
  // this id is skipped.
  if (isDeletedEvent && stripeSubId) {
    await env.KV.put(
      "stripe:deleted:" + stripeSubId,
      JSON.stringify({ at: Date.now() }),
      { expirationTtl: STRIPE_EVENT_TTL_SEC }
    );
  }
  var hex = await hexFromStripeSubscription(env, sub, sub.metadata);
  if (!hex) return;
  var subKey = "sub:" + hex;
  var prev = (await env.KV.get(subKey, "json")) || {};
  if (prev.deleted) return;
  var effectiveStatus = stripeStatusFromSubscription(sub);
  var isCancel = isDeletedEvent || effectiveStatus === "cancelled" || effectiveStatus === "expired";
  var wouldRestore = !isCancel;
  // Do not create a grant from subscription.updated or .deleted
  // unless a paid checkout already bound this subscription id.
  if (!prev.status) {
    var paidBound = (env.KV && stripeSubId) ? await env.KV.get("stripesub:" + stripeSubId) : null;
    if (paidBound !== hex) return;
  }
  if (wouldRestore) {
    if (stripeSubId && (await env.KV.get("stripe:deleted:" + stripeSubId))) return;
    var plan = planFromStripeSubscription(env, sub);
    if (!stripeSubscriptionItemsMatchCatalog(env, plan, sub)) {
      try { console.log("stripe subscription items do not match catalog"); } catch (e) {}
      return;
    }
  }
  if (stripeRecordIsTerminal(prev) && !(await isPaidBoundNewSubscription(env, prev, sub, hex))) return;
  if (shouldIgnoreOlderEvent(prev, eventCreated, wouldRestore)) return;
  var rec = {
    status: effectiveStatus,
    ls_subscription_id: prev.ls_subscription_id || null,
    stripe_subscription_id: String(sub.id || prev.stripe_subscription_id || "") || null,
    email: clean((sub.customer_email || (prev.email || "")), 120) || prev.email || null,
    storage_tier_gb: prev.storage_tier_gb || 100,
    cancel_pending: !!prev.cancel_pending,
    ends_at: stripeEndsAt(sub) || prev.ends_at || null,
    delete_at: prev.delete_at || null,
    source: prev.source || "stripe",
    provider: "stripe",
    updated_at: Date.now(),
    subscription_deleted: isDeletedEvent ? true : false,
    revoke_reason: null,
    revoke_dispute_id: null,
  };
  stampLastEvent(rec, eventCreated);
  var wasActive = !prev.cancel_pending && (prev.status === "active" || prev.status === "on_trial" || !prev.status);
  if (isCancel && wasActive) {
    var accessEndsAt = Math.max(Date.now(), Date.parse(rec.ends_at || "") || 0);
    var deleteAt = addBusinessDays(accessEndsAt, 10);
    rec.cancel_pending = true;
    rec.delete_at = deleteAt;
    await env.KV.put(subKey, JSON.stringify(rec));
    try {
      await scheduleDeletion(env, hex, rec.email, deleteAt, accessEndsAt);
    } catch (e) {}
  } else if (!isCancel) {
    if (rec.cancel_pending) {
      rec.cancel_pending = false;
      rec.delete_at = null;
      try { await cancelDeletion(env, hex); } catch (e) {}
    }
    await env.KV.put(subKey, JSON.stringify(rec));
  } else {
    await env.KV.put(subKey, JSON.stringify(rec));
  }
}

// Collect price ids from an expanded line_items list. Returns null
// when the list is missing so the caller can fetch it.
function stripeSessionPriceIds(session) {
  if (!session || !session.line_items || !Array.isArray(session.line_items.data)) return null;
  var ids = [];
  session.line_items.data.forEach(function (item) {
    var price = item && item.price;
    var id = typeof price === "string" ? price : (price && price.id) || "";
    if (id) ids.push(String(id));
  });
  return ids;
}

// True when every line-item price id matches the env catalog price
// for the given plan. Unknown or mismatched prices grant nothing.
function stripePricesMatchPlan(env, plan, priceIds) {
  if (!isStripeCheckoutPlan(plan) || !priceIds || !priceIds.length) return false;
  var expected = planPriceId(env, plan);
  if (!expected) return false;
  for (var i = 0; i < priceIds.length; i++) {
    if (priceIds[i] !== expected) return false;
  }
  return true;
}

function expectedPlanAmountCents(env, plan) {
  var names = {
    monthly: "STRIPE_PRICE_AMOUNT_MONTHLY",
    yearly: ["STRIPE_PRICE_AMOUNT_YEARLY", "STRIPE_PRICE_AMOUNT_ANNUAL"],
    lifetime: "STRIPE_PRICE_AMOUNT_LIFETIME",
  };
  var keys = [].concat(names[plan] || []);
  for (var i = 0; i < keys.length; i++) {
    var raw = String((env && env[keys[i]]) || "").trim();
    if (!raw) continue;
    var n = Number(raw);
    if (isFinite(n) && n > 0) return n;
  }
  return null;
}

// In addition to a matching price id, a grant requires currency usd
// and quantity 1. When STRIPE_PRICE_AMOUNT_* is set, the line
// price.unit_amount must be present and equal to that catalog
// amount in cents. unit_amount is the catalog price, so it is
// not affected by tax or a promo. amount_total (session or line)
// is not compared, so a discounted or tax-inclusive total can
// still grant. When those env vars are unset, only currency and
// quantity are compared.
function stripeLineItemsMatchCatalog(env, plan, items) {
  if (!isStripeCheckoutPlan(plan) || !items || !items.length) return false;
  var expectedPrice = planPriceId(env, plan);
  if (!expectedPrice) return false;
  var expectedAmount = expectedPlanAmountCents(env, plan);
  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {};
    var price = item.price;
    var priceId = typeof price === "string" ? price : (price && price.id) || "";
    if (priceId !== expectedPrice) return false;
    var currency = String(item.currency || (price && price.currency) || "").toLowerCase();
    if (currency !== "usd") return false;
    if (Number(item.quantity) !== 1) return false;
    if (expectedAmount != null) {
      if (!price || typeof price === "string" || price.unit_amount == null || price.unit_amount === "") {
        return false;
      }
      if (Number(price.unit_amount) !== expectedAmount) return false;
    }
  }
  return true;
}

function stripeSubscriptionItemList(sub) {
  if (!sub || !sub.items || !Array.isArray(sub.items.data)) return null;
  return sub.items.data;
}

// Prefer metadata.plan when it is a known checkout plan. Otherwise
// infer the plan from a catalog price id on the subscription items.
function planFromStripeSubscription(env, sub) {
  var metaPlan = String((sub && sub.metadata && sub.metadata.plan) || "");
  if (isStripeCheckoutPlan(metaPlan) && planPriceId(env, metaPlan)) return metaPlan;
  var items = stripeSubscriptionItemList(sub) || [];
  var plans = ["monthly", "yearly", "lifetime"];
  for (var i = 0; i < items.length; i++) {
    var price = items[i] && items[i].price;
    var priceId = typeof price === "string" ? price : (price && price.id) || "";
    for (var p = 0; p < plans.length; p++) {
      if (priceId && planPriceId(env, plans[p]) === priceId) return plans[p];
    }
  }
  return metaPlan;
}

function stripeSubscriptionItemsMatchCatalog(env, plan, sub) {
  return stripeLineItemsMatchCatalog(env, plan, stripeSubscriptionItemList(sub));
}

function stripeSessionLineItems(session) {
  if (!session || !session.line_items || !Array.isArray(session.line_items.data)) return null;
  return session.line_items.data;
}

// A failed expand that looks transient (timeout, network error,
// 429, or 5xx) must not be treated as a price mismatch. The
// caller skips the dedupe write and returns 500 so Stripe retries.
// A 4xx other than 429 (for example a 404 for a deleted session)
// is a permanent miss: the caller logs a mismatch, returns 200,
// and writes the dedupe key, same as a catalog mismatch. A
// successful fetch, including one that returns no usable line
// items, is also a genuine mismatch.
function isStripeTransientExpandError(err) {
  var status = Number(err && err.status);
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  if (status >= 400 && status <= 499) return false;
  return true;
}

async function resolveStripeSessionLineItems(env, session) {
  var items = stripeSessionLineItems(session);
  if (items) return { items: items, amountTotal: session.amount_total };
  var sid = session && session.id;
  if (!sid) return { items: [], amountTotal: session && session.amount_total };
  var got = readStripeSecretKey(env);
  if (got.hiddenChars || !got.key) {
    var cfg = new Error("Checkout is not configured yet.");
    cfg.status = 500;
    cfg.transient = true;
    throw cfg;
  }
  try {
    var path = "/checkout/sessions/" + encodeURIComponent(sid) + "?expand[]=line_items";
    var expanded = await stripeRequest(got.key, "GET", path);
    return {
      items: stripeSessionLineItems(expanded) || [],
      amountTotal: expanded.amount_total != null ? expanded.amount_total : (session && session.amount_total),
    };
  } catch (e) {
    try { console.log("stripe session expand failed"); } catch (ignore) {}
    if (!isStripeTransientExpandError(e)) {
      return { items: [], amountTotal: session && session.amount_total };
    }
    var err = new Error("Could not verify checkout price.");
    err.status = 500;
    err.transient = true;
    throw err;
  }
}

async function resolveStripeSessionPriceIds(env, session) {
  var got = await resolveStripeSessionLineItems(env, session);
  var ids = [];
  (got.items || []).forEach(function (item) {
    var price = item && item.price;
    var id = typeof price === "string" ? price : (price && price.id) || "";
    if (id) ids.push(String(id));
  });
  return ids;
}

// Grant Pro from a Checkout Session only when payment_status is exactly
// "paid" or "no_payment_required", metadata.plan is a catalog plan, and
// every line-item price id matches the env price for that plan. Lifetime
// is granted only when metadata.plan is "lifetime", and a subscriber
// record is never overwritten by a lifetime grant.
// Write a paid Checkout grant to KV. Used by checkout.session.completed
// and by a later won or warning_closed dispute that applies a deferred
// grant. email may be null (deferred grants never store email).
async function writeStripePaidGrant(env, opts) {
  if (!env.KV || !opts || !opts.hex) return;
  var hex = opts.hex;
  var ids = opts.ids || {};
  var email = opts.email || null;
  var eventCreated = opts.eventCreated;
  var mode = opts.mode;
  var plan = opts.plan;
  var subKey = "sub:" + hex;
  var prev = (await env.KV.get(subKey, "json")) || {};
  if (prev.deleted) return;
  if (mode === "subscription") {
    if (stripeRecordIsTerminal(prev)) {
      if (!ids.subscription || ids.subscription === String(prev.stripe_subscription_id || "")) return;
    } else if (shouldSkipCheckoutGrant(prev, eventCreated)) {
      return;
    }
    await bindStripeSub(env, ids.subscription, hex);
    await rememberStripeIds(env, hex, ids);
    var rec = {
      status: "active",
      stripe_subscription_id: ids.subscription || prev.stripe_subscription_id || null,
      stripe_session_id: ids.session || prev.stripe_session_id || null,
      email: email || prev.email || null,
      storage_tier_gb: prev.storage_tier_gb || 100,
      cancel_pending: false,
      ends_at: null,
      delete_at: null,
      source: "stripe",
      provider: "stripe",
      updated_at: Date.now(),
      subscription_deleted: false,
      revoke_reason: null,
      revoke_dispute_id: null,
      revoke_prior_status: null,
    };
    stampLastEvent(rec, eventCreated);
    try { await cancelDeletion(env, hex); } catch (e) {}
    await env.KV.put(subKey, JSON.stringify(rec));
    return;
  }
  if (mode === "payment") {
    if (plan !== "lifetime") return;
    if (stripeRecordIsTerminal(prev)) {
      if (ids.session && prev.stripe_session_id && ids.session === prev.stripe_session_id) return;
    } else {
      if (shouldSkipCheckoutGrant(prev, eventCreated)) return;
      if (isSubscriberRecord(prev)) return;
    }
    await rememberStripeIds(env, hex, ids);
    var lifeRec = {
      status: "lifetime",
      stripe_session_id: ids.session || "",
      email: email || prev.email || null,
      storage_tier_gb: Number(prev.storage_tier_gb) || 100,
      source: "stripe",
      provider: "stripe",
      updated_at: Date.now(),
      cancel_pending: false,
      delete_at: null,
      subscription_deleted: false,
      revoke_reason: null,
      revoke_dispute_id: null,
      revoke_prior_status: null,
    };
    stampLastEvent(lifeRec, eventCreated);
    try { await cancelDeletion(env, hex); } catch (e) {}
    await env.KV.put(subKey, JSON.stringify(lifeRec));
  }
}

async function applyStripeCheckoutSession(env, session, eventCreated) {
  if (!env.KV || !session) return;
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
    return;
  }
  var meta = session.metadata || {};
  var plan = String(meta.plan || "");
  var resolved = await resolveStripeSessionLineItems(env, session);
  var priceIds = [];
  (resolved.items || []).forEach(function (item) {
    var price = item && item.price;
    var id = typeof price === "string" ? price : (price && price.id) || "";
    if (id) priceIds.push(String(id));
  });
  if (!stripePricesMatchPlan(env, plan, priceIds) || !stripeLineItemsMatchCatalog(env, plan, resolved.items)) {
    try { console.log("stripe checkout price does not match catalog"); } catch (e) {}
    return;
  }
  var token = meta.unlock_token || session.client_reference_id || "";
  var email = clean(
    ((session.customer_details && session.customer_details.email) || session.customer_email || ""),
    120
  ) || null;
  var ids = {
    session: String(session.id || ""),
    paymentIntent: stripeRefId(session.payment_intent),
    customer: stripeRefId(session.customer),
    invoice: stripeRefId(session.invoice),
    subscription: typeof session.subscription === "string"
      ? session.subscription
      : (session.subscription && session.subscription.id) || "",
    charge: stripeRefId(session.payment_intent && session.payment_intent.latest_charge) || stripeRefId(session.latest_charge) || stripeRefId(session.charge),
  };
  var claimed = stripeSubHex(token);
  var existingBind = (env.KV && ids.subscription) ? await env.KV.get("stripesub:" + ids.subscription) : null;
  if (existingBind && claimed && existingBind !== claimed) {
    try { console.log("stripe unlock_token does not match stored mapping"); } catch (e) {}
  }
  var hex = (session.mode === "subscription") ? (existingBind || claimed) : claimed;
  if (session.mode === "payment" && plan !== "lifetime") return;
  if (!hex) return;

  if (ids.subscription && (await env.KV.get("stripe:deleted:" + ids.subscription))) {
    try { console.log("stripe checkout skipped because the subscription was already deleted"); } catch (e) {}
    return;
  }
  if (await sessionHasRefundTombstone(env, ids)) {
    try { console.log("stripe checkout skipped because of a refund tombstone"); } catch (e) {}
    return;
  }
  if (await sessionHasBlockingDispute(env, ids)) {
    // Paid and catalog-ok, but an open dispute arrived first. Store a
    // deferred grant keyed by payment_intent (and charge/invoice when
    // present) so a later won or warning_closed close can grant. Signed
    // ids only; no email or other PII. Refund tombstones do not take
    // this path.
    await writePendingStripeGrant(env, ids, {
      plan: plan,
      hex: hex,
      mode: session.mode,
      created: eventCreated,
    });
    try { console.log("stripe checkout deferred because of an open dispute"); } catch (e) {}
    return;
  }

  if (session.mode === "subscription" || session.mode === "payment") {
    await writeStripePaidGrant(env, {
      hex: hex,
      ids: ids,
      mode: session.mode,
      plan: plan,
      email: email,
      eventCreated: eventCreated,
    });
  }
}

// Pending state for out-of-order webhooks. An event that would be a
// no-op only because its target identity does not exist yet must not
// be forgotten after a 200 + stripe:evt: write. Full refunds write
// stripe:refunded:<payment_intent|charge|invoice> (60-day TTL).
// Disputes write stripe:dispute:<dispute_id> (status + created) and
// stripe:disputed:<payment_intent|charge|invoice>. A paid checkout
// skipped because a dispute is already open writes
// stripe:grant:<payment_intent|charge|invoice> (signed ids only, no
// email, 60-day TTL). A subscription.deleted with no record writes
// stripe:deleted:<sub_id> (60-day TTL). A later checkout grant
// consults those keys. If an event has no identity and no
// attachable id, the webhook returns 5xx without a dedupe write so
// Stripe retries.
function stripePendingRefKeys(prefix, obj) {
  var keys = [];
  var pi = stripeRefId(obj && obj.payment_intent);
  var ch = stripeRefId(obj && obj.charge) || ((obj && obj.object === "charge") ? String(obj.id || "") : "");
  var inv = stripeRefId(obj && obj.invoice) || ((obj && obj.object === "invoice") ? String(obj.id || "") : "");
  if (pi) keys.push(prefix + pi);
  if (ch) keys.push(prefix + ch);
  if (inv) keys.push(prefix + inv);
  return keys;
}

// Resolve refund tombstone ids. We always tombstone charge and
// invoice when they are present. When payment_intent is missing,
// look it up from an expanded invoice.payment_intent, from
// stripe:invpi:<invoice> written at grant time, or by fetching
// the invoice from Stripe. If the PI still cannot be resolved,
// the invoice tombstone alone is enough to skip a later checkout
// that carries the same invoice id.
async function resolveStripeRefundRefs(env, obj) {
  var paymentIntent = stripeRefId(obj && obj.payment_intent);
  var charge = stripeRefId(obj && obj.charge) || ((obj && obj.object === "charge") ? String(obj.id || "") : "");
  var invoice = stripeRefId(obj && obj.invoice) || ((obj && obj.object === "invoice") ? String(obj.id || "") : "");
  if (paymentIntent) {
    return { payment_intent: paymentIntent, charge: charge, invoice: invoice };
  }
  var invObj = obj && obj.invoice;
  var fromObj = (invObj && typeof invObj === "object") ? stripeRefId(invObj.payment_intent) : "";
  if (fromObj) {
    return { payment_intent: fromObj, charge: charge, invoice: invoice };
  }
  if (invoice && env && env.KV) {
    var stored = await env.KV.get("stripe:invpi:" + invoice);
    if (stored) {
      return { payment_intent: stored, charge: charge, invoice: invoice };
    }
  }
  if (invoice) {
    try {
      var got = readStripeSecretKey(env);
      if (got && got.key && !got.hiddenChars) {
        var fetched = await stripeRequest(got.key, "GET", "/invoices/" + encodeURIComponent(invoice));
        var pi = stripeRefId(fetched && fetched.payment_intent);
        if (pi) return { payment_intent: pi, charge: charge, invoice: invoice };
      }
    } catch (e) {
      try { console.log("stripe invoice payment_intent lookup failed"); } catch (ignore) {}
    }
  }
  return { payment_intent: paymentIntent, charge: charge, invoice: invoice };
}

async function writeStripeRefundTombstones(env, obj) {
  if (!env.KV || !obj) return [];
  var resolved = await resolveStripeRefundRefs(env, obj);
  var probe = {
    payment_intent: resolved.payment_intent,
    charge: resolved.charge || obj.charge,
    invoice: resolved.invoice || obj.invoice,
    object: obj.object,
    id: obj.id,
  };
  var keys = stripePendingRefKeys("stripe:refunded:", probe);
  for (var i = 0; i < keys.length; i++) {
    await env.KV.put(keys[i], JSON.stringify({ at: Date.now() }), { expirationTtl: STRIPE_EVENT_TTL_SEC });
  }
  return keys;
}

// Store a deferred paid checkout so a later won or warning_closed
// dispute can grant if the session was skipped because a dispute
// was already open. Keyed by payment_intent, charge, and invoice.
// Signed ids only; no email or other PII.
async function writePendingStripeGrant(env, ids, grant) {
  if (!env.KV || !grant || !grant.hex) return [];
  var probe = {
    payment_intent: ids && ids.paymentIntent,
    charge: ids && ids.charge,
    invoice: ids && ids.invoice,
  };
  var keys = stripePendingRefKeys("stripe:grant:", probe);
  var payload = JSON.stringify({
    plan: String(grant.plan || ""),
    hex: String(grant.hex),
    mode: String(grant.mode || ""),
    session: (ids && ids.session) || "",
    subscription: (ids && ids.subscription) || "",
    payment_intent: (ids && ids.paymentIntent) || "",
    charge: (ids && ids.charge) || "",
    invoice: (ids && ids.invoice) || "",
    created: Number(grant.created) || 0,
  });
  for (var i = 0; i < keys.length; i++) {
    await env.KV.put(keys[i], payload, { expirationTtl: STRIPE_EVENT_TTL_SEC });
  }
  return keys;
}

async function readPendingStripeGrant(env, obj) {
  if (!env.KV || !obj) return null;
  var keys = stripePendingRefKeys("stripe:grant:", obj);
  for (var i = 0; i < keys.length; i++) {
    var got = await env.KV.get(keys[i], "json");
    if (got && got.hex) return got;
  }
  return null;
}

async function applyPendingStripeGrant(env, pending, eventCreated) {
  if (!env.KV || !pending || !pending.hex) return;
  var ids = {
    session: pending.session || "",
    paymentIntent: pending.payment_intent || "",
    invoice: pending.invoice || "",
    subscription: pending.subscription || "",
    charge: pending.charge || "",
    customer: "",
  };
  if (ids.subscription && (await env.KV.get("stripe:deleted:" + ids.subscription))) return;
  if (await sessionHasRefundTombstone(env, ids)) return;
  await writeStripePaidGrant(env, {
    hex: pending.hex,
    ids: ids,
    mode: pending.mode,
    plan: pending.plan,
    email: null,
    eventCreated: eventCreated,
  });
}

async function writeStripeDisputeRefs(env, dispute, status, eventCreated) {
  if (!env.KV || !dispute) return [];
  var keys = stripePendingRefKeys("stripe:disputed:", dispute);
  var payload = JSON.stringify({
    status: String(status || ""),
    created: Number(eventCreated) || 0,
    dispute_id: String(dispute.id || ""),
  });
  for (var i = 0; i < keys.length; i++) {
    await env.KV.put(keys[i], payload, { expirationTtl: STRIPE_EVENT_TTL_SEC });
  }
  return keys;
}

async function sessionHasRefundTombstone(env, ids) {
  if (!env.KV || !ids) return false;
  var probe = {
    payment_intent: ids.paymentIntent,
    charge: ids.charge,
    invoice: ids.invoice,
  };
  var refundKeys = stripePendingRefKeys("stripe:refunded:", probe);
  for (var i = 0; i < refundKeys.length; i++) {
    if (await env.KV.get(refundKeys[i])) return true;
  }
  return false;
}

async function sessionHasBlockingDispute(env, ids) {
  if (!env.KV || !ids) return false;
  var probe = {
    payment_intent: ids.paymentIntent,
    charge: ids.charge,
    invoice: ids.invoice,
  };
  var disputeKeys = stripePendingRefKeys("stripe:disputed:", probe);
  for (var i = 0; i < disputeKeys.length; i++) {
    var st = await env.KV.get(disputeKeys[i], "json");
    if (st && !disputeStatusRestoresAccess(st.status)) return true;
  }
  return false;
}

async function sessionHasOpenDisputeOrRefund(env, ids) {
  return (await sessionHasRefundTombstone(env, ids)) || (await sessionHasBlockingDispute(env, ids));
}

async function readStripeDisputeState(env, disputeId) {
  if (!env.KV || !disputeId) return null;
  return await env.KV.get("stripe:dispute:" + disputeId, "json");
}

async function writeStripeDisputeState(env, disputeId, status, eventCreated) {
  if (!env.KV || !disputeId) return;
  await env.KV.put(
    "stripe:dispute:" + disputeId,
    JSON.stringify({ status: String(status || ""), created: Number(eventCreated) || 0 }),
    { expirationTtl: STRIPE_EVENT_TTL_SEC }
  );
}

function disputeStatusIsClosed(status) {
  var s = String(status || "");
  return s === "won" || s === "lost" || s === "warning_closed";
}

// won and warning_closed restore access. Every other closed
// status, including lost and any unknown value, takes the lost
// path (record stays revoked and the deletion clock starts).
function disputeStatusRestoresAccess(status) {
  var s = String(status || "");
  return s === "won" || s === "warning_closed";
}

// If a refund or dispute cannot be attached to an identity or a
// payment/charge/invoice id, tell the caller to skip dedupe and
// return 5xx so Stripe retries.
function stripePendingNeedsRetry(obj, wroteKeys) {
  return !(wroteKeys && wroteKeys.length);
}

// A full refund ends Pro for that purchase now, matching the refund
// policy. An open dispute pauses Pro but does not start the
// 10-business-day deletion clock; that clock starts only when the
// dispute closes lost, so a later won dispute can still restore.
// Partial refunds do not call this.
async function applyStripeRevoke(env, obj, eventCreated, reason) {
  if (!env.KV || !obj) return;
  var hex = await hexFromStripeRevokeRefs(env, obj);
  if (!hex) return;
  var subKey = "sub:" + hex;
  var prev = (await env.KV.get(subKey, "json")) || {};
  if (!prev.status || prev.status === "refunded" || prev.deleted) return;
  if (shouldIgnoreOlderEvent(prev, eventCreated, false)) return;
  var accessEndsAt = Date.now();
  var deleteAt = addBusinessDays(accessEndsAt, 10);
  var rec = {
    status: "refunded",
    ls_subscription_id: prev.ls_subscription_id || null,
    stripe_subscription_id: prev.stripe_subscription_id || null,
    stripe_session_id: prev.stripe_session_id || null,
    email: prev.email || null,
    storage_tier_gb: prev.storage_tier_gb || 100,
    cancel_pending: true,
    ends_at: new Date(accessEndsAt).toISOString(),
    delete_at: deleteAt,
    source: prev.source || "stripe",
    provider: prev.provider || "stripe",
    updated_at: Date.now(),
    revoke_reason: reason || "refund",
    revoke_dispute_id: reason === "dispute" ? String(obj.id || prev.revoke_dispute_id || "") || null : null,
    revoke_prior_status: prev.status,
  };
  stampLastEvent(rec, eventCreated);
  if (reason === "dispute") {
    rec.delete_at = null;
    rec.cancel_pending = false;
    await env.KV.put(subKey, JSON.stringify(rec));
    return;
  }
  await env.KV.put(subKey, JSON.stringify(rec));
  try {
    await scheduleDeletion(env, hex, rec.email, deleteAt, accessEndsAt);
  } catch (e) {}
}

// Apply a dispute.created event. A created event older than a stored
// closed event for the same dispute id is ignored, so an out-of-order
// won close is not overwritten. Open disputes pause Pro but do not
// start hard deletion.
async function applyStripeDisputeCreated(env, dispute, eventCreated) {
  if (!env.KV || !dispute) return { wrotePending: false };
  var disputeId = String(dispute.id || "");
  var prevState = await readStripeDisputeState(env, disputeId);
  if (prevState && disputeStatusIsClosed(prevState.status) && Number(prevState.created) >= Number(eventCreated)) {
    return { wrotePending: true, ignored: true };
  }
  if (disputeId) await writeStripeDisputeState(env, disputeId, String(dispute.status || "open"), eventCreated);
  var refs = await writeStripeDisputeRefs(env, dispute, String(dispute.status || "open"), eventCreated);
  await applyStripeRevoke(env, dispute, eventCreated, "dispute");
  var hex = await hexFromStripeRevokeRefs(env, dispute);
  return { wrotePending: !!(refs.length || hex || disputeId) };
}

// A won or warning_closed dispute restores Pro when this record
// was revoked by that same dispute. If there is no sub: record,
// apply a deferred checkout grant stored when a paid session was
// skipped because the dispute was already open. A lost close, or
// any other or unknown close status, starts the 10-business-day
// deletion clock and leaves access ended.
async function applyStripeDisputeClosed(env, dispute, eventCreated) {
  if (!env.KV || !dispute) return { wrotePending: false };
  var disputeId = String(dispute.id || "");
  var status = String(dispute.status || "");
  var prevState = await readStripeDisputeState(env, disputeId);
  if (prevState && Number(prevState.created) > Number(eventCreated)) {
    return { wrotePending: true, ignored: true };
  }
  if (disputeId) await writeStripeDisputeState(env, disputeId, status, eventCreated);
  var refs = await writeStripeDisputeRefs(env, dispute, status, eventCreated);
  var hex = await hexFromStripeRevokeRefs(env, dispute);
  if (disputeStatusRestoresAccess(status)) {
    var restored = false;
    if (hex) {
      var subKey = "sub:" + hex;
      var prev = (await env.KV.get(subKey, "json")) || {};
      if (!prev.deleted && prev.revoke_reason === "dispute") {
        if (!prev.revoke_dispute_id || !disputeId || prev.revoke_dispute_id === disputeId) {
          if (!shouldIgnoreOlderEvent(prev, eventCreated, true)) {
            var rec = {
              status: prev.revoke_prior_status || (prev.stripe_subscription_id ? "active" : "lifetime"),
              ls_subscription_id: prev.ls_subscription_id || null,
              stripe_subscription_id: prev.stripe_subscription_id || null,
              stripe_session_id: prev.stripe_session_id || null,
              email: prev.email || null,
              storage_tier_gb: prev.storage_tier_gb || 100,
              cancel_pending: false,
              ends_at: prev.revoke_prior_status === "lifetime" ? null : prev.ends_at || null,
              delete_at: null,
              source: prev.source || "stripe",
              provider: prev.provider || "stripe",
              updated_at: Date.now(),
              revoke_reason: null,
              revoke_dispute_id: null,
              revoke_prior_status: null,
            };
            stampLastEvent(rec, eventCreated);
            try { await cancelDeletion(env, hex); } catch (e) {}
            await env.KV.put(subKey, JSON.stringify(rec));
            restored = true;
          }
        }
      }
    }
    if (!restored) {
      var existing = hex ? ((await env.KV.get("sub:" + hex, "json")) || {}) : {};
      if (!existing.status) {
        var pending = await readPendingStripeGrant(env, dispute);
        if (pending) await applyPendingStripeGrant(env, pending, eventCreated);
      }
    }
  } else {
    if (status !== "lost") {
      try { console.log("stripe dispute closed with unhandled status", status || "(empty)"); } catch (e) {}
    }
    if (hex) {
      var lostKey = "sub:" + hex;
      var lostPrev = (await env.KV.get(lostKey, "json")) || {};
      if (lostPrev.status && lostPrev.status !== "refunded" && !lostPrev.deleted) {
        await applyStripeRevoke(env, dispute, eventCreated, "refund");
        lostPrev = (await env.KV.get(lostKey, "json")) || lostPrev;
      }
      if (lostPrev.status === "refunded" && !lostPrev.deleted && !lostPrev.delete_at) {
        if (!lostPrev.revoke_dispute_id || !disputeId || lostPrev.revoke_dispute_id === disputeId) {
          var accessEndsAt = Date.now();
          var deleteAt = addBusinessDays(accessEndsAt, 10);
          lostPrev.delete_at = deleteAt;
          lostPrev.cancel_pending = true;
          lostPrev.ends_at = lostPrev.ends_at || new Date(accessEndsAt).toISOString();
          stampLastEvent(lostPrev, eventCreated);
          await env.KV.put(lostKey, JSON.stringify(lostPrev));
          try {
            await scheduleDeletion(env, hex, lostPrev.email, deleteAt, accessEndsAt);
          } catch (e) {}
        }
      }
    }
  }
  return { wrotePending: !!(refs.length || hex || disputeId) };
}

// Reject oversized webhook bodies before parsing. Stream with
// getReader(), count bytes, and cancel as soon as the total exceeds
// maxBytes, even if Content-Length is missing or lies.
async function readLimitedBody(request, maxBytes) {
  function tooBig() {
    var err = new Error("Payload too large.");
    err.status = 413;
    return err;
  }
  var len = request.headers.get("Content-Length");
  if (len !== null && len !== "" && /^\d+$/.test(String(len).trim()) && Number(len) > maxBytes) {
    if (request.body && typeof request.body.cancel === "function") {
      try { await request.body.cancel(); } catch (e) {}
    }
    throw tooBig();
  }

  var reader = request.body && typeof request.body.getReader === "function"
    ? request.body.getReader()
    : null;
  var chunks = [];
  var total = 0;
  if (reader) {
    while (true) {
      var step = await reader.read();
      if (step.done) break;
      var value = step.value || new Uint8Array(0);
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch (e) {}
        throw tooBig();
      }
      chunks.push(value);
    }
  } else {
    var buf = await request.arrayBuffer();
    if (buf.byteLength > maxBytes) throw tooBig();
    chunks.push(new Uint8Array(buf));
    total = buf.byteLength;
  }

  var bytes = new Uint8Array(total);
  var offset = 0;
  chunks.forEach(function (c) {
    bytes.set(c, offset);
    offset += c.byteLength;
  });
  return bytes;
}

// Verify the Stripe signature (current secret, then the previous one
// during rotation), reject live events unless Tyler has allowed them,
// then update entitlements. No CORS headers are added by the caller.
// Bad signatures return 400. Empty event ids are rejected. Dedupe keys
// use the stripe:evt: prefix and expire after 60 days. A transient
// failure during processing skips that write and returns 5xx so
// Stripe retries.
// Read-then-write race: two deliveries of the same event can both see a
// miss and both apply. The KV put is last-write-wins, and entitlement
// writes are meant to be idempotent. A compare-and-swap is not available
// on this KV binding.
async function handleStripeWebhook(request, env, cors) {
  cors = cors || {};
  if (!stripeWebhookSecretOk(env.STRIPE_WEBHOOK_SECRET)) {
    return json({ error: "STRIPE_WEBHOOK_SECRET is missing or invalid." }, 503, cors);
  }
  if (stripeKeyMode(env) === "invalid") {
    return json({ error: "Checkout is not configured yet." }, 503, cors);
  }

  try {
    var rawBytes = await readLimitedBody(request, STRIPE_WEBHOOK_MAX_BYTES);
  } catch (e) {
    if (e && e.status === 413) return json({ error: "Payload too large." }, 413, cors);
    throw e;
  }
  var raw = new TextDecoder("utf-8").decode(rawBytes);

  var sig = request.headers.get("Stripe-Signature");
  var secrets = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_PREV]
    .map(readStripeWebhookSecret)
    .filter(function (got) { return !got.hiddenChars && got.secret.indexOf("whsec_") === 0; })
    .map(function (got) { return got.secret; });
  var signed = false;
  for (var i = 0; i < secrets.length; i++) {
    if (await verifyStripeSignature(rawBytes, sig, secrets[i])) {
      signed = true;
      break;
    }
  }
  if (!signed) {
    return json({ error: "Bad signature." }, 400, cors);
  }

  var event;
  try {
    event = JSON.parse(raw);
  } catch (e) {
    return json({ error: "Bad payload." }, 400, cors);
  }
  var eventId = String((event && event.id) || "").trim();
  if (!eventId) {
    return json({ error: "Missing event id." }, 400, cors);
  }
  var eventCreated = Number(event && event.created);
  if (!isFinite(eventCreated) || eventCreated <= 0) {
    return json({ error: "Missing event created." }, 400, cors);
  }
  if (!stripeLivemodeAllowed(env, event.livemode)) {
    return json({ error: "Event mode is not allowed." }, 400, cors);
  }
  if (!env.KV) return json({ error: "KV is not configured." }, 500, cors);

  var dedupeKey = "stripe:evt:" + eventId;
  var seen = await env.KV.get(dedupeKey);
  if (seen) return json({ received: true, duplicate: true }, 200, cors);

  var type = String(event.type || "");
  var obj = (event.data && event.data.object) || {};

  // Transient failures during processing (expand timeout, 5xx, 429,
  // or network errors) must not write the dedupe key, so Stripe can
  // retry. Only a completed apply, including a genuine price
  // mismatch, returns 200 and records the event id.
  try {
    if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
      await applyStripeCheckoutSession(env, obj, eventCreated);
    } else if (type === "checkout.session.async_payment_failed") {
      // Neither grant nor revoke. An unpaid or still-pending session
      // must not unlock Pro, and a failed async payment must not take
      // away an already-active entitlement.
    } else if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
      await applyStripeSubscription(env, obj, eventCreated, type);
    } else if (type === "refund.created") {
      try { console.log("stripe refund.created ignored"); } catch (e) {}
    } else if (type === "charge.refunded") {
      if (isFullStripeRefund(obj)) {
        var refundKeys = await writeStripeRefundTombstones(env, obj);
        await applyStripeRevoke(env, obj, eventCreated, "refund");
        var refundHex = await hexFromStripeRevokeRefs(env, obj);
        if (stripePendingNeedsRetry(obj, refundKeys) && !refundHex) {
          var refundRetry = new Error("Could not process event. Try again.");
          refundRetry.status = 500;
          refundRetry.transient = true;
          throw refundRetry;
        }
      }
    } else if (type === "charge.dispute.created") {
      var createdOut = await applyStripeDisputeCreated(env, obj, eventCreated);
      if (!createdOut || !createdOut.wrotePending) {
        var createdRetry = new Error("Could not process event. Try again.");
        createdRetry.status = 500;
        createdRetry.transient = true;
        throw createdRetry;
      }
    } else if (type === "charge.dispute.closed") {
      var closedOut = await applyStripeDisputeClosed(env, obj, eventCreated);
      if (!closedOut || !closedOut.wrotePending) {
        var closedRetry = new Error("Could not process event. Try again.");
        closedRetry.status = 500;
        closedRetry.transient = true;
        throw closedRetry;
      }
    } else if (type === "invoice.paid" || type === "invoice.payment_succeeded") {
      var hex = await hexFromStripeRefs(env, obj);
      if (hex) {
        await rememberStripeIds(env, hex, {
          paymentIntent: stripeRefId(obj.payment_intent),
          invoice: String(obj.id || ""),
          charge: stripeRefId(obj.charge),
          subscription: stripeRefId(obj.subscription),
          customer: stripeRefId(obj.customer),
        });
      }
    }
    // All other event types are acknowledged and ignored.

    await env.KV.put(
      dedupeKey,
      JSON.stringify({ at: Date.now() }),
      { expirationTtl: STRIPE_EVENT_TTL_SEC }
    );
    return json({ received: true }, 200, cors);
  } catch (e) {
    try { console.log("stripe webhook processing failed"); } catch (ignore) {}
    var status = Number(e && e.status) || 500;
    if (status < 500 || status > 599) status = 500;
    return json({ error: "Could not process event. Try again." }, status, cors);
  }
}

// ---- identity / unlock logic ----

function normalizeCode(code) {
  return clean(code, 32).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function codeIsRedeemed(env, code) {
  if (!env.KV) return false;
  var hash = await sha256Hex("code:" + code);
  var rec = await env.KV.get("code:" + hash, "json");
  return !!(rec && rec.redeemed);
}

function subRecordIsGood(rec) {
  if (!rec || rec.deleted) return false;
  if (GOOD_STATUSES[rec.status]) return true;
  // A cancelled subscription keeps Pro until the end of the period it paid
  // for (Lemon Squeezy's ends_at); LS then sends subscription_expired.
  if (rec.status === "cancelled" && rec.ends_at) {
    var ends = Date.parse(rec.ends_at);
    if (ends && ends > Date.now()) return true;
  }
  return false;
}

async function subscriptionIsGood(env, hex) {
  if (!env.KV || !hex) return false;
  var rec = await env.KV.get("sub:" + hex, "json");
  return subRecordIsGood(rec);
}

// ---- Lemon Squeezy license keys (public License API, no API key) ----
// Buyers get a license key by email on every ClickPrompt Pro purchase
// (monthly, yearly, lifetime). Entering it in the redeem box unlocks Pro
// on any device. The key must belong to the Pro product. Subscription keys
// stay "active" until the subscription expires (i.e. through the paid
// period after a cancel), then become "expired", which re-locks Pro.

var PRO_PRODUCT_ID_DEFAULT = "1397885";
var LICENSE_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var LICENSE_RECHECK_MS = 6 * 3600 * 1000;   // re-validate every 6 hours
var LICENSE_GRACE_MS = 7 * 86400 * 1000;    // honor a good result this long if LS is down

function proProductId(env) {
  return String(env.LEMONSQUEEZY_PRODUCT_ID || PRO_PRODUCT_ID_DEFAULT).trim();
}

function normalizeLicenseKey(value) {
  var k = clean(value, 64).toLowerCase();
  return LICENSE_KEY_RE.test(k) ? k : "";
}

async function licenseKvKey(key) {
  return "lic:" + (await sha256Hex("lic:" + key));
}

// One License API validate call (no instance_id, so no activation slot is
// used). Returns a cache record, or null when Lemon Squeezy is unreachable.
async function checkLicenseWithLemon(env, key) {
  var res;
  try {
    res = await fetch("https://api.lemonsqueezy.com/v1/licenses/validate", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "license_key=" + encodeURIComponent(key),
    });
  } catch (e) {
    return null;
  }
  if (res.status >= 500 || res.status === 429) return null;
  var d = await res.json().catch(function () { return null; });
  if (!d) return null;
  var lk = d.license_key || {};
  var meta = d.meta || {};
  var variantId = meta.variant_id != null ? String(meta.variant_id) : null;
  var lifetimeVariant = String(env.LEMONSQUEEZY_VARIANT_ID_LIFETIME || "").trim();
  var rec = {
    ok: false,
    reason: "",
    status: lk.status || null,
    product_id: meta.product_id != null ? String(meta.product_id) : null,
    variant_id: variantId,
    lifetime:
      (!!lifetimeVariant && variantId === lifetimeVariant) ||
      /lifetime/i.test(String(meta.variant_name || "")),
    expires_at: lk.expires_at || null,
    checked_at: Date.now(),
  };
  if (!d.valid && !lk.status) rec.reason = "invalid";
  else if (rec.product_id !== proProductId(env)) rec.reason = "wrong_product";
  else if (rec.status !== "active" && rec.status !== "inactive") rec.reason = "status_" + rec.status;
  else if (rec.expires_at && Date.parse(rec.expires_at) <= Date.now()) rec.reason = "expired";
  else if (!d.valid) rec.reason = "invalid";
  else rec.ok = true;
  return rec;
}

async function resolveLicense(env, key, force) {
  if (!env.KV) return { ok: false, reason: "no_kv" };
  var kvKey = await licenseKvKey(key);
  var cached = await env.KV.get(kvKey, "json");
  var now = Date.now();
  if (cached && !force) {
    var stale = now - (Number(cached.checked_at) || 0) >= LICENSE_RECHECK_MS;
    var lapsed = cached.ok && cached.expires_at && Date.parse(cached.expires_at) <= now;
    if (!stale && !lapsed) return cached;
  }
  var rec = await checkLicenseWithLemon(env, key);
  if (!rec) {
    if (cached && cached.ok && now - (Number(cached.checked_at) || 0) < LICENSE_GRACE_MS &&
        !(cached.expires_at && Date.parse(cached.expires_at) <= now)) {
      return cached;
    }
    return { ok: false, reason: "unreachable" };
  }
  // Only cache real keys (Lemon Squeezy returned a status), so random
  // guesses don't fill KV.
  if (rec.status) {
    await env.KV.put(kvKey, JSON.stringify(rec), { expirationTtl: 30 * 86400 });
  }
  return rec;
}

// Resolve the caller's unlock state from their token.
// Token is "code:<CODE>", "sub:<hex>", or "lic:<license key>".
async function resolveUnlock(env, token) {
  token = clean(token, 64);
  if (!token) return { unlocked: false, via: null };
  if (token.indexOf("code:") === 0) {
    var code = normalizeCode(token.slice(5));
    if (await codeIsRedeemed(env, code)) return { unlocked: true, via: "code" };
    return { unlocked: false, via: null };
  }
  if (token.indexOf("sub:") === 0) {
    var hex = token.slice(4);
    if (!/^[0-9a-f]{32}$/.test(hex) || !env.KV) return { unlocked: false, via: null };
    var rec = await env.KV.get("sub:" + hex, "json");
    if (subRecordIsGood(rec)) {
      var via = rec.source === "code" ? "code"
        : rec.status === "lifetime" ? "lifetime" : "subscription";
      return { unlocked: true, via: via };
    }
    return { unlocked: false, via: null };
  }
  if (token.indexOf("lic:") === 0) {
    var licenseKey = normalizeLicenseKey(token.slice(4));
    if (!licenseKey) return { unlocked: false, via: null };
    var lr = await resolveLicense(env, licenseKey, false);
    if (lr.ok) return { unlocked: true, via: lr.lifetime ? "lifetime" : "subscription", source: "license" };
    return { unlocked: false, via: null };
  }
  return { unlocked: false, via: null };
}

function scriptsKey(token) {
  // Hash the identity so raw codes / tokens aren't KV keys.
  return sha256Hex("scripts:" + token).then(function (h) {
    return "scripts:" + h;
  });
}

async function readScripts(env, token) {
  if (!env.KV) return [];
  var list = await env.KV.get(await scriptsKey(token), "json");
  return Array.isArray(list) ? list : [];
}

async function writeScripts(env, token, list) {
  await env.KV.put(await scriptsKey(token), JSON.stringify(list));
}

function makeId() {
  return randomHex(12);
}

// ---------------------------------------------------------------------------
// Core operations (shared by the REST handlers and the MCP tools below).
// Each do* function either returns its result object or throws an ApiError
// with { status, message }. REST handlers translate these into HTTP
// responses; MCP tools translate them into isError tool results.
// ---------------------------------------------------------------------------

function ApiError(status, message) {
  var e = new Error(message);
  e.status = status;
  return e;
}

// ---- platform cards (brief §7) ----
// Precomputed defaults per platform: aspect ratio, target length, tone,
// orientation. The KV record IS the cache (thundering-herd §8) — card
// reads never trigger AI calls. On a successful generation the card gets
// a versioned write (optimistic version check; previous version kept as
// fallback). If the AI call fails, the card is surfaced to the client so
// the UI can still offer something useful.
var DEFAULT_PLATFORM_CARDS = {
  youtube:   { aspect: "16:9", orientation: "landscape", target_length_s: 120, tone: "clear and instructive" },
  tiktok:    { aspect: "9:16", orientation: "portrait",  target_length_s: 30,  tone: "punchy and fast" },
  instagram: { aspect: "9:16", orientation: "portrait",  target_length_s: 30,  tone: "punchy and fast" },
  facebook:  { aspect: "9:16", orientation: "portrait",  target_length_s: 45,  tone: "warm and conversational" },
  linkedin:  { aspect: "1:1",  orientation: "portrait",  target_length_s: 60,  tone: "professional and direct" },
  x:         { aspect: "16:9", orientation: "landscape", target_length_s: 60,  tone: "sharp and opinionated" },
};

function normalizePlatform(p) {
  p = clean(p, 40).toLowerCase().replace(/[^a-z]/g, "");
  if (p === "reels") return "instagram";
  if (p === "twitter") return "x";
  return p;
}

async function getPlatformCard(env, platform) {
  platform = normalizePlatform(platform);
  if (!platform) return null;
  var def = DEFAULT_PLATFORM_CARDS[platform];
  if (env.KV) {
    try {
      var rec = await env.KV.get("pcard:" + platform, "json");
      if (rec && rec.card) {
        return {
          platform: platform,
          version: rec.version || 0,
          updated_at: rec.updated_at || null,
          card: rec.card,
        };
      }
    } catch (e) {}
  }
  if (def) {
    return { platform: platform, version: 0, updated_at: null, card: def };
  }
  return null;
}

// Versioned write with an optimistic version check: re-read before
// writing; if another request bumped the version meanwhile, merge onto
// the newer record instead of clobbering it. Previous version is kept
// at pcard:<platform>:prev as the fallback.
async function bumpPlatformCard(env, platform) {
  if (!env.KV) return;
  platform = normalizePlatform(platform);
  if (!platform) return;
  var key = "pcard:" + platform;
  try {
    var rec = await env.KV.get(key, "json");
    var base = rec && rec.card
      ? rec
      : { version: 0, card: DEFAULT_PLATFORM_CARDS[platform], uses: 0 };
    if (!base.card) return;
    var fresh = await env.KV.get(key, "json");
    if (fresh && (fresh.version || 0) > (rec && rec.version || 0)) {
      base = fresh; // someone else wrote first; build on theirs
    } else if (rec) {
      await env.KV.put(key + ":prev", JSON.stringify(rec));
    }
    await env.KV.put(key, JSON.stringify({
      version: (base.version || 0) + 1,
      updated_at: Date.now(),
      uses: (base.uses || 0) + 1,
      card: base.card,
    }));
  } catch (e) {}
}

// ---- script generation (free) ----

function buildPrompt(a) {
  var targetWords = Math.round(a.lengthSeconds * WORDS_PER_SECOND);
  var identity = a.name ? "The speaker is " + a.name + ". " : "";
  var job = a.role ? "They are " + a.role + ". " : "";
  var crowd = a.audience ? "The video is for " + a.audience + ". " : "";
  var tone = a.tone ? "Tone: " + a.tone + ". " : "";
  var platform = a.platformCard
    ? "This video is for " + a.platformCard.platform +
      " (" + a.platformCard.card.aspect + "). Keep it " +
      a.platformCard.card.tone + ". "
    : "";

  return (
    "Write a spoken-word teleprompter script of about " +
    targetWords +
    " words (" +
    a.lengthSeconds +
    " seconds of talking). " +
    identity +
    job +
    crowd +
    tone +
    platform +
    "The single point the video must land is: " +
    a.point +
    "\n\n" +
    "Rules:\n" +
    "- Plain text only. No markdown, no bold, no headings, no bullet points.\n" +
    "- Short sentences, conversational, the way a real person talks to a camera.\n" +
    "- No stage directions, no [pause] notes, no camera cues.\n" +
    "- Open with a hook in the first two sentences.\n" +
    "- End by landing the point and, if a name or handle was given, a one-line sign-off.\n" +
    "- Separate paragraphs with a blank line."
  );
}

function parseAnswers(input) {
  var body = input || {};
  return {
    name: clean(body.name, 80),
    role: clean(body.role, 200),
    audience: clean(body.audience, 200),
    point: clean(body.point, 500),
    lengthSeconds: Math.min(300, Math.max(15, Number(body.lengthSeconds) || 60)),
    platform: normalizePlatform(body.platform),
    tone: clean(body.tone, 80),
  };
}

async function doGenerate(env, input, request) {
  var answers = parseAnswers(input);
  if (!answers.point) {
    throw ApiError(400, "The one point (question 4) is required.");
  }
  if (!env.AI) {
    throw ApiError(500, "AI binding is not configured on this Worker.");
  }
  await checkIpThrottle(env, request);
  var slot = await generationSlot(env, request, input);

  var ph = await promptHash(answers);
  var shared = await coalescedResult(env, ph);
  if (shared) {
    await recordGenerationSlot(env, slot);
    return {
      script: shared.script,
      cached: true,
      remaining: slot.subscribed ? -1 : Math.max(0, slot.remaining - 1),
      subscribed: slot.subscribed,
    };
  }

  var platformCard = answers.platform
    ? await getPlatformCard(env, answers.platform)
    : null;
  if (platformCard) answers.platformCard = platformCard;

  var pooled = await acquireGenSlot(env);
  if (!pooled) {
    var busy = new Error("Lots of people generating right now — try again in a moment.");
    busy.status = 429;
    busy.code = "busy";
    throw busy;
  }
  await becomeLeader(env, ph);
  var script;
  try {
    var result;
    try {
      result = await env.AI.run(MODEL, {
        messages: [
          {
            role: "system",
            content:
              "You are a direct-response video scriptwriter. You write scripts people read aloud on camera. Plain text, no formatting, no stage directions.",
          },
          { role: "user", content: buildPrompt(answers) },
        ],
      });
    } catch (e) {
      // AI failed: surface the platform card so the client can still
      // offer the caller something useful (brief §7 fallback).
      var fail = ApiError(502, "Script generation failed. Try again.");
      if (platformCard) fail.platform_card = platformCard;
      throw fail;
    }
    script = clean(result && result.response, 4000);
    if (!script) {
      var empty = ApiError(502, "Script generation failed. Try again.");
      if (platformCard) empty.platform_card = platformCard;
      throw empty;
    }
  } finally {
    await releaseGenSlot(env);
  }
  await publishResult(env, ph, script);
  await recordGenerationSlot(env, slot);
  if (answers.platform) {
    try { await bumpPlatformCard(env, answers.platform); } catch (e) {}
  }
  return {
    script: script,
    remaining: slot.subscribed ? -1 : Math.max(0, slot.remaining - 1),
    subscribed: slot.subscribed,
  };
}

// ---- paywall operations ----

// Pricing (confirmed by Tyler, Nov 27, 2026): ClickPrompt Pro is
// $3.99/month, $29/year, or $59 lifetime one-time. Lemon Squeezy variant
// prices are set in Tyler's LS dashboard, not in this code. All three
// are variants of product 1397885 in the Synaptiq HQ store; each plan's
// variant ID comes from the env var in PLAN_VARIANT_ENV.
// Storage add-ons (existing subscribers only) raise the 100 GB base quota
// to 250 GB / 500 GB / 1 TB.
var PLAN_VARIANT_ENV = {
  monthly: "LEMONSQUEEZY_VARIANT_ID",
  // _ANNUAL is the name set on the live Worker; _YEARLY is still honored.
  yearly: ["LEMONSQUEEZY_VARIANT_ID_ANNUAL", "LEMONSQUEEZY_VARIANT_ID_YEARLY"],
  lifetime: "LEMONSQUEEZY_VARIANT_ID_LIFETIME",
};
function planVariantId(env, plan) {
  var names = [].concat(PLAN_VARIANT_ENV[plan] || []);
  for (var i = 0; i < names.length; i++) {
    var v = String(env[names[i]] || "").trim();
    if (v) return v;
  }
  return "";
}
var STORAGE_PLANS = {
  storage250:  { gb: 250,  envVar: "LEMONSQUEEZY_VARIANT_ID_STORAGE_250" },
  storage500:  { gb: 500,  envVar: "LEMONSQUEEZY_VARIANT_ID_STORAGE_500" },
  storage1000: { gb: 1000, envVar: "LEMONSQUEEZY_VARIANT_ID_STORAGE_1000" },
};

function storageTierGb(env) {
  // LEMONSQUEEZY_STORAGE_TIERS: JSON map of variant ID -> GB, e.g.
  // {"2169772":250}. Lets new storage variants be wired without a deploy.
  try {
    var map = JSON.parse(env.LEMONSQUEEZY_STORAGE_TIERS || "{}");
    var out = {};
    Object.keys(map).forEach(function (vid) {
      out[String(vid)] = Number(map[vid]) || 0;
    });
    return out;
  } catch (e) {
    return {};
  }
}

async function doCheckout(env, origin, plan, existingToken, attribution) {
  // Optional first-touch UTM from the client (same shape the attribution
  // branch will send). Ignored when missing or invalid.
  attribution = sanitizeAttribution(attribution);
  origin = clean(origin, 120) || "https://clickprompt.app";
  if (origin.indexOf("http") !== 0) origin = "https://clickprompt.app";

  // Stripe path is off unless PAYMENT_PROVIDER=stripe is set on the Worker.
  // The plan is checked against the exact allowlist before any cleaning,
  // so a non-string or unexpected value cannot be coerced into a plan.
  if (paymentProvider(env) === "stripe") {
    return doStripeCheckout(env, origin, plan, existingToken, attribution);
  }

  plan = clean(plan, 20);

  if (
    !env.LEMONSQUEEZY_API_KEY ||
    !env.LEMONSQUEEZY_STORE_ID ||
    !env.LEMONSQUEEZY_VARIANT_ID
  ) {
    throw ApiError(503, "Checkout is not configured yet.");
  }

  // Plan -> variant. Monthly is the default ("annual" is accepted as an
  // alias for yearly). Storage add-ons
  // (storage250/500/1000) are for existing subscribers and resolve
  // through STORAGE_PLANS below.
  var variantId;
  var token = "sub:" + randomHex(16);
  var custom = { unlock_token: token };
  applyAttribution(custom, attribution);
  var storagePlan = STORAGE_PLANS[plan];
  if (storagePlan) {
    existingToken = clean(existingToken, 64);
    var st = await resolveUnlock(env, existingToken);
    if (!st.unlocked) throw ApiError(403, "Storage add-ons need an active subscription first.");
    variantId = String(env[storagePlan.envVar] || "").trim();
    custom.storage_gb = String(storagePlan.gb);
    // Reuse the subscriber's existing identity so quota lands correctly.
    custom.unlock_token = existingToken;
    token = existingToken;
  } else {
    if (plan === "annual") plan = "yearly";
    if (!PLAN_VARIANT_ENV[plan]) plan = "monthly";
    variantId = planVariantId(env, plan);
  }
  if (!variantId) {
    throw ApiError(503, "That plan isn't available yet. Try the monthly plan.");
  }

  var storeId = String(env.LEMONSQUEEZY_STORE_ID).trim();

  try {
    var data = await lemonPost(env.LEMONSQUEEZY_API_KEY, "/v1/checkouts", {
      data: {
        type: "checkouts",
        attributes: {
          product_options: {
            redirect_url: origin + "/?checkout=done",
            enabled_variants: [variantId],
            receipt_thank_you_note:
              "ClickPrompt Pro is unlocked. To unlock it on another " +
              "device, enter the license key from this email in " +
              "ClickPrompt's \"Have an access code or license key?\" box.",
          },
          checkout_data: {
            custom: custom,
          },
        },
        relationships: {
          store: { data: { type: "stores", id: storeId } },
          variant: { data: { type: "variants", id: variantId } },
        },
      },
    });
  } catch (e) {
    throw ApiError(502, "Could not start checkout. " + (e.message || "Try again."));
  }
  var attrs = (data && data.data && data.data.attributes) || {};
  if (!attrs.url) {
    throw ApiError(502, "Could not start checkout. Try again.");
  }
  return { url: attrs.url, token: token };
}

async function doMe(env, token) {
  var me = await resolveUnlock(env, token);
  // Surface the identity's storage tier and usage so the UI can show it.
  if (env.KV && token) {
    try {
      me.storage_gb = await storageTierGbFor(env, clean(token, 64));
      me.storage_used_bytes = await storageUsedBytes(env, await audioTokenHash(clean(token, 64)));
      me.storage_max_gb = 1000;
    } catch (e) {}
  }
  return me;
}

async function doRedeemLicense(env, licenseKey) {
  var lr = await resolveLicense(env, licenseKey, true);
  if (!lr.ok) {
    if (lr.reason === "unreachable") {
      throw ApiError(503, "Couldn't check that license key right now. Try again in a minute.");
    }
    if (lr.reason === "wrong_product") {
      throw ApiError(403, "That license key isn't for ClickPrompt Pro.");
    }
    if (lr.reason === "expired" || lr.reason === "status_expired") {
      throw ApiError(403, "That license key has expired. Renew your plan to turn Pro back on.");
    }
    if (lr.reason === "status_disabled") {
      throw ApiError(403, "That license key has been disabled.");
    }
    throw ApiError(404, "That license key isn't recognized.");
  }
  return {
    unlocked: true,
    token: "lic:" + licenseKey,
    via: lr.lifetime ? "lifetime" : "subscription",
    source: "license",
  };
}

async function doRedeem(env, code, request) {
  if (!env.KV) throw ApiError(500, "KV is not configured.");
  if (!clean(code, 64)) throw ApiError(400, "Enter your access code or license key.");
  await checkRedeemThrottle(env, request);

  // Lemon Squeezy license key (UUID format) from the purchase email.
  var licenseKey = normalizeLicenseKey(code);
  if (licenseKey) return doRedeemLicense(env, licenseKey);

  code = normalizeCode(code);
  if (!code) throw ApiError(400, "Enter your access code or license key.");

  var hash = await sha256Hex("code:" + code);
  var key = "code:" + hash;
  var rec = await env.KV.get(key, "json");
  if (!rec) throw ApiError(404, "That code isn't recognized.");

  // Limited-use codes (giveaway batches) carry max_uses. The first
  // redemption mints a lifetime identity and binds it to the code; later
  // redemptions (up to max_uses, for a winner's second device) get the same
  // identity, so the library follows the code. max_uses: 1 = single-use.
  if (typeof rec.max_uses === "number") {
    var uses = Number(rec.uses) || 0;
    if (uses >= rec.max_uses) {
      throw ApiError(409, "That code has already been redeemed.");
    }
    var bound = typeof rec.bound_token === "string" ? rec.bound_token : "";
    if (!/^sub:[0-9a-f]{32}$/.test(bound)) {
      var newHex = randomHex(16);
      bound = "sub:" + newHex;
      await env.KV.put(
        "sub:" + newHex,
        JSON.stringify({
          status: "lifetime",
          source: "code",
          tier: rec.tier || "lifetime",
          batch: rec.batch || null,
          storage_tier_gb: 100,
          updated_at: Date.now(),
        })
      );
    }
    rec.uses = uses + 1;
    rec.redeemed = true;
    rec.redeemed_at = rec.redeemed_at || Date.now();
    rec.last_redeemed_at = Date.now();
    rec.bound_token = bound;
    await env.KV.put(key, JSON.stringify(rec));
    return { unlocked: true, token: bound, via: "code" };
  }

  // Legacy unlimited-use codes: unchanged behavior.
  if (!rec.redeemed) {
    await env.KV.put(
      key,
      JSON.stringify({ redeemed: true, redeemed_at: Date.now() })
    );
  }
  // Already-redeemed codes still unlock (each redemption is a device unlock).
  return { unlocked: true, token: "code:" + code, via: "code" };
}

async function doScriptsGet(env, token) {
  if (!env.KV) throw ApiError(500, "KV is not configured.");
  var st = await resolveUnlock(env, token);
  if (!st.unlocked) throw ApiError(403, "Saving requires unlock.");
  return { scripts: await readScripts(env, token) };
}

async function doScriptsSave(env, token, fields) {
  if (!env.KV) throw ApiError(500, "KV is not configured.");
  token = clean(token, 64);
  var st = await resolveUnlock(env, token);
  if (!st.unlocked) throw ApiError(403, "Saving requires unlock.");
  var title = clean(fields.title, 80) || "Untitled script";
  var scriptBody = clean(fields.body, 20000);
  if (!scriptBody) throw ApiError(400, "Nothing to save.");

  var list = await readScripts(env, token);
  var id = clean(fields.id, 32);
  var now = Date.now();
  if (id) {
    var found = false;
    list = list.map(function (s) {
      if (s.id === id) {
        found = true;
        return { id: id, title: title, body: scriptBody, updatedAt: now };
      }
      return s;
    });
    if (!found) list.unshift({ id: id, title: title, body: scriptBody, updatedAt: now });
  } else {
    list.unshift({ id: makeId(), title: title, body: scriptBody, updatedAt: now });
  }
  // Cap the library at 200 scripts per identity.
  list = list.slice(0, 200);
  await writeScripts(env, token, list);
  return { ok: true, scripts: list };
}

async function doScriptsDelete(env, token, id) {
  if (!env.KV) throw ApiError(500, "KV is not configured.");
  var st = await resolveUnlock(env, token);
  if (!st.unlocked) throw ApiError(403, "Saving requires unlock.");
  id = clean(id, 32);
  if (!id) throw ApiError(400, "Missing id.");
  var list = (await readScripts(env, token)).filter(function (s) {
    return s.id !== id;
  });
  await writeScripts(env, token, list);
  return { ok: true, scripts: list };
}

// ---- voiceover audio (same paywall as scripts) ----
//
// Storage v2 (brief §2): 100 GB base quota per paid identity, tiered
// add-ons to 1 TB. R2 is the mandated object store (zero egress —
// downloads stay free). R2 is not yet enabled on this Cloudflare
// account, so the three helpers below check for the VOICEOVER_AUDIO
// (R2) binding and fall back to KV until Tyler enables R2, creates the
// bucket, and binds it. Quota accounting runs either way.

var MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB per voiceover (KV value limit)
var MAX_AUDIO_FILES = 200; // cap the library per identity, like scripts
var GB = 1024 * 1024 * 1024;
var STORAGE_BASE_BYTES = 100 * GB; // 100 GB included on both plans
var STORAGE_MAX_BYTES = 1000 * GB; // 1 TB ceiling — nobody gets past this

function audioTokenHash(token) {
  return sha256Hex("audio:" + token);
}

function audioBlobKey(tokenHash, id) {
  return "audioblob:" + tokenHash + ":" + id;
}

function audioR2Key(tokenHash, id) {
  return "audio/" + tokenHash + "/" + id;
}

async function audioPut(env, tokenHash, id, body, contentType) {
  if (env.VOICEOVER_AUDIO) {
    await env.VOICEOVER_AUDIO.put(audioR2Key(tokenHash, id), body, {
      httpMetadata: { contentType: contentType },
    });
    return;
  }
  await env.KV.put(audioBlobKey(tokenHash, id), body, {
    metadata: { contentType: contentType },
  });
}

async function audioGet(env, tokenHash, id) {
  if (env.VOICEOVER_AUDIO) {
    var obj = await env.VOICEOVER_AUDIO.get(audioR2Key(tokenHash, id));
    if (!obj) return null;
    var buf = await obj.arrayBuffer();
    return {
      body: buf,
      size: buf.byteLength,
      contentType: (obj.httpMetadata && obj.httpMetadata.contentType) || "audio/webm",
    };
  }
  var got = await env.KV.getWithMetadata(audioBlobKey(tokenHash, id), "arrayBuffer");
  if (!got || !got.value) return null;
  return {
    body: got.value,
    size: got.value.byteLength,
    contentType: (got.metadata && got.metadata.contentType) || "audio/webm",
  };
}

async function audioDelete(env, tokenHash, id) {
  if (env.VOICEOVER_AUDIO) {
    try { await env.VOICEOVER_AUDIO.delete(audioR2Key(tokenHash, id)); } catch (e) {}
    return;
  }
  await env.KV.delete(audioBlobKey(tokenHash, id));
}

// ---- storage quota accounting (brief §2) ----

async function storageTierGbFor(env, token) {
  // Lifetime/code/subscriber identities all start at the 100 GB base.
  // A storage add-on purchase writes storage_tier_gb onto the sub record.
  if (token.indexOf("sub:") === 0 && /^[0-9a-f]{32}$/.test(token.slice(4))) {
    var rec = await env.KV.get("sub:" + token.slice(4), "json");
    if (rec && rec.storage_tier_gb) {
      return Math.min(1000, Math.max(100, Number(rec.storage_tier_gb) || 100));
    }
  }
  return 100;
}

async function storageQuotaBytes(env, token) {
  var gb = await storageTierGbFor(env, token);
  return Math.min(STORAGE_MAX_BYTES, gb * GB);
}

async function storageUsedBytes(env, tokenHash) {
  if (!env.KV) return 0;
  var rec = await env.KV.get("storage:" + tokenHash, "json");
  return (rec && Number(rec.bytes)) || 0;
}

async function addStorageBytes(env, tokenHash, delta) {
  if (!env.KV) return;
  var key = "storage:" + tokenHash;
  var rec = (await env.KV.get(key, "json")) || { bytes: 0 };
  var bytes = Math.max(0, (Number(rec.bytes) || 0) + delta);
  await env.KV.put(key, JSON.stringify({ bytes: bytes, updated_at: Date.now() }));
}

async function readAudioList(env, tokenHash) {
  if (!env.KV) return [];
  var list = await env.KV.get("audio:" + tokenHash, "json");
  return Array.isArray(list) ? list : [];
}

async function writeAudioList(env, tokenHash, list) {
  await env.KV.put("audio:" + tokenHash, JSON.stringify(list));
}

// Public view of a voiceover record (the R2 key stays server-side).
function publicAudioList(list) {
  return list.map(function (a) {
    return {
      id: a.id,
      title: a.title,
      createdAt: a.createdAt,
      size: a.size,
      contentType: a.contentType,
    };
  });
}

function requireAudioUnlock(env, token) {
  return resolveUnlock(env, token).then(function (st) {
    if (!st.unlocked) throw ApiError(403, "Saving requires unlock.");
  });
}

async function doAudioSave(env, token, title, contentType, body) {
  if (!env.KV) throw ApiError(500, "KV is not configured.");
  token = clean(token, 64);
  await requireAudioUnlock(env, token);
  if (!body || !body.byteLength) throw ApiError(400, "No audio data.");
  if (body.byteLength > MAX_AUDIO_BYTES)
    throw ApiError(413, "Voiceover is too large (25 MB max).");

  // Brief §2: metered storage — 100 GB base per paid identity, add-ons
  // to 1 TB. Downloads stay free; quota only gates saving.
  var quotaCheckToken = token;
  var quotaCheckHash = await audioTokenHash(token);
  var used = await storageUsedBytes(env, quotaCheckHash);
  var quota = await storageQuotaBytes(env, quotaCheckToken);
  if (used + body.byteLength > quota) {
    throw ApiError(
      413,
      "Storage full (" + Math.round(quota / GB) + " GB plan). Delete old voiceovers or add storage to make room."
    );
  }

  var type = clean(contentType, 80) || "audio/webm";
  if (type.indexOf("audio/") !== 0) type = "audio/webm";
  var id = makeId();
  var tokenHash = await audioTokenHash(token);

  await audioPut(env, tokenHash, id, body, type);

  var list = await readAudioList(env, tokenHash);
  list.unshift({
    id: id,
    title: clean(title, 80) || "Voiceover",
    size: body.byteLength,
    contentType: type,
    createdAt: Date.now(),
  });
  // Enforce the cap: drop the oldest records and their audio bytes.
  var trimmed = list.slice(0, MAX_AUDIO_FILES);
  var dropped = list.slice(MAX_AUDIO_FILES);
  var droppedBytes = 0;
  for (var i = 0; i < dropped.length; i++) {
    if (dropped[i] && dropped[i].id) {
      try { await audioDelete(env, tokenHash, dropped[i].id); } catch (e) {}
      droppedBytes += Number(dropped[i].size) || 0;
    }
  }
  await writeAudioList(env, tokenHash, trimmed);
  await addStorageBytes(env, tokenHash, body.byteLength - droppedBytes);
  return { ok: true, audio: publicAudioList(trimmed) };
}

async function doAudioList(env, token) {
  if (!env.KV) throw ApiError(500, "KV is not configured.");
  token = clean(token, 64);
  await requireAudioUnlock(env, token);
  var list = await readAudioList(env, await audioTokenHash(token));
  return { audio: publicAudioList(list) };
}

async function doAudioDelete(env, token, id) {
  if (!env.KV) throw ApiError(500, "KV is not configured.");
  token = clean(token, 64);
  await requireAudioUnlock(env, token);
  id = clean(id, 32);
  if (!id) throw ApiError(400, "Missing id.");
  var tokenHash = await audioTokenHash(token);
  var list = await readAudioList(env, tokenHash);
  var found = false;
  var freed = 0;
  list = list.filter(function (a) {
    if (a.id === id) { found = true; freed = Number(a.size) || 0; return false; }
    return true;
  });
  if (found) {
    try { await audioDelete(env, tokenHash, id); } catch (e) {}
    await addStorageBytes(env, tokenHash, -freed);
  }
  await writeAudioList(env, tokenHash, list);
  return { ok: true, audio: publicAudioList(list) };
}

// Returns a streaming Response (not JSON) for the audio bytes.
async function doAudioDownload(env, token, id) {
  if (!env.KV) throw ApiError(500, "KV is not configured.");
  token = clean(token, 64);
  await requireAudioUnlock(env, token);
  id = clean(id, 32);
  if (!id) throw ApiError(400, "Missing id.");
  var tokenHash = await audioTokenHash(token);
  var list = await readAudioList(env, tokenHash);
  var target = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) { target = list[i]; break; }
  }
  if (!target) throw ApiError(404, "Voiceover not found.");
  var obj = await audioGet(env, tokenHash, id);
  if (!obj) throw ApiError(404, "Voiceover not found.");
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.contentType,
      "Content-Length": String(obj.size),
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": 'inline; filename="' + target.id + '"',
    },
  });
}

// ---- cancellation & deletion lifecycle (brief §3) ----
// Cancellation starts a 10-business-day sequence:
//   day 0:  cancellation notice ("download your data, you have 10
//           business days")
//   day 5:  reminder
//   day 10 (start of day): final notice; hard delete runs by 11:59 PM
// After the hard delete there are no recoverable copies — scripts,
// voiceovers, blobs, quota records, and the sub record are destroyed.
// The cron is idempotent (re-runs skip already-deleted identities),
// logs { timestamp, account } per deletion, and writes a delalert record
// on failure.

function addBusinessDays(fromMs, days) {
  var d = new Date(fromMs);
  var added = 0;
  while (added < days) {
    d = new Date(d.getTime() + 86400000);
    var dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.getTime();
}

function fmtDate(ms) {
  var d = new Date(ms);
  var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return months[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear();
}

function deletionEmail1(deleteAt, accessEndsAt) {
  // If the paid period runs past today, say when Pro actually ends.
  var stillPaid = accessEndsAt && accessEndsAt > Date.now() + 86400000;
  return {
    subject: "Your ClickPrompt subscription is cancelled — save your data",
    text:
      "Your ClickPrompt Pro subscription has been cancelled.\n\n" +
      (stillPaid
        ? "Pro stays on until " + fmtDate(accessEndsAt) + ", the end of the " +
          "period you paid for. "
        : "") +
      "Your saved scripts and voiceovers will be permanently deleted on " +
      fmtDate(deleteAt) +
      (stillPaid ? " (10 business days after your plan ends). "
                 : " (10 business days from today). ") +
      "After that date there are no recoverable copies.\n\n" +
      "You can download anything you want to keep any time before then " +
      "— downloads are always free. To do that, open ClickPrompt and save " +
      "or download each script and voiceover before " + fmtDate(deleteAt) + ".\n\n" +
      "Changed your mind? Resubscribe any time before the deletion date " +
      "and everything stays right where it is.\n\n" +
      "— ClickPrompt",
  };
}

function deletionEmail2(deleteAt) {
  return {
    subject: "Reminder: your ClickPrompt data is deleted in 5 business days",
    text:
      "A quick reminder: your saved ClickPrompt scripts and voiceovers " +
      "will be permanently deleted on " + fmtDate(deleteAt) + " — " +
      "that's 5 business days from now.\n\n" +
      "If you want to keep anything, download it before that date. " +
      "After deletion there are no recoverable copies.\n\n" +
      "Resubscribing before the deletion date keeps everything intact.\n\n" +
      "— ClickPrompt",
  };
}

function deletionEmail3() {
  return {
    subject: "Today: your ClickPrompt data is being deleted",
    text:
      "Today is the final day. Your saved ClickPrompt scripts and " +
      "voiceovers are being permanently deleted by 11:59 PM tonight.\n\n" +
      "Download anything you want to keep before tonight — downloads are " +
      "free and instant from the ClickPrompt library.\n\n" +
      "— ClickPrompt",
  };
}

// Email delivery seam: set EMAIL_API_KEY + EMAIL_FROM (Resend) to send;
// without them, emails are logged to KV (emaillog:) instead of sent —
// never silently dropped. Swap the body of this function for another
// provider without touching the lifecycle.
async function sendEmail(env, to, subject, text) {
  if (!to) return;
  if (env.EMAIL_API_KEY && env.EMAIL_FROM && env.KV) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + env.EMAIL_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: [to],
          subject: subject,
          text: text,
        }),
      });
      return;
    } catch (e) {}
  }
  if (env.KV) {
    try {
      await env.KV.put(
        "emaillog:" + Date.now() + ":" + randomHex(4),
        JSON.stringify({ to: to, subject: subject, text: text, at: Date.now() })
      );
    } catch (e) {}
  }
}

function delQueueKey(ms) {
  var d = new Date(ms);
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return "delqueue:" + d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
}

function startOfUtcDay(ms) {
  var d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

async function delQueueAdd(env, ms, hex) {
  var key = delQueueKey(ms);
  var list = (await env.KV.get(key, "json")) || [];
  if (list.indexOf(hex) === -1) list.push(hex);
  // Keep the queue entry around a while in case the cron misses a day.
  await env.KV.put(key, JSON.stringify(list), { expirationTtl: 60 * 86400 });
}

async function delQueueRemove(env, ms, hex) {
  var key = delQueueKey(ms);
  var list = (await env.KV.get(key, "json")) || [];
  var next = list.filter(function (h) { return h !== hex; });
  await env.KV.put(key, JSON.stringify(next), { expirationTtl: 60 * 86400 });
}

async function scheduleDeletion(env, hex, email, deleteAt, accessEndsAt) {
  // Day 0 notice goes out immediately; days 5 and 10 are sent by the cron.
  await env.KV.put(
    "delemail:" + hex,
    JSON.stringify({ email: email || null, sent1: Date.now(), sent2: 0, sent3: 0, delete_at: deleteAt })
  );
  await delQueueAdd(env, deleteAt, hex);
  // Also queue the identity under the day-5 reminder date, since the
  // daily cron only scans queues dated at or before today.
  await delQueueAdd(env, deleteAt - 5 * 86400000, hex);
  var e1 = deletionEmail1(deleteAt, accessEndsAt);
  await sendEmail(env, email, e1.subject, e1.text);
}

async function cancelDeletion(env, hex) {
  var rec = await env.KV.get("delemail:" + hex, "json");
  if (rec && rec.delete_at) {
    await delQueueRemove(env, rec.delete_at, hex);
    // The reminder-date queue entry added in scheduleDeletion.
    await delQueueRemove(env, Number(rec.delete_at) - 5 * 86400000, hex);
  }
  await env.KV.delete("delemail:" + hex);
}

// Idempotent hard delete: destroys scripts, voiceovers, blobs, quota
// records, and the sub record. Re-running on an already-deleted identity
// is a no-op. Logs { timestamp, account } to dellog: for the audit trail.
async function hardDeleteIdentity(env, hex) {
  var subKey = "sub:" + hex;
  var sub = (await env.KV.get(subKey, "json")) || {};
  if (sub.deleted) return { skipped: true };
  var bytesDeleted = 0;
  // Scripts.
  var scriptsKey = null;
  var tokenVariants = ["sub:" + hex];
  for (var i = 0; i < tokenVariants.length; i++) {
    var th = await sha256Hex(tokenVariants[i]);
    scriptsKey = "scripts:" + th;
    await env.KV.delete(scriptsKey);
    // Voiceover metadata + blobs.
    var ath = await sha256Hex("audio:" + tokenVariants[i]);
    var list = (await env.KV.get("audio:" + ath, "json")) || [];
    for (var j = 0; j < list.length; j++) {
      if (list[j] && list[j].id) {
        bytesDeleted += Number(list[j].size) || 0;
        await audioDelete(env, ath, list[j].id);
      }
    }
    await env.KV.delete("audio:" + ath);
    await env.KV.delete("storage:" + ath);
  }
  // Email/scheduling records.
  await env.KV.delete("delemail:" + hex);
  var deleted = {
    status: sub.status || "cancelled",
    ls_subscription_id: sub.ls_subscription_id || null,
    ls_order_id: sub.ls_order_id || null,
    deleted: true,
    deleted_at: Date.now(),
  };
  await env.KV.put(subKey, JSON.stringify(deleted));
  await env.KV.put(
    "dellog:" + hex,
    JSON.stringify({ at: Date.now(), account: hex, bytes_deleted: bytesDeleted })
  );
  return { deleted: true, bytes_deleted: bytesDeleted };
}

// Daily cron entry point. Configure `triggers.crons = ["0 9 * * *"]` at
// deploy (9 AM UTC). Sends due lifecycle emails and runs the hard
// deletes whose window has closed. Failures write delalert: records and
// continue with the rest — one bad identity never blocks the sweep.
async function runDeletionCron(env) {
  if (!env.KV) return { ok: false, reason: "no KV" };
  var now = Date.now();
  var todayKey = delQueueKey(now);
  var processed = [];
  var alerted = [];
  // Sweep all delqueue: keys at or before today (KV list, prefix scan).
  var cursor = undefined;
  var queues = [];
  do {
    var page = await env.KV.list({ prefix: "delqueue:", cursor: cursor });
    for (var i = 0; i < page.keys.length; i++) queues.push(page.keys[i].name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  queues.sort();
  for (var q = 0; q < queues.length; q++) {
    if (queues[q] > todayKey) continue; // not due yet
    var list = (await env.KV.get(queues[q], "json")) || [];
    for (var k = 0; k < list.length; k++) {
      var hex = list[k];
      try {
        var mail = await env.KV.get("delemail:" + hex, "json");
        if (mail) {
          var deleteAt = Number(mail.delete_at) || 0;
          var dayMs = 86400000;
          // Day 5 reminder (calendar-day approximation of 5 business days).
          if (!mail.sent2 && now >= deleteAt - 5 * dayMs && now < deleteAt) {
            var e2 = deletionEmail2(deleteAt);
            await sendEmail(env, mail.email, e2.subject, e2.text);
            mail.sent2 = now;
            await env.KV.put("delemail:" + hex, JSON.stringify(mail));
          }
          // Day 10 final notice, sent at the start of the deletion day.
          var dayStart = startOfUtcDay(deleteAt);
          if (!mail.sent3 && now >= dayStart) {
            var e3 = deletionEmail3();
            await sendEmail(env, mail.email, e3.subject, e3.text);
            mail.sent3 = now;
            await env.KV.put("delemail:" + hex, JSON.stringify(mail));
          }
          // Hard delete at 11 PM UTC on day 10 — safely "by 11:59 PM"
          // for any cron cadence of 6 hours or faster.
          if (now >= dayStart + dayMs - 3600000) {
            await hardDeleteIdentity(env, hex);
            await delQueueRemove(env, deleteAt, hex);
            processed.push(hex);
          }
        } else {
          // No email record — still delete if the queue says so.
          await hardDeleteIdentity(env, hex);
          await delQueueRemove(env, now, hex);
          processed.push(hex);
        }
      } catch (e) {
        alerted.push(hex);
        try {
          await env.KV.put(
            "delalert:" + Date.now() + ":" + hex,
            JSON.stringify({ at: Date.now(), error: String((e && e.message) || e) })
          );
        } catch (e2) {}
      }
    }
  }
  return { ok: true, deleted: processed, alerts: alerted };
}

// ---- REST handlers (thin wrappers around the core operations) ----

async function handleGenerate(request, env, cors) {
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Request body must be JSON." }, 400, cors);
  }
  try {
    return json(await doGenerate(env, body, request), 200, cors);
  } catch (e) {
    var out = { error: e.message || "Script generation failed." };
    if (e.code) out.code = e.code;
    // Brief §7: on AI failure, hand the client the platform card so the
    // UI can still offer useful defaults.
    if (e.platform_card) out.platform_card = e.platform_card;
    return json(out, e.status || 500, cors);
  }
}

async function handleCheckout(request, env, cors) {
  // Creates a hosted checkout for monthly, yearly, or lifetime and
  // returns the URL plus the opaque unlock token. PAYMENT_PROVIDER
  // selects Lemon Squeezy (default) or Stripe. The frontend stores
  // the token BEFORE redirecting; the webhook matches it back via
  // custom_data / metadata. Lemon Squeezy also accepts storage
  // add-on plans, which pass the subscriber's existing token so the
  // quota lands on their identity. The Stripe path does not offer
  // storage add-ons. Optional body.attribution is stored on the
  // checkout.
  var body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  try {
    return json(await doCheckout(env, body.origin, body.plan, body.token, body.attribution), 200, cors);
  } catch (e) {
    return json({ error: e.message || "Could not start checkout." }, e.status || 500, cors);
  }
}

async function handleWebhook(request, env, cors) {
  // Lemon Squeezy posts events here. Signature-verified; updates KV
  // subscription state keyed by the opaque unlock token.
  if (!env.LEMONSQUEEZY_WEBHOOK_SECRET) {
    return json({ error: "Webhook is not configured yet." }, 503, cors);
  }
  var raw = await request.text();
  var sig = request.headers.get("X-Signature");
  if (!(await verifyLemonSignature(raw, sig, env.LEMONSQUEEZY_WEBHOOK_SECRET))) {
    return json({ error: "Bad signature." }, 401, cors);
  }

  var event;
  try {
    event = JSON.parse(raw);
  } catch (e) {
    return json({ error: "Bad payload." }, 400, cors);
  }

  if (!env.KV) return json({ error: "KV is not configured." }, 500, cors);

  var meta = event.meta || {};
  var eventName = meta.event_name || "";
  var eventId = String(meta.event_id || "");

  // Idempotency: LS retries deliveries and signs no timestamp, so dedup
  // on the event id. Duplicates are acknowledged, not reprocessed.
  if (eventId) {
    var seen = await env.KV.get("evt:" + eventId);
    if (seen) return json({ received: true, duplicate: true }, 200, cors);
  }

  var data = event.data || {};
  var attrs = data.attributes || {};
  var custom = meta.custom_data || {};

  if (data.type === "subscriptions" && eventName.indexOf("subscription_") === 0) {
    var lsSubId = String(data.id || "");
    var hex = null;

    // subscription_created carries our checkout custom_data; later events
    // may not, so keep a reverse map from the LS subscription id.
    var customToken = custom.unlock_token;
    if (
      typeof customToken === "string" &&
      customToken.indexOf("sub:") === 0 &&
      /^[0-9a-f]{32}$/.test(customToken.slice(4))
    ) {
      hex = customToken.slice(4);
      if (lsSubId) await env.KV.put("lssub:" + lsSubId, hex);
    } else if (lsSubId) {
      hex = await env.KV.get("lssub:" + lsSubId);
    }

    if (hex) {
      // A cancelled flag means locked even if the status string lags.
      var effectiveStatus =
        attrs.cancelled === true ? "cancelled" : attrs.status || "unknown";
      var subKey = "sub:" + hex;
      var prev = (await env.KV.get(subKey, "json")) || {};
      var rec = {
        status: effectiveStatus,
        ls_subscription_id: lsSubId || prev.ls_subscription_id || null,
        email: clean((attrs.user_email || attrs.customer_email || prev.email || ""), 120) || null,
        storage_tier_gb: prev.storage_tier_gb || 100,
        cancel_pending: !!prev.cancel_pending,
        // End of the paid period on a cancelled subscription (LS ends_at);
        // Pro stays on until then. LS clears it when a sub is resumed.
        ends_at: attrs.ends_at !== undefined ? (attrs.ends_at || null) : (prev.ends_at || null),
        delete_at: prev.delete_at || null,
        updated_at: Date.now(),
      };
      var wasActive = !prev.cancel_pending && (prev.status === "active" || !prev.status);
      // Cancellation starts the deletion sequence (brief §3): 3 emails
      // over 10 business days, then the hard-delete cron removes
      // everything. A re-activation cancels it.
      if ((eventName === "subscription_cancelled" || effectiveStatus === "cancelled") && wasActive) {
        // The 10-business-day deletion window starts when paid access
        // ends, not at the moment of cancelling.
        var accessEndsAt = Math.max(Date.now(), Date.parse(rec.ends_at || "") || 0);
        var deleteAt = addBusinessDays(accessEndsAt, 10);
        rec.cancel_pending = true;
        rec.delete_at = deleteAt;
        await env.KV.put(subKey, JSON.stringify(rec));
        try {
          await scheduleDeletion(env, hex, rec.email, deleteAt, accessEndsAt);
        } catch (e) {}
      } else if ((eventName === "subscription_resumed" || eventName === "subscription_created" ||
                  eventName === "subscription_updated") &&
                 effectiveStatus !== "cancelled" && effectiveStatus !== "expired") {
        if (rec.cancel_pending) {
          rec.cancel_pending = false;
          rec.delete_at = null;
          try { await cancelDeletion(env, hex); } catch (e) {}
        }
        await env.KV.put(subKey, JSON.stringify(rec));
      } else {
        await env.KV.put(subKey, JSON.stringify(rec));
      }
    }
  }
  if (data.type === "orders" && eventName === "order_created") {
    // One-time purchase. Same unlock_token handshake as subscriptions:
    // the checkout embeds it in custom_data. A storage add-on purchase
    // (custom.storage_gb from the storage checkout) raises the
    // identity's quota instead of creating a new unlock.
    var orderToken = custom.unlock_token;
    if (
      typeof orderToken === "string" &&
      orderToken.indexOf("sub:") === 0 &&
      /^[0-9a-f]{32}$/.test(orderToken.slice(4))
    ) {
      var orderHex = orderToken.slice(4);
      var orderSubKey = "sub:" + orderHex;
      var orderPrev = (await env.KV.get(orderSubKey, "json")) || {};
      var storageGb = Number(custom.storage_gb) || 0;
      if (storageGb >= 250 && storageGb <= 1000) {
        // Storage add-on: raise the quota on the existing identity.
        // Never shrinks an existing higher tier; 1 TB is the ceiling.
        var newTier = Math.min(1000, Math.max(Number(orderPrev.storage_tier_gb) || 100, storageGb));
        orderPrev.storage_tier_gb = newTier;
        orderPrev.updated_at = Date.now();
        await env.KV.put(orderSubKey, JSON.stringify(orderPrev));
      } else {
        await env.KV.put(
          orderSubKey,
          JSON.stringify({
            status: "lifetime",
            ls_order_id: String(data.id || ""),
            storage_tier_gb: Number(orderPrev.storage_tier_gb) || 100,
            updated_at: Date.now(),
          })
        );
      }
    }
  }
  // All other event types are acknowledged and ignored.

  if (eventId) {
    await env.KV.put(
      "evt:" + eventId,
      JSON.stringify({ at: Date.now() })
    );
  }
  return json({ received: true }, 200, cors);
}

async function handleMe(request, env, cors) {
  // GET /api/me?token=... -> { unlocked, via }
  var url = new URL(request.url);
  var token = url.searchParams.get("token");
  try {
    return json(await doMe(env, token), 200, cors);
  } catch (e) {
    return json({ error: e.message || "Lookup failed." }, e.status || 500, cors);
  }
}

async function handleRedeem(request, env, cors) {
  // POST /api/redeem { code } -> { unlocked: true, token, via } on success.
  // Takes a CLICK- access code or a Lemon Squeezy license key.
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Request body must be JSON." }, 400, cors);
  }
  try {
    return json(await doRedeem(env, body.code, request), 200, cors);
  } catch (e) {
    return json({ error: e.message || "Redemption failed." }, e.status || 500, cors);
  }
}

async function handleScripts(request, env, cors) {
  // CRUD for saved scripts. Every method requires an unlocked identity.
  // Identity token comes from ?token= or the JSON body.
  var url = new URL(request.url);
  var token = url.searchParams.get("token") || "";

  try {
    if (request.method === "GET") {
      return json(await doScriptsGet(env, token), 200, cors);
    }

    if (request.method === "POST") {
      var body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "Request body must be JSON." }, 400, cors);
      }
      token = clean(body.token, 64) || token;
      return json(
        await doScriptsSave(env, token, { id: body.id, title: body.title, body: body.body }),
        200,
        cors
      );
    }

    if (request.method === "DELETE") {
      return json(
        await doScriptsDelete(env, token, url.searchParams.get("id")),
        200,
        cors
      );
    }

    return json({ error: "Method not allowed." }, 405, cors);
  } catch (e) {
    return json({ error: e.message || "Request failed." }, e.status || 500, cors);
  }
}

async function handleAudio(request, env, cors) {
  // Voiceover library. Every method requires an unlocked identity.
  // Identity token and title come from the query string; POST carries
  // the raw audio bytes as the body.
  var url = new URL(request.url);
  var token = url.searchParams.get("token") || "";

  try {
    if (request.method === "GET") {
      var id = url.searchParams.get("id");
      if (id) {
        var stream = await doAudioDownload(env, token, id);
        // Merge CORS headers onto the streaming response.
        var headers = new Headers(stream.headers);
        Object.keys(cors).forEach(function (k) { headers.set(k, cors[k]); });
        return new Response(stream.body, { status: stream.status, headers: headers });
      }
      return json(await doAudioList(env, token), 200, cors);
    }

    if (request.method === "POST") {
      var title = url.searchParams.get("title") || "";
      var contentType = request.headers.get("Content-Type") || "";
      var body = await request.arrayBuffer();
      return json(await doAudioSave(env, token, title, contentType, body), 200, cors);
    }

    if (request.method === "DELETE") {
      return json(
        await doAudioDelete(env, token, url.searchParams.get("id")),
        200,
        cors
      );
    }

    return json({ error: "Method not allowed." }, 405, cors);
  } catch (e) {
    var err = { error: e.message || "Request failed." };
    if (e.status === 403) err.unlocked = false;
    return json(err, e.status || 500, cors);
  }
}

// ---------------------------------------------------------------------------
// MCP connector endpoint
// ---------------------------------------------------------------------------
// Stateless JSON-RPC 2.0 over HTTP POST at /mcp (streamable-HTTP style:
// single request -> single JSON response). No session tracking; every
// request is independent.
//
// This is the surface Meta's Muse connector directory consumes when the
// connector is submitted as "Existing MCP". Tool names and descriptions
// are written for agent discovery: what the user asks for, not how the
// backend works.
// ---------------------------------------------------------------------------

var MCP_PROTOCOL_VERSION = "2025-06-18";
var MCP_SERVER_NAME = "clickprompt";
var MCP_SERVER_VERSION = "1.0.0";

var MCP_INSTRUCTIONS =
  "ClickPrompt is a camera teleprompter for talking-head video. " +
  "Use generate_script when the user wants a video script drafted from a " +
  "short interview (their name, what they do, who the video is for, the one " +
  "point it must land, target length). Script generation is free: 3 scripts " +
  "per day per visitor, no account needed; subscribers get unlimited. " +
  "Saving scripts to a personal library (ClickPrompt Pro) costs " +
  "$3.99/month, $29/year, or $59 lifetime via Lemon Squeezy, or is " +
  "free for life with an access code the user already owns. A buyer can " +
  "also unlock with the license key from their purchase email. To unlock " +
  "saving: call start_checkout and show " +
  "the user the returned checkout URL, keep the returned token, then poll " +
  "check_unlock_status with that token until unlocked. Or call " +
  "redeem_access_code with the user's code or license key. Library tools (list_scripts, " +
  "save_script, delete_script) require an unlocked identity token.";

var MCP_TOOLS = [
  {
    name: "generate_script",
    description:
      "Draft a spoken-word teleprompter script from a 5-question interview. " +
      "Free, no account needed. Ask the user for: their name/handle, what " +
      "they do, who the video is for, the single point the video must land " +
      "(required), and target length in seconds (15-300, default 60). " +
      "Returns plain-text script ready to read on camera.",
    inputSchema: {
      type: "object",
      required: ["point"],
      properties: {
        name: { type: "string", description: "Speaker name or handle." },
        role: { type: "string", description: "What the speaker does." },
        audience: { type: "string", description: "Who the video is for." },
        point: {
          type: "string",
          description: "The single point the video must land (required).",
        },
        lengthSeconds: {
          type: "integer",
          minimum: 15,
          maximum: 300,
          default: 60,
          description: "Target video length in seconds.",
        },
      },
    },
  },
  {
    name: "start_checkout",
    description:
      "Start a ClickPrompt Pro checkout ($3.99/month, $29/year, or $59 " +
      "lifetime) to unlock script saving. Returns a hosted checkout URL to show the user plus an " +
      "unlock token. Keep the token and poll check_unlock_status with " +
      "it after the user pays. The user pays Lemon Squeezy (merchant " +
      "of record) in their browser.",
    inputSchema: {
      type: "object",
      properties: {
        origin: {
          type: "string",
          description: "Site to return the user to after checkout.",
        },
        plan: {
          type: "string",
          enum: ["monthly", "yearly", "lifetime"],
          default: "monthly",
          description:
            "Plan to check out: monthly ($3.99/mo), yearly ($29/yr), or lifetime ($59 one-time).",
        },
      },
    },
  },
  {
    name: "check_unlock_status",
    description:
      "Check whether an identity token has script saving unlocked. " +
      "Use after start_checkout to confirm the user's purchase completed.",
    inputSchema: {
      type: "object",
      required: ["token"],
      properties: {
        token: {
          type: "string",
          description:
            'Identity token from start_checkout or redeem_access_code ("sub:<hex>", "code:<CODE>", or "lic:<license key>").',
        },
      },
    },
  },
  {
    name: "redeem_access_code",
    description:
      "Redeem a ClickPrompt access code (lifetime unlock) or the Lemon " +
      "Squeezy license key from a ClickPrompt Pro purchase email. Use when " +
      "the user already owns a code or key. Returns the identity token.",
    inputSchema: {
      type: "object",
      required: ["code"],
      properties: {
        code: {
          type: "string",
          description: "Access code (e.g. CLICK-XXXX-XXXX) or license key (UUID format).",
        },
      },
    },
  },
  {
    name: "list_scripts",
    description: "List the user's saved scripts. Requires an unlocked identity token.",
    inputSchema: {
      type: "object",
      required: ["token"],
      properties: {
        token: { type: "string", description: "Unlocked identity token." },
      },
    },
  },
  {
    name: "save_script",
    description:
      "Save a script to the user's library (creates or updates by id). " +
      "Requires an unlocked identity token.",
    inputSchema: {
      type: "object",
      required: ["token", "body"],
      properties: {
        token: { type: "string", description: "Unlocked identity token." },
        id: { type: "string", description: "Existing script id to update (omit to create)." },
        title: { type: "string", description: "Script title." },
        body: { type: "string", description: "Script text (required)." },
      },
    },
  },
  {
    name: "delete_script",
    description: "Delete one saved script. Requires an unlocked identity token.",
    inputSchema: {
      type: "object",
      required: ["token", "id"],
      properties: {
        token: { type: "string", description: "Unlocked identity token." },
        id: { type: "string", description: "Script id to delete." },
      },
    },
  },
];

function mcpError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: { code: code, message: message },
  };
}

function mcpResult(id, result) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, result: result };
}

function mcpToolText(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function mcpToolError(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

async function mcpCallTool(env, name, args, request) {
  args = args || {};
  try {
    switch (name) {
      case "generate_script":
        return mcpToolText(await doGenerate(env, args));
      case "start_checkout":
        return mcpToolText(await doCheckout(env, args.origin, args.plan));
      case "check_unlock_status":
        return mcpToolText(await doMe(env, args.token));
      case "redeem_access_code":
        return mcpToolText(await doRedeem(env, args.code, request));
      case "list_scripts":
        return mcpToolText(await doScriptsGet(env, args.token));
      case "save_script":
        return mcpToolText(
          await doScriptsSave(env, args.token, {
            id: args.id,
            title: args.title,
            body: args.body,
          })
        );
      case "delete_script":
        return mcpToolText(await doScriptsDelete(env, args.token, args.id));
      default:
        return mcpToolError("Unknown tool: " + name);
    }
  } catch (e) {
    return mcpToolError(e.message || "Tool call failed.");
  }
}

async function handleMcp(request, env, cors) {
  if (request.method !== "POST") {
    return json(
      { error: "MCP requires POST with a JSON-RPC 2.0 body." },
      405,
      cors
    );
  }

  var msg;
  try {
    msg = await request.json();
  } catch (e) {
    return json(mcpError(null, -32700, "Parse error."), 200, cors);
  }

  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return json(mcpError(msg && msg.id, -32600, "Invalid Request."), 200, cors);
  }

  var id = msg.id;
  var params = msg.params || {};

  // Notifications have no id and get no response.
  if (id === undefined || id === null) {
    return new Response(null, { status: 202, headers: cors });
  }

  switch (msg.method) {
    case "initialize":
      return json(
        mcpResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
          instructions: MCP_INSTRUCTIONS,
        }),
        200,
        cors
      );

    case "ping":
      return json(mcpResult(id, {}), 200, cors);

    case "tools/list":
      return json(mcpResult(id, { tools: MCP_TOOLS }), 200, cors);

    case "tools/call": {
      var toolName = params.name;
      if (!toolName) {
        return json(mcpError(id, -32602, "Missing tool name."), 200, cors);
      }
      var callResult = await mcpCallTool(env, toolName, params.arguments, request);
      return json(mcpResult(id, callResult), 200, cors);
    }

    default:
      return json(mcpError(id, -32601, "Method not found: " + msg.method), 200, cors);
  }
}

// ---- router ----

async function handleEvent(request, env, cors) {
  // POST /api/event { event } — client analytics counter (brief §10).
  // Accepted events: generated, recording_started, download, subscribe.
  // No PII; increments a daily KV counter with a 90-day TTL. Never fails
  // the client: a bad payload just gets a 400.
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Request body must be JSON." }, 400, cors);
  }
  var event = clean(body && body.event, 40);
  if (["generated", "recording_started", "download", "subscribe"].indexOf(event) === -1) {
    return json({ error: "Unknown event." }, 400, cors);
  }
  if (env.KV) {
    try {
      var d = new Date();
      function p(n) { return (n < 10 ? "0" : "") + n; }
      var key = "ev:" + d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" +
        p(d.getUTCDate()) + ":" + event;
      var count = Number(await env.KV.get(key)) || 0;
      await env.KV.put(key, String(count + 1), { expirationTtl: 90 * 86400 });
    } catch (e) {}
  }
  return json({ ok: true }, 200, cors);
}

// Named exports are for local unit tests only (node --test test/).
export {
  paymentProvider,
  sanitizeAttribution,
  assertStripeTestMode,
  buildStripeCheckoutForm,
  verifyStripeSignature,
  stripeReturnOrigin,
  planPriceId,
};

export default {
  async fetch(request, env) {
    var cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    var url = new URL(request.url);
    var path = url.pathname;

    // Stripe webhooks are server-to-server. No CORS, and only POST.
    if (path === "/api/stripe-webhook") {
      if (request.method !== "POST") {
        return new Response(null, { status: 405, headers: { Allow: "POST" } });
      }
      return handleStripeWebhook(request, env, {});
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (path === "/mcp") {
      return handleMcp(request, env, cors);
    }
    if (path === "/api/generate-script" && request.method === "POST") {
      return handleGenerate(request, env, cors);
    }
    if (path === "/api/checkout" && request.method === "POST") {
      return handleCheckout(request, env, cors);
    }
    if (path === "/api/webhook" && request.method === "POST") {
      return handleWebhook(request, env, cors);
    }
    if (path === "/api/me" && request.method === "GET") {
      return handleMe(request, env, cors);
    }
    if (path === "/api/redeem" && request.method === "POST") {
      return handleRedeem(request, env, cors);
    }
    if (path === "/api/scripts") {
      return handleScripts(request, env, cors);
    }
    if (path === "/api/audio") {
      return handleAudio(request, env, cors);
    }
    if (path === "/api/event" && request.method === "POST") {
      return handleEvent(request, env, cors);
    }

    return json({ error: "Not found." }, 404, cors);
  },

  // Cron trigger: configure `triggers.crons = ["0 9 * * *"]` at deploy.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDeletionCron(env));
  },
};
