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

## Smart teleprompter (content loop + your own AI)

The **Up next to record** panel at the top of the setup screen turns
ClickPrompt into a teleprompter that knows what you need to record next.

1. **Content loop** (`Content loop` button): the creator enters their
   channel (name, topic, audience, voice/tone, optional past scripts),
   pillars or series (one per line), platforms with a target length
   (TikTok/Short, Reel, YouTube video, LinkedIn), and posting days
   (default Mon/Wed/Fri).
2. **Up next queue**: the app plans one video per posting day for the next
   14 days, rotating platforms and pillars. Each item is *Not written* or
   *Ready*.
3. **Scripts written ahead**: every time the app opens, items due in the
   next 3 days get a script (up to 3 per open) if the creator connected
   their own AI. Scripts come back as **Hook / Body / Call to action**
   with one sentence per line and blank lines between ideas, so they read
   well on the prompter. With the hosted ClickPrompt writer, scripts are
   written when the creator taps **Write it** (so the free cap isn't spent
   in the background).
4. **Ready to go**: **Record now** loads the script into the prompter and
   sets the recording frame for that platform (vertical or horizontal).
   **Edit** opens the script editor: change any section, **Regenerate**
   just the hook, body or CTA, or **Rewrite all**.
5. **Feedback loop**: after a take, the review dialog asks *How did it go?*:
   Liked it / Needs work, quick chips (Great hook, Too long, Too short, Too
   salesy, Sounds like me, Not my voice, Weak ending), and a free-text note.
   **Mark recorded** or **Skip this one**. The last 8 pieces of feedback
   and recent titles go into every future prompt, so scripts drift toward
   what the creator liked and away from repeats.

### Connect your AI (bring your own key)

`Connect your AI` lets the creator pick **OpenAI, Anthropic (Claude),
Google Gemini, xAI (Grok)**, or **OpenRouter**, choose a model (suggested
list, any model ID can be typed, **Load my models** pulls the real list
from the provider), and paste an API key. **Save & test** and **Test
connection** call the provider's list-models endpoint (no tokens spent) and
check the chosen model exists. **Connect with OpenRouter** uses OpenRouter's
OAuth PKCE flow (S256 challenge + `state` check, verifier kept in
`sessionStorage` for that tab only), and the returned key is stored like a
pasted one.

**Privacy of keys**

- The key is stored **only in this browser's `localStorage`** (`cp_ai_v1`)
  on that device. The dialog says so, and **Remove key** deletes it.
- Script requests go **straight from the browser to the provider** using
  each provider's browser CORS support (Anthropic needs the
  `anthropic-dangerous-direct-browser-access: true` header; Gemini's key
  goes in the `x-goog-api-key` header, never the URL). Checked Oct 19, 2026:
  all five APIs answer CORS preflights from a web origin.
- Keys never reach ClickPrompt's Worker, are never logged, and error
  messages scrub anything that looks like a key. The tests assert this.
- BYO-key usage is not capped by ClickPrompt; the creator pays their
  provider.

### Plans

- The hosted **ClickPrompt writer** is the existing Worker endpoint
  (`POST /api/generate-script`, Workers AI). The queue reuses it through
  `window.ClickPromptApp.hostedGenerate`, so it shares the existing free
  cap (3 scripts per day per visitor, enforced server-side) and the Pro
  unlimited rule. The loop context is folded into the five existing fields
  (`point` is capped at 500 characters, length at 300 seconds), so **no
  Worker change or redeploy is needed** for this feature. Videos longer than
  5 minutes are written at 5 minutes by the hosted writer; connecting an AI
  removes that limit.
- `smart/writer.js` takes the hosted writer as an object with one method,
  `generate(brief) -> { script, remaining }`, so a dedicated hosted endpoint
  (for example labelled Hook/Body/CTA output or a monthly cap) can be
  swapped in later without touching the UI.
- Pricing and checkout are unchanged by this feature.

### Files

| File | What |
|---|---|
| `smart/loop.js` | Content loop: queue planning, prompts, parsing, prompter formatting, hosted brief. Pure logic. |
| `smart/ai.js` | Provider requests and replies, test connection, model lists, OpenRouter PKCE. |
| `smart/writer.js` | Writes queue items with your AI or the hosted writer; per-section rewrites. |
| `smart/ui.js` | The Up next panel and the three dialogs. |
| `app.js` | Adds `window.ClickPromptApp` (load script, open prompter, set frame, hosted writer) and a `cp:take-complete` event. |

All smart data stays in the browser: `cp_loop_v1` (loop + queue),
`cp_ai_v1` (provider, model, key), and `sessionStorage` `cp_loop_current` /
`cp_or_pkce`.

### Tests

```
node --test tests/unit/            # 30 unit tests, no dependencies, providers mocked
node tests/e2e/smart.e2e.cjs shots # browser flow (needs Playwright; every network call mocked)
```

The end-to-end script needs Playwright installed globally (`npm i -g
playwright && npx playwright install chromium webkit`). It isn't a repo
dependency on purpose: there's no `package.json`, so Cloudflare Pages has
nothing to install or build.

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
  project, `teleprompter-5fz.pages.dev`, custom domains clickprompt.app and
  www.clickprompt.app). No build step. The project is connected to this
  repo with `main` as the production branch and previews for all branches,
  but as of Oct 19, 2026 every recent deployment was a manual (ad hoc)
  upload, so check the Pages dashboard before assuming a merge went live,
  and check that a manual upload won't overwrite newer `main` changes.
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
  `LEMONSQUEEZY_VARIANT_ID_YEARLY` (Pro Annual $49.99),
  `LEMONSQUEEZY_VARIANT_ID_LIFETIME` (Pro Lifetime $129), optional
  `LEMONSQUEEZY_PRODUCT_ID` (license-key product check, default 1397885),
  `LEMONSQUEEZY_STORAGE_TIERS` (JSON map of storage add-on variant ID to
  GB), plus optional `EMAIL_API_KEY`/`EMAIL_FROM` for the cancellation
  email sequence.
- The frontend keeps one opaque unlock token in `localStorage`
  (`clickprompt_token`): `code:<CODE>`, `sub:<hex>`, or `lic:<license key>`.
