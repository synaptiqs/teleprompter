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
library (ClickPrompt Pro) costs $3.99/month, $29/year, or $59
lifetime, or is free for life with an access code. Buyers can also unlock
on any device with the Lemon Squeezy license key from their receipt email.
A cancelled monthly/yearly plan keeps Pro until the paid period ends.

- Worker endpoints: `POST /api/checkout` (hosted checkout; Lemon Squeezy
  by default, or Stripe Checkout when `PAYMENT_PROVIDER=stripe`),
  `POST /api/webhook` (Lemon Squeezy events, X-Signature verified),
  `POST /api/stripe-webhook` (Stripe events, Stripe-Signature verified),
  `GET /api/me`, `POST /api/redeem` (access code or license key),
  `GET/POST/DELETE /api/scripts` (library CRUD, unlocked identities only).
- Storage: Cloudflare KV namespace `clickprompt-data`. Access codes are
  stored as SHA-256 hashes only (`code:<sha256("code:"+CODE)>`, CODE =
  uppercase without dashes; records with `max_uses` are limited-use, e.g.
  giveaway batches); subscriptions are keyed by an opaque
  `sub:<hex>` token passed as checkout `custom_data` and written by the
  verified webhook.
- Secrets the worker expects for the current Lemon Squeezy path:
  `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_WEBHOOK_SECRET`,
  `LEMONSQUEEZY_STORE_ID` = 485773 (Synaptiq HQ),
  `LEMONSQUEEZY_VARIANT_ID` (Pro Monthly; the $3.99 price is set in
  Tyler's Lemon Squeezy dashboard, not in this code),
  `LEMONSQUEEZY_VARIANT_ID_ANNUAL` (Pro Annual $29/year; `_YEARLY` also accepted),
  `LEMONSQUEEZY_VARIANT_ID_LIFETIME` (Pro Lifetime $59), optional
  `LEMONSQUEEZY_PRODUCT_ID` (license-key product check, default 1397885),
  `LEMONSQUEEZY_STORAGE_TIERS` (JSON map of storage add-on variant ID to
  GB), plus optional `EMAIL_API_KEY`/`EMAIL_FROM` for the cancellation
  email sequence. Stripe secrets are listed in the Stripe section below
  and are not used unless `PAYMENT_PROVIDER=stripe`.
- The frontend keeps one opaque unlock token in `localStorage`
  (`clickprompt_token`): `code:<CODE>`, `sub:<hex>`, or `lic:<license key>`.

## Stripe Checkout (test mode, do not merge without Tyler's OK)

This is behind a provider switch. The default is Lemon Squeezy, so the
live site does not change until Tyler sets `PAYMENT_PROVIDER=stripe` on
the Worker and deploys it. Merging this branch to `main` would publish
the frontend (legal-page draft wording included) to clickprompt.app, so
do not merge without Tyler's OK. The Worker is uploaded separately and
is also not deployed by this PR.

Lemon Squeezy announced on November 16, 2026 that it is winding down:
new store sign-ups are closed, and it will stop processing payments on
March 31, 2027. See the "Lemon Squeezy wind-down" notes in the pull
request. This Stripe path is the test-mode foundation for that move.
It uses Stripe Checkout (you are the seller; Stripe is the processor),
not Stripe Managed Payments, unless Tyler later chooses that product.

### What Tyler creates in the Stripe Dashboard (test mode)

Do this in your own Stripe account. Do not put any keys in the repo.

1. Sign in at https://dashboard.stripe.com and turn on **Test mode**
   (the toggle in the Dashboard). Stay in test mode.
2. Open **Product catalog** and create three products with these
   confirmed prices (USD):
   - ClickPrompt Pro Monthly: $3.99, recurring monthly. Copy the Price
     ID (`price_...`) into `STRIPE_PRICE_ID_MONTHLY`.
   - ClickPrompt Pro Yearly: $29, recurring yearly. Copy the Price ID
     into `STRIPE_PRICE_ID_YEARLY`.
   - ClickPrompt Pro Lifetime: $59, one-time. Copy the Price ID into
     `STRIPE_PRICE_ID_LIFETIME`.
3. Open **Developers > API keys** and copy the **test** secret key
   (`sk_test_...`). This is `STRIPE_SECRET_KEY`. Never commit it.
   `sk_test_` and `rk_test_` keys are test mode. `sk_live_` and
   `rk_live_` keys are live and are refused unless
   `STRIPE_ALLOW_LIVE=true`. Any other prefix fails closed. Only Tyler
   sets that flag, and only when he is ready to take Stripe live.
4. After the Worker with this code is uploaded (a later, separate step
   that also needs Tyler's OK), add a webhook in **Developers >
   Webhooks** for the test endpoint:
   `https://teleprompter-script-api.synaptiqs.workers.dev/api/stripe-webhook`.
   Pin the endpoint API version to `2025-03-31.basil`. Subscribe to
   these events:

   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `charge.refunded`
   - `charge.dispute.created`
   - `charge.dispute.closed`
   - `invoice.paid`
   - `invoice.payment_succeeded`

   Copy the signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.

   A charge-only refund whose charge GET is a 404 still tombstones
   that charge and returns 500, so Stripe retries for about 3 days.
   A PI-only lifetime checkout in that window still grants, because
   the session does not carry the tombstoned charge id.

### Worker vars and secrets (set on the Worker, not in git)

- `PAYMENT_PROVIDER` (var): `lemonsqueezy` (default) or `stripe`.
- `STRIPE_SECRET_KEY` (secret): test key starting with `sk_test_`.
- `STRIPE_WEBHOOK_SECRET` (secret): `whsec_...`.
- `STRIPE_WEBHOOK_SECRET_PREV` (secret, optional): previous `whsec_...`
  during signing-secret rotation.
- `STRIPE_PRICE_ID_MONTHLY`, `STRIPE_PRICE_ID_YEARLY` (or
  `STRIPE_PRICE_ID_ANNUAL`), `STRIPE_PRICE_ID_LIFETIME` (vars).
- `STRIPE_PRICE_AMOUNT_MONTHLY`, `STRIPE_PRICE_AMOUNT_YEARLY` (or
  `STRIPE_PRICE_AMOUNT_ANNUAL`), `STRIPE_PRICE_AMOUNT_LIFETIME`
  (optional vars, integer cents). When set, a Checkout grant also
  requires the line `price.unit_amount` to be present, to be an
  integer number (not a string), and to equal that catalog amount.
  `amount_total` is not compared. Coupons may lower `amount_total`,
  and tax may raise it; those totals can still grant when the
  catalog unit amount matches. There is no minimum-total env var.
  When unset, the grant still requires currency `usd` and quantity
  `1`, but does not compare amounts.
- `STRIPE_ALLOW_LIVE` (var, optional): only Tyler may set this to
  `true`. Without it, live `sk_live_` keys are refused.

`POST /api/checkout` accepts an optional `attribution` object
(`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`,
`utm_term`, `referrer`, `landing`, `timestamp`). UTM values may only
use `[A-Za-z0-9_.:/-]`. On the Stripe path, values are stored in
Checkout Session metadata as `attr_*` keys. Unifying this sanitizer
with the UTM-attribution helper is deferred until that PR merges.

### Entitlements

Stripe webhooks write the same KV records as Lemon Squeezy:

- `checkout.session.completed` for a subscription sets `sub:<hex>` to
  `status: "active"`.
- `checkout.session.completed` for a lifetime (one-time) payment sets
  `status: "lifetime"`.
- `customer.subscription.updated` and `customer.subscription.deleted`
  keep that record in sync. A cancel keeps Pro until
  `current_period_end` (stored as `ends_at`), then the same
  10-business-day deletion sequence runs.

License-key redeem stays Lemon Squeezy only, because Stripe Checkout
does not issue those keys. Multi-device unlock by license key is
LS-only. There is no Stripe customer portal yet; Stripe buyers email
info@lvltdllc.com to cancel.

### Local tests

```
node --test test/*.mjs
```

### Manual test plan (after Tyler sets test secrets on a preview Worker)

Do not point a test webhook at the live Worker until Tyler says to.
Use Stripe test card `4242 4242 4242 4242`, any future expiry, any
CVC, and any postal code. Complete a monthly, yearly, and lifetime
checkout, confirm `/?checkout=done` returns to clickprompt.app, and
confirm Pro unlocks after the webhook. Cancel a subscription in the
Stripe test Dashboard and confirm Pro stays on until the paid period
ends. A declined test card (`4000 0000 0000 0002`) should not unlock
Pro.
