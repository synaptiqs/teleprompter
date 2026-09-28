/*
 * teleprompter-script-api
 * -----------------------
 * Cloudflare Worker for ClickPrompt (clickprompt.app).
 *
 * Free endpoints (no account needed):
 *   POST /api/generate-script   { name, role, audience, point, lengthSeconds }
 *                               -> { script } via Workers AI (Llama 3.3 70b)
 *
 * MCP connector endpoint (for Meta's Muse connector directory):
 *   POST /mcp                   JSON-RPC 2.0, stateless streamable HTTP.
 *                               Methods: initialize, tools/list, tools/call.
 *                               Tools: generate_script, check_unlock_status,
 *                               redeem_access_code, start_checkout,
 *                               list_scripts, save_script, delete_script.
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

// ---- script generation (free) ----

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

function parseAnswers(input) {
  var body = input || {};
  return {
    name: clean(body.name, 80),
    role: clean(body.role, 200),
    audience: clean(body.audience, 200),
    point: clean(body.point, 500),
    lengthSeconds: Math.min(300, Math.max(15, Number(body.lengthSeconds) || 60)),
  };
}

async function doGenerate(env, input) {
  var answers = parseAnswers(input);
  if (!answers.point) {
    throw ApiError(400, "The one point (question 4) is required.");
  }
  if (!env.AI) {
    throw ApiError(500, "AI binding is not configured on this Worker.");
  }
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
    throw ApiError(502, "Script generation failed. Try again.");
  }
  var script = clean(result && result.response, 4000);
  if (!script) throw ApiError(502, "Script generation failed. Try again.");
  return { script: script };
}

// ---- paywall operations ----

async function doCheckout(env, origin) {
  if (
    !env.LEMONSQUEEZY_API_KEY ||
    !env.LEMONSQUEEZY_STORE_ID ||
    !env.LEMONSQUEEZY_VARIANT_ID
  ) {
    throw ApiError(503, "Checkout is not configured yet.");
  }
  origin = clean(origin, 120) || "https://clickprompt.app";
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
  return resolveUnlock(env, token);
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

// ---- REST handlers (thin wrappers around the core operations) ----

async function handleGenerate(request, env, cors) {
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Request body must be JSON." }, 400, cors);
  }
  try {
    return json(await doGenerate(env, body), 200, cors);
  } catch (e) {
    return json({ error: e.message || "Script generation failed." }, e.status || 500, cors);
  }
}

async function handleCheckout(request, env, cors) {
  // Creates a Lemon Squeezy checkout for the $0.95/mo subscription variant
  // and returns the hosted URL plus the opaque unlock token. The frontend
  // stores the token BEFORE redirecting; the subscription_created webhook
  // matches it back via checkout custom_data.
  var body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  try {
    return json(await doCheckout(env, body.origin), 200, cors);
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
  "point it must land, target length). Script generation is free and needs " +
  "no account. Saving scripts to a personal library costs $0.95/month via " +
  "Lemon Squeezy, or is free for life with an access code the user already " +
  "owns. To unlock saving: call start_checkout and show the user the " +
  "returned checkout URL, keep the returned token, then poll " +
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
      "Start a $0.95/month checkout to unlock script saving. Returns a " +
      "hosted checkout URL to show the user plus an unlock token. Keep the " +
      "token and poll check_unlock_status with it after the user pays. " +
      "The user pays Lemon Squeezy (merchant of record) in their browser.",
    inputSchema: {
      type: "object",
      properties: {
        origin: {
          type: "string",
          description: "Site to return the user to after checkout.",
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
        return mcpToolText(await doCheckout(env, args.origin));
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

    return json({ error: "Not found." }, 404, cors);
  },
};
