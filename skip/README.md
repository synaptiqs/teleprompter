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

## Deploy

- Frontend: Cloudflare Pages, served from this repo's root (`teleprompter`
  project on `*.pages.dev`).
- API: Cloudflare Worker `teleprompter-script-api` with the Workers AI
  binding. Source of truth is `worker/script-api.js` in this repo.
