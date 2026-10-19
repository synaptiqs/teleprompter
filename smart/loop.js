// ClickPrompt smart teleprompter: the content loop.
//
// Pure logic, no DOM and no network, so it runs in the browser
// (window.CPLoop) and in Node tests (require). The loop is saved in this
// browser's localStorage under LOOP_KEY.
//
// Shape of a saved loop:
//   profile:   { name, topic, audience, voice, samples: [string] }
//   pillars:   [{ id, name }]                      content pillars / series
//   platforms: [{ id, label, seconds, orientation }]
//   cadence:   { days: [0..6] }                    0 = Sunday
//   items:     [{ id, due, pillarId, platformId, status, title,
//                 script: { hook, body, cta }, generatedAt, model,
//                 rating, notes, decidedAt }]
//   seq:       rotation counter for pillars and platforms
// status is one of: planned (no script yet), ready, recorded, skipped.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CPLoop = api;
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var LOOP_KEY = "cp_loop_v1";
  var WORDS_PER_SECOND = 2.4; // about 145 spoken words a minute
  var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Platform presets offered in the content-loop setup.
  var PLATFORM_PRESETS = [
    { id: "short", label: "TikTok / YouTube Short", seconds: 30, orientation: "portrait" },
    { id: "reel", label: "Instagram Reel", seconds: 60, orientation: "portrait" },
    { id: "youtube", label: "YouTube video", seconds: 480, orientation: "landscape" },
    { id: "linkedin", label: "LinkedIn video", seconds: 60, orientation: "portrait" }
  ];

  // Quick feedback chips shown after recording.
  var FEEDBACK_CHIPS = ["Great hook", "Too long", "Too short", "Too salesy",
    "Sounds like me", "Not my voice", "Weak ending"];

  function defaultLoop() {
    return {
      version: 1,
      profile: { name: "", topic: "", audience: "", voice: "", samples: [] },
      pillars: [],
      platforms: [],
      cadence: { days: [1, 3, 5] },
      items: [],
      seq: 0
    };
  }

  function isConfigured(loop) {
    return !!(loop && loop.profile && loop.profile.topic &&
      loop.platforms.length && loop.cadence.days.length);
  }

  function loadLoop(storage) {
    try {
      var raw = storage.getItem(LOOP_KEY);
      if (!raw) return defaultLoop();
      var parsed = JSON.parse(raw);
      var base = defaultLoop();
      Object.keys(base).forEach(function (k) {
        if (parsed[k] === undefined) parsed[k] = base[k];
      });
      return parsed;
    } catch (e) {
      return defaultLoop();
    }
  }

  function saveLoop(storage, loop) {
    try { storage.setItem(LOOP_KEY, JSON.stringify(loop)); return true; }
    catch (e) { return false; }
  }

  // ---- dates (local calendar days as YYYY-MM-DD strings) ----

  function isoDate(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
      "-" + String(d.getDate()).padStart(2, "0");
  }

  function parseIso(s) {
    var p = String(s).split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function addDays(iso, n) {
    var d = parseIso(iso);
    d.setDate(d.getDate() + n);
    return isoDate(d);
  }

  function dueLabel(iso, todayIso) {
    var d = parseIso(iso);
    var pretty = DAY_NAMES[d.getDay()] + " " +
      d.toLocaleString("en-US", { month: "short" }) + " " + d.getDate();
    if (iso === todayIso) return "Today · " + pretty;
    if (iso === addDays(todayIso, 1)) return "Tomorrow · " + pretty;
    if (iso < todayIso) return "Overdue · " + pretty;
    return pretty;
  }

  // ---- the "Up next" queue ----

  function slug(text) {
    return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "").slice(0, 32) || "x";
  }

  // Parse "one per line" pillars into [{id, name}], keeping ids stable.
  function pillarsFromText(text) {
    var seen = {};
    return String(text || "").split(/\n/).map(function (line) {
      return line.trim();
    }).filter(Boolean).slice(0, 12).map(function (name) {
      var id = slug(name);
      while (seen[id]) id += "-2";
      seen[id] = true;
      return { id: id, name: name.slice(0, 80) };
    });
  }

  // Sample scripts are pasted into one box, separated by a line of ---.
  function samplesFromText(text) {
    return String(text || "").split(/\n\s*-{3,}\s*\n/).map(function (s) {
      return s.trim();
    }).filter(Boolean).slice(0, 5).map(function (s) { return s.slice(0, 3000); });
  }

  // Make sure every cadence day from today through the horizon has one
  // queue item. Pillars and platforms rotate so the mix stays varied.
  // Returns the number of items added. Never touches existing items.
  function planUpcoming(loop, todayIso, horizonDays) {
    if (!isConfigured(loop)) return 0;
    var horizon = horizonDays || 14;
    var taken = {};
    loop.items.forEach(function (it) { taken[it.due] = true; });
    var added = 0;
    for (var i = 0; i < horizon; i++) {
      var iso = addDays(todayIso, i);
      if (taken[iso]) continue;
      if (loop.cadence.days.indexOf(parseIso(iso).getDay()) === -1) continue;
      var platform = loop.platforms[loop.seq % loop.platforms.length];
      var pillar = loop.pillars.length ? loop.pillars[loop.seq % loop.pillars.length] : null;
      loop.items.push({
        id: "it-" + iso + "-" + loop.seq,
        due: iso,
        pillarId: pillar ? pillar.id : "",
        platformId: platform.id,
        status: "planned",
        title: "",
        script: null,
        generatedAt: 0,
        model: "",
        rating: "",
        notes: [],
        decidedAt: 0
      });
      loop.seq += 1;
      added += 1;
    }
    loop.items.sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; });
    return added;
  }

  function upNext(loop) {
    return loop.items.filter(function (it) {
      return it.status === "planned" || it.status === "ready";
    });
  }

  // Items that should have a script written now: no script yet and due
  // within the lookahead window (overdue items included).
  function dueForGeneration(loop, todayIso, lookaheadDays) {
    var limit = addDays(todayIso, lookaheadDays === undefined ? 3 : lookaheadDays);
    return loop.items.filter(function (it) {
      return it.status === "planned" && it.due <= limit;
    });
  }

  function findItem(loop, id) {
    for (var i = 0; i < loop.items.length; i++) if (loop.items[i].id === id) return loop.items[i];
    return null;
  }

  function pillarFor(loop, item) {
    for (var i = 0; i < loop.pillars.length; i++) if (loop.pillars[i].id === item.pillarId) return loop.pillars[i];
    return null;
  }

  function platformFor(loop, item) {
    for (var i = 0; i < loop.platforms.length; i++) if (loop.platforms[i].id === item.platformId) return loop.platforms[i];
    return { id: item.platformId, label: "Video", seconds: 60, orientation: "portrait" };
  }

  // After recording (or skipping): store the outcome and the quick
  // feedback so later prompts can learn from it.
  function recordOutcome(loop, id, status, rating, notes, now) {
    var item = findItem(loop, id);
    if (!item) return null;
    if (status === "recorded" || status === "skipped") item.status = status;
    if (rating === "up" || rating === "down") item.rating = rating;
    if (notes && notes.length) {
      item.notes = notes.map(function (n) { return String(n).trim().slice(0, 200); })
        .filter(Boolean).slice(0, 8);
    }
    item.decidedAt = now || Date.now();
    return item;
  }

  // Recent feedback, newest first, as short lines for the prompt.
  function feedbackLines(loop, max) {
    return loop.items.filter(function (it) {
      return (it.rating || (it.notes && it.notes.length)) && it.decidedAt;
    }).sort(function (a, b) { return b.decidedAt - a.decidedAt; })
      .slice(0, max || 8).map(function (it) {
        var parts = [];
        if (it.rating === "up") parts.push("liked");
        if (it.rating === "down") parts.push("disliked");
        if (it.notes && it.notes.length) parts.push(it.notes.join("; "));
        return "\"" + (it.title || "untitled") + "\": " + parts.join(", ");
      });
  }

  function recentTitles(loop, max) {
    return loop.items.filter(function (it) { return it.title; })
      .sort(function (a, b) { return a.due < b.due ? 1 : -1; })
      .slice(0, max || 12).map(function (it) { return it.title; });
  }

  // ---- prompts ----

  function wordsForSeconds(seconds) {
    return Math.max(20, Math.round(seconds * WORDS_PER_SECOND));
  }

  function profileBlock(loop) {
    var p = loop.profile;
    var lines = [];
    if (p.name) lines.push("Creator: " + p.name);
    if (p.topic) lines.push("Channel topic: " + p.topic);
    if (p.audience) lines.push("Audience: " + p.audience);
    if (p.voice) lines.push("Voice and tone: " + p.voice);
    if (loop.pillars.length) {
      lines.push("Content pillars: " + loop.pillars.map(function (x) { return x.name; }).join(", "));
    }
    return lines.join("\n");
  }

  var SYSTEM_PROMPT =
    "You write spoken teleprompter scripts for a solo video creator. " +
    "Write the way this creator talks to camera: short sentences, plain words, no jargon they would not use. " +
    "Plain text only: no markdown, no emoji, no stage directions, no [pause] or camera notes.";

  var FORMAT_RULES =
    "Reply in exactly this format, with nothing before or after:\n" +
    "TITLE: <working title, under 70 characters>\n" +
    "HOOK:\n<1 to 3 short sentences that stop the scroll in the first 3 seconds>\n" +
    "BODY:\n<the main content>\n" +
    "CTA:\n<one or two sentences: the call to action and sign-off>\n\n" +
    "Teleprompter pacing: put each sentence on its own line, keep most sentences under 15 words, " +
    "and leave a blank line between ideas so the reader can breathe.";

  // Prompt for a whole new script for one queue item.
  function buildScriptPrompt(loop, item) {
    var platform = platformFor(loop, item);
    var pillar = pillarFor(loop, item);
    var parts = [profileBlock(loop), ""];
    parts.push("Write the next video in this creator's content loop.");
    parts.push("Platform: " + platform.label + ". Target length: " + platform.seconds +
      " seconds of talking, about " + wordsForSeconds(platform.seconds) + " words in total.");
    if (pillar) parts.push("Pillar / series for this one: " + pillar.name + ".");
    if (item.title) parts.push("Working title to keep: " + item.title);
    var titles = recentTitles(loop, 12).filter(function (t) { return t !== item.title; });
    if (titles.length) {
      parts.push("", "Already planned or recorded, so pick a fresh angle:\n- " + titles.join("\n- "));
    }
    var fb = feedbackLines(loop, 8);
    if (fb.length) {
      parts.push("", "Feedback on recent scripts (lean into what was liked, fix what was not):\n- " + fb.join("\n- "));
    }
    if (loop.profile.samples.length) {
      parts.push("", "Past scripts in the creator's own voice (match the style, do not reuse the content):");
      loop.profile.samples.slice(0, 3).forEach(function (s, i) {
        parts.push("--- sample " + (i + 1) + " ---\n" + s.slice(0, 1500));
      });
    }
    parts.push("", FORMAT_RULES);
    return { system: SYSTEM_PROMPT, user: parts.join("\n") };
  }

  var SECTION_LABELS = { hook: "HOOK", body: "BODY", cta: "CTA" };

  // Prompt to rewrite one section while keeping the rest.
  function buildSectionPrompt(loop, item, section) {
    var platform = platformFor(loop, item);
    var s = item.script || { hook: "", body: "", cta: "" };
    var label = SECTION_LABELS[section];
    var user = [
      profileBlock(loop), "",
      "Here is a teleprompter script for " + platform.label + " (" + platform.seconds + " seconds):",
      "TITLE: " + (item.title || ""),
      "HOOK:\n" + s.hook, "BODY:\n" + s.body, "CTA:\n" + s.cta, "",
      "Rewrite only the " + label + " section. Make it clearly different from the current one and keep it consistent with the rest.",
      feedbackLines(loop, 5).length ? "Recent feedback: " + feedbackLines(loop, 5).join(" | ") : "",
      "Reply with only the new " + label + " text: no label, no quotes. One sentence per line."
    ].filter(function (x) { return x !== ""; }).join("\n");
    return { system: SYSTEM_PROMPT, user: user };
  }

  // ---- parsing and prompter formatting ----

  function stripMarkdown(text) {
    return String(text || "").replace(/\r/g, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1")
      .replace(/^#+\s*/gm, "").replace(/^\s*[-*]\s+/gm, "")
      .trim();
  }

  // Read TITLE/HOOK/BODY/CTA out of a model reply. If the labels are
  // missing, fall back to first paragraph = hook, last = CTA.
  function parseScriptResponse(text) {
    var clean = stripMarkdown(text).replace(/^```[a-z]*\n?|```$/gm, "").trim();
    var re = /^\s*(TITLE|HOOK|BODY|CTA)\s*:\s*/gim;
    var marks = [];
    var m;
    while ((m = re.exec(clean))) marks.push({ key: m[1].toLowerCase(), start: m.index, end: re.lastIndex });
    var out = { title: "", hook: "", body: "", cta: "" };
    if (marks.length >= 2) {
      marks.forEach(function (mk, i) {
        var stop = i + 1 < marks.length ? marks[i + 1].start : clean.length;
        out[mk.key] = clean.slice(mk.end, stop).trim();
      });
    } else {
      var paras = clean.split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean);
      if (paras.length >= 3) {
        out.hook = paras[0];
        out.cta = paras[paras.length - 1];
        out.body = paras.slice(1, -1).join("\n\n");
      } else {
        out.body = paras.join("\n\n");
      }
    }
    out.title = out.title.split("\n")[0].replace(/^["']|["']$/g, "").slice(0, 100);
    if (!out.hook && !out.body && !out.cta) return null;
    return out;
  }

  // One sentence per line, blank lines kept between paragraphs.
  function formatForPrompter(text) {
    return String(text || "").replace(/\r/g, "").split(/\n\s*\n/).map(function (para) {
      return para.replace(/\s*\n\s*/g, " ").trim()
        .replace(/([.!?]["')\]]?)\s+(?=["'(\[]?[A-Z0-9])/g, "$1\n");
    }).filter(Boolean).join("\n\n");
  }

  function scriptToPrompterText(script) {
    if (!script) return "";
    return [script.hook, script.body, script.cta].map(formatForPrompter)
      .filter(Boolean).join("\n\n");
  }

  // ---- hosted writer brief ----
  // The hosted writer (our Worker) only takes the five interview fields,
  // so the loop context is folded into them. "point" is capped at 500
  // characters server-side and length at 300 seconds.
  function briefForHosted(loop, item) {
    var platform = platformFor(loop, item);
    var pillar = pillarFor(loop, item);
    var avoid = recentTitles(loop, 4).filter(function (t) { return t !== item.title; });
    var fb = feedbackLines(loop, 3);
    var point = [
      item.title ? "Video: " + item.title + "." : "",
      pillar ? "Series: " + pillar.name + ". Pick one fresh, specific idea in this series." : "Pick one fresh, specific idea for this channel.",
      "Open with a strong hook, end with a clear call to action.",
      avoid.length ? "Not these (already done): " + avoid.join("; ") + "." : "",
      fb.length ? "Feedback: " + fb.join(" | ") : ""
    ].filter(Boolean).join(" ").slice(0, 500);
    return {
      name: loop.profile.name.slice(0, 80),
      role: ("I make videos about " + loop.profile.topic).slice(0, 200),
      audience: loop.profile.audience.slice(0, 200),
      point: point,
      lengthSeconds: Math.min(300, Math.max(15, platform.seconds)),
      tone: loop.profile.voice.slice(0, 80)
    };
  }

  return {
    LOOP_KEY: LOOP_KEY,
    DAY_NAMES: DAY_NAMES,
    PLATFORM_PRESETS: PLATFORM_PRESETS,
    FEEDBACK_CHIPS: FEEDBACK_CHIPS,
    defaultLoop: defaultLoop,
    isConfigured: isConfigured,
    loadLoop: loadLoop,
    saveLoop: saveLoop,
    isoDate: isoDate,
    addDays: addDays,
    dueLabel: dueLabel,
    pillarsFromText: pillarsFromText,
    samplesFromText: samplesFromText,
    planUpcoming: planUpcoming,
    upNext: upNext,
    dueForGeneration: dueForGeneration,
    findItem: findItem,
    pillarFor: pillarFor,
    platformFor: platformFor,
    recordOutcome: recordOutcome,
    feedbackLines: feedbackLines,
    wordsForSeconds: wordsForSeconds,
    buildScriptPrompt: buildScriptPrompt,
    buildSectionPrompt: buildSectionPrompt,
    parseScriptResponse: parseScriptResponse,
    formatForPrompter: formatForPrompter,
    scriptToPrompterText: scriptToPrompterText,
    briefForHosted: briefForHosted
  };
}));
