// ClickPrompt smart teleprompter: writes scripts for queue items.
//
// Two writers share one job:
//  - "Your AI" (bring your own key): smart/ai.js calls the user's provider
//    from the browser. Not capped by ClickPrompt.
//  - "ClickPrompt writer" (hosted): our Worker's /api/generate-script
//    (Workers AI). It enforces the free cap server-side. The hosted writer
//    is passed in as an object with one method:
//        generate(brief) -> Promise<{ script: string, remaining?: number }>
//    so a different hosted backend can be swapped in later.
(function (root, factory) {
  var api = factory(
    typeof module === "object" && module.exports ? require("./loop.js") : root.CPLoop,
    typeof module === "object" && module.exports ? require("./ai.js") : root.CPAI
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CPWriter = api;
}(typeof self !== "undefined" ? self : this, function (L, AI) {
  "use strict";

  // deps: { ai: settings|null, fetch, hosted: { generate } }
  // Fills item.title/script, sets status "ready". Returns the item.
  async function writeItem(loop, item, deps, now) {
    var parsed;
    var model;
    if (deps.ai) {
      var text = await AI.complete(deps.ai, L.buildScriptPrompt(loop, item), deps.fetch);
      parsed = L.parseScriptResponse(text);
      model = AI.PROVIDERS[deps.ai.provider].label + " · " + deps.ai.model;
    } else {
      var res = await deps.hosted.generate(L.briefForHosted(loop, item));
      parsed = L.parseScriptResponse(res.script);
      model = "ClickPrompt writer";
      if (parsed && !parsed.title) parsed.title = firstWords(parsed.hook || parsed.body, 8);
    }
    if (!parsed) throw new Error("The reply didn't contain a script. Try again.");
    if (!item.title || parsed.title) item.title = parsed.title || item.title || "Untitled video";
    item.script = { hook: parsed.hook, body: parsed.body, cta: parsed.cta };
    item.status = "ready";
    item.generatedAt = now || Date.now();
    item.model = model;
    return item;
  }

  // Rewrites one section (hook, body or cta). Needs "Your AI": the hosted
  // writer only writes whole scripts, so it rewrites the whole script and
  // keeps the requested section.
  async function rewriteSection(loop, item, section, deps) {
    if (["hook", "body", "cta"].indexOf(section) === -1) throw new Error("Unknown section");
    if (deps.ai) {
      var text = await AI.complete(deps.ai, L.buildSectionPrompt(loop, item, section), deps.fetch, 2000);
      var cleaned = text.replace(/^\s*(HOOK|BODY|CTA)\s*:\s*/i, "").trim();
      item.script[section] = cleaned;
      return item;
    }
    var res = await deps.hosted.generate(L.briefForHosted(loop, item));
    var parsed = L.parseScriptResponse(res.script);
    if (!parsed || !parsed[section]) throw new Error("The writer didn't return that section. Try again.");
    item.script[section] = parsed[section];
    return item;
  }

  function firstWords(text, n) {
    var words = String(text || "").replace(/\s+/g, " ").trim().split(" ").slice(0, n).join(" ");
    return words.replace(/[.,!?;:]+$/, "");
  }

  // Writes scripts for due items one at a time. Stops at the first
  // error (for example the free cap) and reports it. max limits how many
  // are written in one go.
  async function writeDue(loop, todayIso, deps, opts) {
    opts = opts || {};
    var due = L.dueForGeneration(loop, todayIso, opts.lookaheadDays).slice(0, opts.max || 3);
    var written = 0;
    for (var i = 0; i < due.length; i++) {
      if (opts.onStart) opts.onStart(due[i], i, due.length);
      try {
        await writeItem(loop, due[i], deps);
        written += 1;
        if (opts.onDone) opts.onDone(due[i]);
      } catch (e) {
        return { written: written, error: e };
      }
    }
    return { written: written, error: null };
  }

  return { writeItem: writeItem, rewriteSection: rewriteSection, writeDue: writeDue };
}));
