/*
 * teleprompter-script-api
 * -----------------------
 * Cloudflare Worker that turns five short interview answers into a
 * spoken-word teleprompter script using Workers AI (Llama 3.1 Instruct).
 *
 *   POST /api/generate-script
 *   Body: { name, role, audience, point, lengthSeconds }
 *   Returns: { script }
 *
 * Deploy with the Workers Scripts API; needs an "AI" binding
 * (type "ai", name "AI"). No secrets required.
 */

// Words per second for natural spoken delivery (~145 wpm).
var WORDS_PER_SECOND = 2.4;
var MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

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

export default {
  async fetch(request, env) {
    var cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    var url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/api/generate-script") {
      return json({ error: "Use POST /api/generate-script" }, 404, cors);
    }

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
  },
};
