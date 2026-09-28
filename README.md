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

The interview, script generation, and the full prompter (scroll, camera,
recording) are free forever. Saving scripts to a personal library costs
$0.95/month, or is free for life with an access code.

- Worker endpoints: `POST /api/checkout` (Lemon Squeezy hosted checkout,
  recurring), `POST /api/webhook` (Lemon Squeezy events, X-Signature
  verified), `GET /api/me`, `POST /api/redeem` (access code),
  `GET/POST/DELETE /api/scripts` (library CRUD, unlocked identities only).
- Storage: Cloudflare KV namespace `clickprompt-data`. Access codes are
  stored as SHA-256 hashes only; subscriptions are keyed by an opaque
  `sub:<hex>` token passed as checkout `custom_data` and written by the
  verified webhook.
- Secrets the worker expects: `LEMONSQUEEZY_API_KEY`,
  `LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_STORE_ID`,
  `LEMONSQUEEZY_VARIANT_ID` (the $0.95/mo subscription variant).
- The frontend keeps one opaque unlock token in `localStorage`
  (`clickprompt_token`): `code:CLICK-XXXX-XXXX` or `sub:<hex>`.
