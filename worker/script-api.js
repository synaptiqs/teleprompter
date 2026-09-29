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
 * Paywalled: script SAVING is $2.99/month or $34.99 lifetime via Lemon
 * Squeezy, or free forever with an access code. Everything else stays free.
 *
 *   POST /api/checkout          { origin, plan, token? } -> { url, token }
 *                               (Lemon Squeezy hosted checkout; plan is
 *                               "monthly" | "lifetime" | "storage250" |
 *                               "storage500" | "storage1000". Storage plans
 *                               are add-ons for existing subscribers and
 *                               need their unlock token. Needs
 *                               LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_STORE_ID,
 *                               and the variant ID for the chosen plan.)
 *   POST /api/webhook           Lemon Squeezy webhook events, verified with
 *                               LEMONSQUEEZY_WEBHOOK_SECRET (HMAC-SHA256 of
 *                               the raw body in the X-Signature header).
 *                               Keeps subscription/order state in KV keyed
 *                               by the opaque unlock token passed as
 *                               custom_data. subscription_* events drive
 *                               monthly; order_created drives the lifetime
 *                               one-time purchase. Storage add-on purchases
 *                               (variant IDs in LEMONSQUEEZY_STORAGE_TIERS)
 *                               raise the identity's storage quota.
 *                               Cancellation starts the deletion sequence:
 *                               3 emails over 10 business days, then the
 *                               hard-delete cron removes everything.
 *   GET  /api/me?token=...     -> { unlocked, via } where via is
 *                               "subscription" | "lifetime" | "code" | null.
 *   POST /api/redeem            { code } -> { unlocked, token }.
 *                               A redeemed code unlocks saving for life.
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
 *   "code:CLICK-XXXX-XXXX" for code users, or "sub:<hex>" for subscribers
 *   (generated at checkout, matched back via checkout custom_data on the
 *   subscription_created webhook). The Worker never trusts the client claim
 *   alone: codes are validated against hashed KV records, subscriptions
 *   against KV state written by the verified webhook.
 *
 * KV layout (namespace bound as KV). Shard-ready: every per-identity key
 * is namespaced under a hash of the identity, so a future shard can be
 * chosen by key prefix without re-keying.
 *   code:<sha256(code)>   -> { redeemed: bool, redeemed_at: number|null }
 *   sub:<hex>             -> { status, ls_subscription_id, email?,
 *                              storage_tier_gb?, cancel_pending?,
 *                              delete_at?, deleted?, updated_at }
 *   lssub:<lsSubId>       -> <hex>  (reverse map for later webhook events,
 *                              which may not carry custom_data)
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
 * Secrets (set via the Workers API):
 *   LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_WEBHOOK_SECRET,
 *   LEMONSQUEEZY_STORE_ID, LEMONSQUEEZY_VARIANT_ID (monthly $2.99),
 *   LEMONSQUEEZY_VARIANT_ID_LIFETIME ($34.99 one-time),
 *   LEMONSQUEEZY_STORAGE_TIERS (JSON map variantId -> GB, e.g.
 *     {"123":250,"124":500,"125":1000}),
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

async function subscriptionIsGood(env, hex) {
  if (!env.KV || !hex) return false;
  var rec = await env.KV.get("sub:" + hex, "json");
  return !!(rec && GOOD_STATUSES[rec.status]);
}

// Resolve the caller's unlock state from their token.
// Token is either "code:CLICK-XXXX-XXXX" or "sub:<hex>".
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
    if (!/^[0-9a-f]{32}$/.test(hex)) return { unlocked: false, via: null };
    if (await subscriptionIsGood(env, hex)) {
      var rec = await env.KV.get("sub:" + hex, "json");
      var via = rec && rec.status === "lifetime" ? "lifetime" : "subscription";
      return { unlocked: true, via: via };
    }
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

// Pricing (locked by Tyler, 2026-09-29 — brief with Grok; supersedes the
// 2026-09-28 $4.95/$49.50/$98 tiers): $2.99/month, $34.99 lifetime
// one-time. No annual plan. Storage add-ons (existing subscribers only)
// raise the 100 GB base quota to 250 GB / 500 GB / 1 TB.
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

async function doCheckout(env, origin, plan, existingToken) {
  if (
    !env.LEMONSQUEEZY_API_KEY ||
    !env.LEMONSQUEEZY_STORE_ID ||
    !env.LEMONSQUEEZY_VARIANT_ID
  ) {
    throw ApiError(503, "Checkout is not configured yet.");
  }
  origin = clean(origin, 120) || "https://clickprompt.app";
  if (origin.indexOf("http") !== 0) origin = "https://clickprompt.app";

  // Plan -> variant. Monthly is the default; lifetime needs its variant
  // ID set once Lemon Squeezy has the new variants. Storage add-ons
  // (storage250/500/1000) are for existing subscribers and resolve
  // through STORAGE_PLANS below.
  plan = clean(plan, 20);
  var variantId;
  var token = "sub:" + randomHex(16);
  var custom = { unlock_token: token };
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
    plan = plan === "lifetime" ? "lifetime" : "monthly";
    if (plan === "lifetime") variantId = env.LEMONSQUEEZY_VARIANT_ID_LIFETIME;
    else variantId = env.LEMONSQUEEZY_VARIANT_ID;
    variantId = String(variantId || "").trim();
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
              "Your ClickPrompt script saving is unlocked.",
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

async function doRedeem(env, code) {
  if (!env.KV) throw ApiError(500, "KV is not configured.");
  code = normalizeCode(code);
  if (!code) throw ApiError(400, "Enter your access code.");

  var hash = await sha256Hex("code:" + code);
  var key = "code:" + hash;
  var rec = await env.KV.get(key, "json");
  if (!rec) throw ApiError(404, "That code isn't recognized.");
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

function deletionEmail1(deleteAt) {
  return {
    subject: "Your ClickPrompt subscription is cancelled — save your data",
    text:
      "Your ClickPrompt Pro subscription has been cancelled.\n\n" +
      "Your saved scripts and voiceovers will be permanently deleted on " +
      fmtDate(deleteAt) + " (10 business days from today). " +
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

async function scheduleDeletion(env, hex, email, deleteAt) {
  // Day 0 notice goes out immediately; days 5 and 10 are sent by the cron.
  await env.KV.put(
    "delemail:" + hex,
    JSON.stringify({ email: email || null, sent1: Date.now(), sent2: 0, sent3: 0, delete_at: deleteAt })
  );
  await delQueueAdd(env, deleteAt, hex);
  // Also queue the identity under the day-5 reminder date, since the
  // daily cron only scans queues dated at or before today.
  await delQueueAdd(env, deleteAt - 5 * 86400000, hex);
  var e1 = deletionEmail1(deleteAt);
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
  // Creates a Lemon Squeezy checkout for the requested plan (monthly,
  // lifetime, or a storage add-on) and returns the hosted URL plus the
  // opaque unlock token. The frontend stores the token BEFORE redirecting;
  // the subscription_created / order_created webhook matches it back via
  // checkout custom_data. Storage add-ons pass the subscriber's existing
  // token so the quota lands on their identity.
  var body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  try {
    return json(await doCheckout(env, body.origin, body.plan, body.token), 200, cors);
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
        delete_at: prev.delete_at || null,
        updated_at: Date.now(),
      };
      var wasActive = !prev.cancel_pending && (prev.status === "active" || !prev.status);
      // Cancellation starts the deletion sequence (brief §3): 3 emails
      // over 10 business days, then the hard-delete cron removes
      // everything. A re-activation cancels it.
      if ((eventName === "subscription_cancelled" || effectiveStatus === "cancelled") && wasActive) {
        var deleteAt = addBusinessDays(Date.now(), 10);
        rec.cancel_pending = true;
        rec.delete_at = deleteAt;
        await env.KV.put(subKey, JSON.stringify(rec));
        try {
          await scheduleDeletion(env, hex, rec.email, deleteAt);
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
  // POST /api/redeem { code } -> { unlocked: true, token } on success.
  // A redeemed code unlocks saving for life.
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Request body must be JSON." }, 400, cors);
  }
  try {
    return json(await doRedeem(env, body.code), 200, cors);
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
  "Saving scripts to a personal library costs $2.99/month or $34.99 " +
  "lifetime via Lemon Squeezy, or is free for life with an access code " +
  "the user already owns. To unlock saving: call start_checkout and show " +
  "the user the returned checkout URL, keep the returned token, then poll " +
  "check_unlock_status with that token until unlocked. Or call " +
  "redeem_access_code with the user's code. Library tools (list_scripts, " +
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
      "Start a $2.99/month or $34.99 lifetime checkout to unlock script " +
      "saving. Returns a hosted checkout URL to show the user plus an " +
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
          enum: ["monthly", "lifetime"],
          default: "monthly",
          description: "Plan to check out: monthly ($2.99/mo) or lifetime ($34.99 one-time).",
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
          description: 'Identity token: "sub:<hex>" from start_checkout or "code:CLICK-XXXX-XXXX".',
        },
      },
    },
  },
  {
    name: "redeem_access_code",
    description:
      "Redeem a ClickPrompt access code for lifetime script-saving unlock. " +
      "Use when the user already owns a code.",
    inputSchema: {
      type: "object",
      required: ["code"],
      properties: {
        code: { type: "string", description: "Access code, e.g. CLICK-XXXX-XXXX." },
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

async function mcpCallTool(env, name, args) {
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
        return mcpToolText(await doRedeem(env, args.code));
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
      var callResult = await mcpCallTool(env, toolName, params.arguments);
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

export default {
  async fetch(request, env) {
    var cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    var url = new URL(request.url);
    var path = url.pathname;

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
