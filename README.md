# Teleprompter

A camera teleprompter for talking-head video. Answer five quick questions,
get a script drafted for you, then read it off your camera while you record.

## How it works

1. `index.html` + `styles.css` + `app.js` — the whole app, no build step.
2. The setup screen collects five answers (name/handle, what you do, who the
   video is for, the one point it must land, target length).
3. **Generate script** posts those answers to the Worker API and loads the
   returned script into the editable script box. You can also just type or
   paste your own script — the box is always editable.
4. **Open prompter** starts the camera view: auto-scrolling script over a live
   preview, vertical/horizontal recording frames, countdown, camera + mic
   recording with pause/resume, and review/download when the take is done.

## API

`worker/script-api.js` is a Cloudflare Worker (Workers AI, Llama 3.1
Instruct). Deploy it with an `AI` binding (type `ai`):

```
POST /api/generate-script
Content-Type: application/json

{ "name": "...", "role": "...", "audience": "...",
  "point": "...", "lengthSeconds": 60 }

→ { "script": "..." }
```

The frontend calls the deployed worker URL, set once in `app.js` as
`SCRIPT_API_URL`.

## MCP connector endpoint (Meta Muse directory)

The same worker also serves a stateless MCP endpoint for AI-agent
connectors (submitted to Meta's Muse connector directory as "Existing MCP"):

```
POST /mcp   JSON-RPC 2.0 — methods: initialize, tools/list, tools/call
```

Tools: `generate_script`, `start_checkout`, `check_unlock_status`,
`redeem_access_code`, `list_scripts`, `save_script`, `delete_script`.
No auth needed for `generate_script`; the paid-tier tools use the same
opaque identity tokens as the REST API. Full machine-readable spec:
`openapi.yaml` (REST) + tool schemas via `tools/list`.

## Deploy

- Frontend: Cloudflare Pages, served from this repo's root (`teleprompter`
  project on `*.pages.dev`).
- API: Cloudflare Worker `teleprompter-script-api` with the Workers AI
  binding. Source of truth is `worker/script-api.js` in this repo.

## Paywall: script saving

The interview and the full prompter (scroll, camera,
recording) are free forever. Script generation is free at 3 scripts/day
per visitor (subscribers get unlimited). Saving scripts to a personal
library (ClickPrompt Pro) costs $4.99/month, $49.99/year, or $129
lifetime, or is free for life with an access code. Buyers can also unlock
on any device with the Lemon Squeezy license key from their receipt email.
A cancelled monthly/yearly plan keeps Pro until the paid period ends.

- Worker endpoints: `POST /api/checkout` (Lemon Squeezy hosted checkout,
  recurring), `POST /api/webhook` (Lemon Squeezy events, X-Signature
  verified), `GET /api/me`, `POST /api/redeem` (access code or license key),
  `GET/POST/DELETE /api/scripts` (library CRUD, unlocked identities only).
- Storage: Cloudflare KV namespace `clickprompt-data`. Access codes are
  stored as SHA-256 hashes only (`code:<sha256("code:"+CODE)>`, CODE =
  uppercase without dashes; records with `max_uses` are limited-use, e.g.
  giveaway batches); subscriptions are keyed by an opaque
  `sub:<hex>` token passed as checkout `custom_data` and written by the
  verified webhook.
- Secrets the worker expects: `LEMONSQUEEZY_API_KEY`,
  `LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_STORE_ID` = 485773 (Synaptiq HQ),
  `LEMONSQUEEZY_VARIANT_ID` (Pro Monthly $4.99),
  `LEMONSQUEEZY_VARIANT_ID_ANNUAL` (Pro Annual $49.99; `_YEARLY` also accepted),
  `LEMONSQUEEZY_VARIANT_ID_LIFETIME` (Pro Lifetime $129), optional
  `LEMONSQUEEZY_PRODUCT_ID` (license-key product check, default 1397885),
  `LEMONSQUEEZY_STORAGE_TIERS` (JSON map of storage add-on variant ID to
  GB), plus optional `EMAIL_API_KEY`/`EMAIL_FROM` for the cancellation
  email sequence.
- The frontend keeps one opaque unlock token in `localStorage`
  (`clickprompt_token`): `code:<CODE>`, `sub:<hex>`, or `lic:<license key>`.

## First-touch attribution and the launch list

On every public page, `attribution.js` records the first visit (UTM
parameters, referrer host, landing path, and timestamp) in
`localStorage` under `clickprompt_attribution`. Later visits do not
overwrite that record, so checkout, the launch list, and future
features can reuse it. First-touch source data stays on the device
and expires after 90 days (a missing, invalid, or future timestamp
is treated as expired). An expired record is replaced by the current
touch, or cleared if the current page has no UTM or referrer.

When the app starts a Lemon Squeezy checkout it sends the record as
`attribution` on `POST /api/checkout`. The Worker sanitizes the fields
and copies them into `checkout_data.custom` so they show on the order
and on webhooks. **The Worker must be redeployed by hand for that
forwarding to work.** Until then the live Worker ignores the extra
field and checkout still succeeds.

`POST /api/launch-notify` stores an email plus that attribution for
the "Notify me when the store goes live" form. New signups, repeats,
and honeypot submissions all return `{ ok: true }` with no extra flags.

**Tyler setup (do not create these until he says OK):**

- Create a Cloudflare KV namespace and bind it to the Worker as
  `LAUNCH_KV`. The launch list stays closed (503) until this binding
  exists. The Worker will not fall back to the main `KV` namespace.
- Bind a Cloudflare Rate Limiting binding as `LAUNCH_RATE_LIMITER`
  (with Tyler's OK) before the Worker is redeployed. The KV throttle
  on `LAUNCH_KV` is only a fallback (5 tries per hour, IPv6 grouped
  by /64, counts kept for 2 hours, keys hashed so raw IPs are not
  stored). Do not add this binding to live config in the repo.
- Optional, server-side only and inert unless set: `TURNSTILE_SECRET`.
  If this secret is set, `/api/launch-notify` requires a valid
  Turnstile token. The front end does not load the Turnstile script
  or widgets in this change, and it does not send a token, so the
  secret must stay unset or signups would fail. Enabling Turnstile
  later needs Tyler's OK, the front-end widget and script re-added
  to the signup forms, and a disclosure on `privacy.html`.

Do not create those Cloudflare resources as part of this PR. The
Worker must be redeployed by hand for `/api/launch-notify` and
checkout attribution forwarding to work. Until then the frontend
treats 404, 405, or 503 from the launch endpoint as "not available
yet," so Pages can ship first.

Launch-list rows expire after about one year.

## Rollout (do not merge or deploy without Tyler's OK)

Pages can ship before the Worker. The frontend treats 404, 405, or
503 from `/api/launch-notify` as "not available yet."

Before the Worker is redeployed, with Tyler's OK:

1. Create and bind the `LAUNCH_KV` namespace.
2. Bind `LAUNCH_RATE_LIMITER` before that redeploy. The KV throttle
   is only a fallback when the binding is missing or does not return
   `{ success: true }`. Do not add the binding to live config in this
   repo (there is no `wrangler.toml` change in this PR).

Commented `wrangler.toml` snippet, for Tyler to add when he is ready
(not checked in as live config):

```
# [[unsafe.bindings]]
# name = "LAUNCH_RATE_LIMITER"
# type = "ratelimit"
# namespace_id = "1001"
# simple = { limit = 5, period = 60 }
```

`namespace_id` is a number Tyler chooses (Cloudflare uses it to
group rate-limit counters). Adjust the limit and period as needed.

### Rollback

- Pages production deploy: `0d3a072d-8d93-45f5-b3f1-70870a445457`
- Worker version: `56737990-2d7f-4178-a376-8ef429683125`
- After rollback, delete `launch:` and `launchthrottle:` keys from
  `LAUNCH_KV` if that namespace was created.

### Deleting one launch-list row

The KV key is `launch:` plus the SHA-256 hex digest of the string
`launch:` followed by the email, lowercased and trimmed. Example
for `alex@example.com`, with Tyler's OK:

```
# key = launch:$(printf %s 'launch:alex@example.com' | sha256sum | awk '{print $1}')
npx wrangler kv key delete "launch:<hex>" --binding LAUNCH_KV
```

Replace `<hex>` with the 64-character digest. Confirm the namespace
and account before running this.

## Tests

From the repo root (no network; Lemon Squeezy is faked):

```
node --test test/*.mjs
```

