/*
 * teleprompter-script-api
 * -----------------------
 * Cloudflare Worker for ClickPrompt (clickprompt.app).
 *
 * Free endpoints (no account needed):
 *   POST /api/generate-script   { name, role, audience, point, lengthSeconds }
 *                               -> { script } via Workers AI (Llama 3.3 70b)
 *
 * Paywalled: script SAVING is $0.95/month via Lemon Squeezy, or free
 * forever with an access code. Everything else stays free.
 *
 *   POST /api/checkout          { origin } -> { url, token } (Lemon Squeezy
 *                               hosted checkout for the $0.95/mo variant;
 *                               needs LEMONSQUEEZY_API_KEY,
 *                               LEMONSQUEEZY_STORE_ID, LEMONSQUEEZY_VARIANT_ID)
 *   POST /api/webhook           Lemon Squeezy webhook events, verified with
 *                               LEMONSQUEEZY_WEBHOOK_SECRET (HMAC-SHA256 of
 *                               the raw body in the X-Signature header).
 *                               Keeps subscription state in KV keyed by the
 *                               opaque unlock token passed as custom_data.
 *   GET  /api/me?token=...     -> { unlocked, via } where via is
 *                               "subscription" | "code" | null.
 *   POST /api/redeem            { code } -> { unlocked, token }.
 *                               A redeemed code unlocks saving for life.
 *   GET    /api/scripts?token=  List saved scripts for this identity.
 *   POST   /api/scripts        { token, title, body } -> save (upsert).
 *   DELETE /api/scripts?id=&token=  Delete one saved script.
 *
 * Identity: the frontend stores one opaque token in localStorage:
 *   "code:CLICK-XXXX-XXXX" for code users, or "sub:<hex>" for subscribers
 *   (generated at checkout, matched back via checkout custom_data on the
 *   subscription_created webhook). The Worker never trusts the client claim
 *   alone: codes are validated against hashed KV records, subscriptions
 *   against KV state written by the verified webhook.
 *
 * KV layout (namespace bound as KV):
 *   code:<sha256(code)>   -> { redeemed: bool, redeemed_at: number|null }
 *   sub:<hex>             -> { status, ls_subscription_id, updated_at }
 *   lssub:<lsSubId>       -> <hex>  (reverse map for later webhook events,
 *                              which may not carry custom_data)
 *   evt:<event_id>        -> { at }  (webhook idempotency; LS signs no
 *                              timestamp, so replays are deduped by id)
 *   scripts:<sha256(token)> -> [ { id, title, body, updatedAt } ]
 *
 * Secrets (set via the Workers API; placeholders until Tyler's Lemon
 * Squeezy credentials arrive):
 *   LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_WEBHOOK_SECRET,
 *   LEMONSQUEEZY_STORE_ID, LEMONSQUEEZY_VARIANT_ID
 *
 * Bindings: AI (Workers AI), KV (this namespace).
 */

// Words per second for natural spoken delivery (~145 wpm).
var WORDS_PER_SECOND = 2.4;
var MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Lemon Squeezy subscription statuses that count as "paid up".
var GOOD_STATUSES = { active: 1, on_trial: 1 };

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
    if (await subscriptionIsGood(env, hex))
      return { unlocked: true, via: "subscription" };
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

// ---- script generation (free, unchanged) ----

function buildPrompt(a) {
  var targetWords = Math.round(a.lengthSeconds * WORDS_PER_SECOND);
  var identity = a.name ? "The speaker is " + a.name + ". " : "";
  var job = a.role ? "They are " + a.role + ". " : "";
  var crowd = a.audience ? "The video is for " + a.audience + ". " : "";

  return (
    "Write a spoken-word teleprompter script of about " +
    targetWords +
    " words (" +
    a.lengthSeconds +
    " seconds of talking). " +
    identity +
    job +
    crowd +
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

async function handleGenerate(request, env, cors) {
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Request body must be JSON." }, 400, cors);
  }

  var answers = {
    name: clean(body.name, 80),
    role: clean(body.role, 200),
    audience: clean(body.audience, 200),
    point: clean(body.point, 500),
    lengthSeconds: Math.min(300, Math.max(15, Number(body.lengthSeconds) || 60)),
  };

  if (!answers.point) {
    return json({ error: "The one point (question 4) is required." }, 400, cors);
  }

  if (!env.AI) {
    return json({ error: "AI binding is not configured on this Worker." }, 500, cors);
  }

  try {
    var result = await env.AI.run(MODEL, {
      messages: [
        {
          role: "system",
          content:
            "You are a direct-response video scriptwriter. You write scripts people read aloud on camera. Plain text, no formatting, no stage directions.",
        },
        { role: "user", content: buildPrompt(answers) },
      ],
    });
    var script = clean(result && result.response, 4000);
    if (!script) throw new Error("empty model response");
    return json({ script: script }, 200, cors);
  } catch (e) {
    return json({ error: "Script generation failed. Try again." }, 502, cors);
  }
}

// ---- paywall endpoints ----

async function handleCheckout(request, env, cors) {
  // Creates a Lemon Squeezy checkout for the $0.95/mo subscription variant
  // and returns the hosted URL plus the opaque unlock token. The frontend
  // stores the token BEFORE redirecting; the subscription_created webhook
  // matches it back via checkout custom_data.
  if (
    !env.LEMONSQUEEZY_API_KEY ||
    !env.LEMONSQUEEZY_STORE_ID ||
    !env.LEMONSQUEEZY_VARIANT_ID
  ) {
    return json({ error: "Checkout is not configured yet." }, 503, cors);
  }
  var body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  var origin = clean(body.origin, 120) || "https://clickprompt.app";
  if (origin.indexOf("http") !== 0) origin = "https://clickprompt.app";

  var token = "sub:" + randomHex(16);
  var storeId = String(env.LEMONSQUEEZY_STORE_ID).trim();
  var variantId = String(env.LEMONSQUEEZY_VARIANT_ID).trim();

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
            custom: { unlock_token: token },
          },
        },
        relationships: {
          store: { data: { type: "stores", id: storeId } },
          variant: { data: { type: "variants", id: variantId } },
        },
      },
    });
    var attrs =
      (data && data.data && data.data.attributes) || {};
    if (!attrs.url) {
      return json({ error: "Could not start checkout. Try again." }, 502, cors);
    }
    return json({ url: attrs.url, token: token }, 200, cors);
  } catch (e) {
    return json(
      { error: "Could not start checkout. " + (e.message || "Try again.") },
      502,
      cors
    );
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
      await env.KV.put(
        "sub:" + hex,
        JSON.stringify({
          status: effectiveStatus,
          ls_subscription_id: lsSubId || null,
          updated_at: Date.now(),
        })
      );
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
  var state = await resolveUnlock(env, token);
  return json(state, 200, cors);
}

async function handleRedeem(request, env, cors) {
  // POST /api/redeem { code } -> { unlocked: true, token } on success.
  // A redeemed code unlocks script saving for life.
  if (!env.KV) return json({ error: "KV is not configured." }, 500, cors);
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Request body must be JSON." }, 400, cors);
  }
  var code = normalizeCode(body.code);
  if (!code) return json({ error: "Enter your access code." }, 400, cors);

  var hash = await sha256Hex("code:" + code);
  var key = "code:" + hash;
  var rec = await env.KV.get(key, "json");
  if (!rec) return json({ error: "That code isn't recognized." }, 404, cors);
  if (rec.redeemed) {
    // Already redeemed: still unlock this device (codes are shareable
    // within reason; each redemption is just a device unlock).
    return json({ unlocked: true, token: "code:" + code, via: "code" }, 200, cors);
  }
  await env.KV.put(
    key,
    JSON.stringify({ redeemed: true, redeemed_at: Date.now() })
  );
  return json({ unlocked: true, token: "code:" + code, via: "code" }, 200, cors);
}

async function handleScripts(request, env, cors) {
  // CRUD for saved scripts. Every method requires an unlocked identity.
  // Identity token comes from ?token= or the JSON body.
  if (!env.KV) return json({ error: "KV is not configured." }, 500, cors);
  var url = new URL(request.url);
  var token = url.searchParams.get("token") || "";

  if (request.method === "GET") {
    var st = await resolveUnlock(env, token);
    if (!st.unlocked) return json({ error: "Saving requires unlock.", unlocked: false }, 403, cors);
    return json({ scripts: await readScripts(env, token) }, 200, cors);
  }

  if (request.method === "POST") {
    var body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "Request body must be JSON." }, 400, cors);
    }
    token = clean(body.token, 64) || token;
    var st2 = await resolveUnlock(env, token);
    if (!st2.unlocked) return json({ error: "Saving requires unlock.", unlocked: false }, 403, cors);
    var title = clean(body.title, 80) || "Untitled script";
    var scriptBody = clean(body.body, 20000);
    if (!scriptBody) return json({ error: "Nothing to save." }, 400, cors);

    var list = await readScripts(env, token);
    var id = clean(body.id, 32);
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
    return json({ ok: true, scripts: list }, 200, cors);
  }

  if (request.method === "DELETE") {
    var st3 = await resolveUnlock(env, token);
    if (!st3.unlocked) return json({ error: "Saving requires unlock.", unlocked: false }, 403, cors);
    var delId = clean(url.searchParams.get("id"), 32);
    if (!delId) return json({ error: "Missing id." }, 400, cors);
    var list2 = (await readScripts(env, token)).filter(function (s) {
      return s.id !== delId;
    });
    await writeScripts(env, token, list2);
    return json({ ok: true, scripts: list2 }, 200, cors);
  }

  return json({ error: "Method not allowed." }, 405, cors);
}

// ---- router ----

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

    return json({ error: "Not found." }, 404, cors);
  },
};
