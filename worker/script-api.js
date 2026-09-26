/*
 * teleprompter-script-api
 * -----------------------
 * Cloudflare Worker for ClickPrompt (clickprompt.app).
 *
 * Free endpoints (no account needed):
 *   POST /api/generate-script   { name, role, audience, point, lengthSeconds }
 *                               -> { script } via Workers AI (Llama 3.3 70b)
 *
 * Paywalled: script SAVING is $0.95/month, or free forever with an
 * access code. Everything else stays free.
 *
 *   POST /api/checkout          { origin } -> { url }  (Stripe Checkout,
 *                               $0.95/mo recurring; needs STRIPE_SECRET_KEY
 *                               and STRIPE_PRICE_ID secrets)
 *   POST /api/webhook           Stripe webhook events (verified with
 *                               STRIPE_WEBHOOK_SECRET); keeps subscription
 *                               state in KV keyed by Stripe customer id.
 *   GET  /api/me?token=...     -> { unlocked, via } where via is
 *                               "subscription" | "code" | null. Also accepts
 *                               ?session_id=... right after Stripe redirect.
 *   POST /api/redeem            { code } -> { unlocked, token }.
 *                               A redeemed code unlocks saving for life.
 *   GET    /api/scripts?token=  List saved scripts for this identity.
 *   POST   /api/scripts        { token, title, body } -> save (upsert).
 *   DELETE /api/scripts?id=&token=  Delete one saved script.
 *
 * Identity: the frontend stores one opaque token in localStorage:
 *   "code:CLICK-XXXX-XXXX" for code users, or "cus_..." (Stripe customer
 *   id) for subscribers. The Worker never trusts the client claim alone:
 *   codes are validated against hashed KV records, subscriptions against
 *   KV state written by the verified Stripe webhook.
 *
 * KV layout (namespace bound as KV):
 *   code:<sha256(code)>   -> { redeemed: bool, redeemed_at: number|null }
 *   sub:<customerId>      -> { status: "active"|"trialing"|"past_due"|
 *                                        "canceled"|"incomplete", updated_at }
 *   scripts:<sha256(token)> -> [ { id, title, body, updatedAt } ]
 *
 * Secrets (set via the Workers API; placeholders until Tyler's Stripe
 * key arrives):
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID
 *
 * Bindings: AI (Workers AI), KV (this namespace).
 */

// Words per second for natural spoken delivery (~145 wpm).
var WORDS_PER_SECOND = 2.4;
var MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Subscription states that count as "paid up".
var GOOD_STATUSES = { active: 1, trialing: 1 };

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

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  var out = 0;
  for (var i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// Verify a Stripe webhook signature: header looks like
// "t=1492774577,v1=5257a869...,v0=...". Returns true/false.
async function verifyStripeSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  var parts = {};
  header.split(",").forEach(function (kv) {
    var i = kv.indexOf("=");
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  if (!parts.t || !parts.v1) return false;
  // Reject replays older than 5 minutes.
  var ts = parseInt(parts.t, 10);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return false;
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
    new TextEncoder().encode(parts.t + "." + rawBody)
  );
  return timingSafeEqual(bytesToHex(new Uint8Array(sig)), parts.v1);
}

// ---- Stripe REST (raw fetch; no SDK in Workers) ----

function stripeAuth(secretKey) {
  // Stripe uses HTTP Basic with the secret key as username.
  return "Basic " + btoa(secretKey + ":");
}

async function stripePost(secretKey, path, params) {
  var body = Object.keys(params)
    .map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
    })
    .join("&");
  var res = await fetch("https://api.stripe.com" + path, {
    method: "POST",
    headers: {
      Authorization: stripeAuth(secretKey),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body,
  });
  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    var err = new Error((data.error && data.error.message) || "stripe error");
    err.stripe = data.error;
    throw err;
  }
  return data;
}

async function stripeGet(secretKey, path) {
  var res = await fetch("https://api.stripe.com" + path, {
    headers: { Authorization: stripeAuth(secretKey) },
  });
  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error("stripe error");
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

async function subscriptionIsGood(env, customerId) {
  if (!env.KV || !customerId) return false;
  var rec = await env.KV.get("sub:" + customerId, "json");
  return !!(rec && GOOD_STATUSES[rec.status]);
}

// Resolve the caller's unlock state from their token.
// Token is either "code:CLICK-XXXX-XXXX" or a Stripe "cus_..." id.
async function resolveUnlock(env, token) {
  token = clean(token, 64);
  if (!token) return { unlocked: false, via: null };
  if (token.indexOf("code:") === 0) {
    var code = normalizeCode(token.slice(5));
    if (await codeIsRedeemed(env, code)) return { unlocked: true, via: "code" };
    return { unlocked: false, via: null };
  }
  if (token.indexOf("cus_") === 0) {
    if (await subscriptionIsGood(env, token))
      return { unlocked: true, via: "subscription" };
    return { unlocked: false, via: null };
  }
  return { unlocked: false, via: null };
}

function scriptsKey(token) {
  // Hash the identity so raw codes / customer ids aren't KV keys.
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
  var a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return bytesToHex(a);
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
  // Creates a Stripe Checkout Session for the $0.95/mo subscription and
  // returns the hosted URL the frontend redirects to.
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID) {
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

  try {
    var session = await stripePost(env.STRIPE_SECRET_KEY, "/v1/checkout/sessions", {
      mode: "subscription",
      "line_items[0][price]": env.STRIPE_PRICE_ID,
      "line_items[0][quantity]": "1",
      success_url: origin + "/?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: origin + "/",
    });
    return json({ url: session.url }, 200, cors);
  } catch (e) {
    return json({ error: "Could not start checkout. Try again." }, 502, cors);
  }
}

async function handleWebhook(request, env, cors) {
  // Stripe posts events here. Signature-verified; updates KV subscription
  // state keyed by Stripe customer id.
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return json({ error: "Webhook is not configured yet." }, 503, cors);
  }
  var raw = await request.text();
  var sig = request.headers.get("stripe-signature");
  if (!(await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET))) {
    return json({ error: "Bad signature." }, 401, cors);
  }

  var event;
  try {
    event = JSON.parse(raw);
  } catch (e) {
    return json({ error: "Bad payload." }, 400, cors);
  }

  if (!env.KV) return json({ error: "KV is not configured." }, 500, cors);

  var type = event.type || "";
  var obj = (event.data && event.data.object) || {};

  if (type === "checkout.session.completed") {
    // The customer id may not be on the session until the subscription
    // exists; fetch the subscription to be sure.
    var customerId = obj.customer || null;
    var subStatus = "active";
    try {
      if (obj.subscription && env.STRIPE_SECRET_KEY) {
        var sub = await stripeGet(
          env.STRIPE_SECRET_KEY,
          "/v1/subscriptions/" + obj.subscription
        );
        customerId = sub.customer || customerId;
        subStatus = sub.status || subStatus;
      }
    } catch (e) {
      /* fall through with what we have */
    }
    if (customerId) {
      await env.KV.put(
        "sub:" + customerId,
        JSON.stringify({ status: subStatus, updated_at: Date.now() })
      );
    }
  } else if (
    type === "customer.subscription.updated" ||
    type === "customer.subscription.deleted"
  ) {
    var cid = obj.customer || null;
    if (cid) {
      await env.KV.put(
        "sub:" + cid,
        JSON.stringify({
          status: type === "customer.subscription.deleted" ? "canceled" : obj.status || "unknown",
          updated_at: Date.now(),
        })
      );
    }
  }
  // All other event types are acknowledged and ignored.
  return json({ received: true }, 200, cors);
}

async function handleMe(request, env, cors) {
  // GET /api/me?token=...  -> { unlocked, via }
  // GET /api/me?session_id=... -> resolves the Stripe session right after
  // redirect, returns { unlocked, via, token } with the customer token the
  // frontend should store.
  var url = new URL(request.url);
  var token = url.searchParams.get("token");
  var sessionId = url.searchParams.get("session_id");

  if (sessionId) {
    if (!env.STRIPE_SECRET_KEY) {
      return json({ unlocked: false, via: null, reason: "not_configured" }, 200, cors);
    }
    try {
      var session = await stripeGet(
        env.STRIPE_SECRET_KEY,
        "/v1/checkout/sessions/" + encodeURIComponent(sessionId)
      );
      var customerId = session.customer || null;
      // Prefer the live subscription state straight from Stripe: the
      // webhook may not have landed yet when the buyer is redirected back.
      var subId = session.subscription || null;
      if (subId) {
        try {
          var live = await stripeGet(
            env.STRIPE_SECRET_KEY,
            "/v1/subscriptions/" + encodeURIComponent(subId)
          );
          customerId = live.customer || customerId;
          if (customerId && GOOD_STATUSES[live.status]) {
            await env.KV.put(
              "sub:" + customerId,
              JSON.stringify({ status: live.status, updated_at: Date.now() })
            );
            return json({ unlocked: true, via: "subscription", token: customerId }, 200, cors);
          }
        } catch (e) {
          /* fall through to the KV check */
        }
      }
      if (customerId && (await subscriptionIsGood(env, customerId))) {
        return json({ unlocked: true, via: "subscription", token: customerId }, 200, cors);
      }
      return json({ unlocked: false, via: null }, 200, cors);
    } catch (e) {
      return json({ unlocked: false, via: null }, 200, cors);
    }
  }

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
