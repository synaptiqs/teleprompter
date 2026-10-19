// ClickPrompt smart teleprompter: the screens.
// Up next queue, Connect your AI, Content loop, and the script editor.
// Logic lives in smart/loop.js, smart/ai.js and smart/writer.js; this file
// only wires them to the page. Model output is always inserted as text,
// never as HTML.
(function () {
  "use strict";

  var L = window.CPLoop;
  var AI = window.CPAI;
  var W = window.CPWriter;
  var APP = window.ClickPromptApp;
  if (!L || !AI || !W || !APP) return;

  var CURRENT_KEY = "cp_loop_current"; // sessionStorage: item loaded in the prompter
  var LENGTHS = [15, 30, 45, 60, 90, 120, 180, 300, 480, 600, 900];

  var store = window.localStorage;
  var session = window.sessionStorage;
  var loop = L.loadLoop(store);
  var ai = AI.loadSettings(store);
  var busy = false;
  var writingId = "";
  var editingId = "";

  function $(id) { return document.getElementById(id); }
  function today() { return L.isoDate(new Date()); }
  function save() { L.saveLoop(store, loop); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function openDialog(d) {
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
    // Focus the sheet, not the first field, so phones don't pop the keyboard.
    var sheet = d.querySelector(".sheet");
    if (sheet) sheet.focus();
  }
  function closeDialog(d) { if (typeof d.close === "function") d.close(); else d.removeAttribute("open"); }
  function lengthLabel(s) { return s < 60 ? s + "s" : (s % 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s / 60 + " min"); }
  function status(msg) { $("smartStatus").textContent = msg || ""; }

  function writerDeps() {
    return { ai: ai, fetch: window.fetch.bind(window), hosted: { generate: APP.hostedGenerate } };
  }

  // ---------------- Up next queue ----------------

  function render() {
    var configured = L.isConfigured(loop);
    $("smartEmpty").hidden = configured;
    $("aiLabel").textContent = ai ? "AI: " + AI.PROVIDERS[ai.provider].label : "Connect your AI";
    $("aiDot").classList.toggle("on", !!ai);
    var list = $("queueList");
    list.textContent = "";
    if (!configured) return;
    var items = L.upNext(loop).slice(0, 6);
    if (!items.length) {
      list.appendChild(el("li", "queue-empty", "Nothing due. Check your posting days in Content loop."));
      return;
    }
    items.forEach(function (it) { list.appendChild(queueItem(it)); });
  }

  function queueItem(it) {
    var platform = L.platformFor(loop, it);
    var pillar = L.pillarFor(loop, it);
    var li = el("li", "queue-item");
    li.setAttribute("data-status", writingId === it.id ? "writing" : it.status);
    li.setAttribute("data-item", it.id);
    var top = el("div", "q-top");
    top.appendChild(el("span", "q-when", L.dueLabel(it.due, today())));
    top.appendChild(el("span", "q-pill", writingId === it.id ? "Writing…" : it.status === "ready" ? "Ready" : "Not written"));
    li.appendChild(top);
    li.appendChild(el("div", "q-what", platform.label + " · " + lengthLabel(platform.seconds) + (pillar ? " · " + pillar.name : "")));
    li.appendChild(el("div", "q-title", it.title || (it.status === "ready" ? "Untitled video" : "Script not written yet")));
    var actions = el("div", "q-actions");
    if (it.status === "ready") {
      actions.appendChild(button("Record now", "primary", function () { record(it.id); }));
      actions.appendChild(button("Edit", "secondary", function () { openItem(it.id); }));
    } else {
      var write = button("Write it", "secondary", function () { writeOne(it.id); });
      write.disabled = busy;
      actions.appendChild(write);
    }
    actions.appendChild(button("Skip", "text-link", function () {
      L.recordOutcome(loop, it.id, "skipped", "", [], Date.now());
      afterChange("Skipped. It won't come back.");
    }));
    li.appendChild(actions);
    return li;
  }

  function button(label, cls, onClick) {
    var b = el("button", cls, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  // Load an item's script into the prompter and open it.
  function record(id) {
    var it = L.findItem(loop, id);
    if (!it || !it.script) return;
    try { session.setItem(CURRENT_KEY, id); } catch (e) {}
    APP.loadScript(L.scriptToPrompterText(it.script));
    var platform = L.platformFor(loop, it);
    if (platform.orientation) APP.setOrientation(platform.orientation);
    closeDialog($("itemDialog"));
    APP.openPrompter();
  }

  async function writeOne(id) {
    var it = L.findItem(loop, id);
    if (!it || busy) return;
    busy = true; writingId = id; render();
    status(ai ? "Writing with your AI…" : "Writing with the ClickPrompt writer…");
    try {
      await W.writeItem(loop, it, writerDeps());
      save();
      status("Ready to record: " + it.title);
    } catch (e) {
      status(e.message);
    } finally {
      busy = false; writingId = ""; render();
    }
  }

  // On open: with the user's own AI connected, write scripts for anything
  // due in the next 3 days so they're ready to go. The hosted writer is
  // capped, so it only writes when asked ("Write it").
  async function autoWrite() {
    if (!ai || busy || !L.isConfigured(loop)) return;
    if (!L.dueForGeneration(loop, today()).length) return;
    busy = true;
    var res = await W.writeDue(loop, today(), writerDeps(), {
      max: 3,
      onStart: function (it, i, n) { writingId = it.id; render(); status("Writing " + (i + 1) + " of " + n + " ahead of time…"); },
      onDone: function () { save(); }
    });
    busy = false; writingId = "";
    save(); render();
    status(res.error ? res.error.message : res.written ? res.written + (res.written === 1 ? " script" : " scripts") + " ready to record." : "");
  }

  function afterChange(msg) {
    L.planUpcoming(loop, today(), 14);
    save(); render(); status(msg);
    autoWrite();
  }

  // ---------------- feedback after recording ----------------

  function buildFeedback(container, it, onDone) {
    container.textContent = "";
    container.appendChild(el("h3", "section-title", "How did it go?"));
    var rating = it.rating || "";
    var picked = (it.notes || []).filter(function (n) { return L.FEEDBACK_CHIPS.indexOf(n) !== -1; });
    var freeText = (it.notes || []).filter(function (n) { return L.FEEDBACK_CHIPS.indexOf(n) === -1; }).join("; ");
    var rate = el("div", "chip-row");
    [["up", "Liked it"], ["down", "Needs work"]].forEach(function (r) {
      var b = button(r[1], "toggle", function () {
        rating = rating === r[0] ? "" : r[0];
        Array.prototype.forEach.call(rate.children, function (c) { c.setAttribute("aria-pressed", "false"); });
        b.setAttribute("aria-pressed", rating === r[0] ? "true" : "false");
      });
      b.setAttribute("aria-pressed", rating === r[0] ? "true" : "false");
      rate.appendChild(b);
    });
    container.appendChild(rate);
    var chips = el("div", "chip-row");
    L.FEEDBACK_CHIPS.forEach(function (c) {
      var b = button(c, "toggle", function () {
        var i = picked.indexOf(c);
        if (i === -1) picked.push(c); else picked.splice(i, 1);
        b.setAttribute("aria-pressed", picked.indexOf(c) !== -1 ? "true" : "false");
      });
      b.setAttribute("aria-pressed", picked.indexOf(c) !== -1 ? "true" : "false");
      chips.appendChild(b);
    });
    container.appendChild(chips);
    var note = el("input");
    note.type = "text";
    note.placeholder = "Anything for next time? e.g. less intro, more examples";
    note.setAttribute("aria-label", "Note for future scripts");
    note.value = freeText;
    container.appendChild(note);
    container.appendChild(el("p", "fine", "Your feedback shapes the next scripts."));
    var row = el("div", "sheet-actions");
    function finish(state) {
      var notes = picked.slice();
      if (note.value.trim()) notes.push(note.value.trim());
      L.recordOutcome(loop, it.id, state, rating, notes, Date.now());
      try { if (state) session.removeItem(CURRENT_KEY); } catch (e) {}
      if (onDone) onDone(state);
    }
    row.appendChild(button("Mark recorded", "primary", function () { finish("recorded"); }));
    row.appendChild(button("Skip this one", "secondary", function () { finish("skipped"); }));
    container.appendChild(row);
  }

  document.addEventListener("cp:take-complete", function () {
    var id = "";
    try { id = session.getItem(CURRENT_KEY) || ""; } catch (e) {}
    var it = id && L.findItem(loop, id);
    var box = $("takeFeedback");
    if (!it || it.status !== "ready") { box.hidden = true; return; }
    box.hidden = false;
    buildFeedback(box, it, function (state) {
      box.textContent = "";
      var next = L.upNext(loop)[0];
      box.appendChild(el("p", "fine", (state === "recorded" ? "Marked recorded." : "Skipped.") +
        (next ? " Up next: " + (next.title || L.dueLabel(next.due, today())) + "." : "")));
      afterChange("");
    });
  });

  // ---------------- script editor ----------------

  function openItem(id) {
    var it = L.findItem(loop, id);
    if (!it) return;
    editingId = id;
    var platform = L.platformFor(loop, it);
    var pillar = L.pillarFor(loop, it);
    $("itemMeta").textContent = L.dueLabel(it.due, today()) + " · " + platform.label + " · " +
      lengthLabel(platform.seconds) + (pillar ? " · " + pillar.name : "") + (it.model ? " · written by " + it.model : "");
    $("itemTitle").value = it.title || "";
    var s = it.script || { hook: "", body: "", cta: "" };
    $("itemHook").value = s.hook; $("itemBody").value = s.body; $("itemCta").value = s.cta;
    $("itemRegenAll").textContent = it.script ? "Rewrite all" : "Write it";
    $("itemStatus").textContent = "";
    updateLength();
    buildFeedback($("itemFeedback"), it, function (state) {
      closeDialog($("itemDialog"));
      afterChange(state === "recorded" ? "Marked recorded." : "Skipped.");
    });
    openDialog($("itemDialog"));
  }

  function readEditor(it) {
    it.title = $("itemTitle").value.trim();
    var hook = $("itemHook").value.trim(), body = $("itemBody").value.trim(), cta = $("itemCta").value.trim();
    if (hook || body || cta) {
      it.script = { hook: hook, body: body, cta: cta };
      if (it.status === "planned") it.status = "ready";
    }
  }

  function updateLength() {
    var it = L.findItem(loop, editingId);
    if (!it) return;
    var text = [$("itemHook").value, $("itemBody").value, $("itemCta").value].join(" ").trim();
    var words = text ? text.split(/\s+/).length : 0;
    var secs = Math.round(words / 2.4);
    var target = L.platformFor(loop, it).seconds;
    $("itemLength").textContent = words + " words · about " + lengthLabel(Math.max(secs, 0)) +
      " · target " + lengthLabel(target);
  }

  ["itemHook", "itemBody", "itemCta"].forEach(function (id) { $(id).addEventListener("input", updateLength); });

  Array.prototype.forEach.call(document.querySelectorAll("[data-regen]"), function (b) {
    b.addEventListener("click", async function () {
      var it = L.findItem(loop, editingId);
      if (!it || busy) return;
      readEditor(it);
      if (!it.script) { $("itemStatus").textContent = "Write the script first."; return; }
      var section = b.getAttribute("data-regen");
      busy = true; b.disabled = true;
      $("itemStatus").textContent = "Rewriting the " + (section === "cta" ? "call to action" : section) + "…";
      try {
        await W.rewriteSection(loop, it, section, writerDeps());
        $({ hook: "itemHook", body: "itemBody", cta: "itemCta" }[section]).value = it.script[section];
        save(); updateLength();
        $("itemStatus").textContent = "New version in. Edit anything you like.";
      } catch (e) {
        $("itemStatus").textContent = e.message;
      } finally { busy = false; b.disabled = false; }
    });
  });

  $("itemRegenAll").addEventListener("click", async function () {
    var it = L.findItem(loop, editingId);
    if (!it || busy) return;
    readEditor(it);
    busy = true;
    $("itemStatus").textContent = "Writing…";
    try {
      await W.writeItem(loop, it, writerDeps());
      save();
      openItem(it.id);
      $("itemStatus").textContent = "Fresh script in.";
    } catch (e) {
      $("itemStatus").textContent = e.message;
    } finally { busy = false; render(); }
  });

  $("itemRecord").addEventListener("click", function () {
    var it = L.findItem(loop, editingId);
    if (!it) return;
    readEditor(it); save();
    if (!it.script) { $("itemStatus").textContent = "Write the script first."; return; }
    record(it.id);
  });

  $("itemClose").addEventListener("click", function () {
    var it = L.findItem(loop, editingId);
    if (it) { readEditor(it); save(); render(); }
    closeDialog($("itemDialog"));
  });

  // ---------------- content loop setup ----------------

  function openLoop() {
    var p = loop.profile;
    $("loopName").value = p.name; $("loopTopic").value = p.topic;
    $("loopAudience").value = p.audience; $("loopVoice").value = p.voice;
    $("loopSamples").value = p.samples.join("\n---\n");
    $("loopPillars").value = loop.pillars.map(function (x) { return x.name; }).join("\n");
    var rows = $("loopPlatforms");
    rows.textContent = "";
    L.PLATFORM_PRESETS.forEach(function (preset) {
      var current = loop.platforms.filter(function (x) { return x.id === preset.id; })[0];
      var row = el("div", "platform-row");
      var id = "lp-" + preset.id;
      var cb = el("input"); cb.type = "checkbox"; cb.id = id; cb.checked = !!current; cb.value = preset.id;
      var lab = el("label", "", preset.label); lab.htmlFor = id;
      var sel = el("select"); sel.setAttribute("aria-label", preset.label + " length");
      LENGTHS.forEach(function (s) {
        var o = el("option", "", lengthLabel(s)); o.value = String(s);
        if (s === (current ? current.seconds : preset.seconds)) o.selected = true;
        sel.appendChild(o);
      });
      row.appendChild(cb); row.appendChild(lab); row.appendChild(sel);
      rows.appendChild(row);
    });
    var days = $("loopDays");
    days.textContent = "";
    [1, 2, 3, 4, 5, 6, 0].forEach(function (d) {
      var b = button(L.DAY_NAMES[d], "toggle", function () {
        b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
      });
      b.setAttribute("data-day", String(d));
      b.setAttribute("aria-pressed", loop.cadence.days.indexOf(d) !== -1 ? "true" : "false");
      days.appendChild(b);
    });
    $("loopStatus").textContent = "";
    openDialog($("loopDialog"));
  }

  $("loopSave").addEventListener("click", function () {
    var topic = $("loopTopic").value.trim();
    var platforms = [];
    Array.prototype.forEach.call($("loopPlatforms").children, function (row) {
      var cb = row.querySelector("input");
      if (!cb.checked) return;
      var preset = L.PLATFORM_PRESETS.filter(function (x) { return x.id === cb.value; })[0];
      platforms.push({ id: preset.id, label: preset.label, seconds: Number(row.querySelector("select").value), orientation: preset.orientation });
    });
    var days = [];
    Array.prototype.forEach.call($("loopDays").children, function (b) {
      if (b.getAttribute("aria-pressed") === "true") days.push(Number(b.getAttribute("data-day")));
    });
    if (!topic) { $("loopStatus").textContent = "Tell us what your channel is about."; $("loopTopic").focus(); return; }
    if (!platforms.length) { $("loopStatus").textContent = "Pick at least one platform."; return; }
    if (!days.length) { $("loopStatus").textContent = "Pick at least one posting day."; return; }
    loop.profile = {
      name: $("loopName").value.trim().slice(0, 80), topic: topic.slice(0, 200),
      audience: $("loopAudience").value.trim().slice(0, 200), voice: $("loopVoice").value.trim().slice(0, 120),
      samples: L.samplesFromText($("loopSamples").value)
    };
    loop.pillars = L.pillarsFromText($("loopPillars").value);
    loop.platforms = platforms;
    loop.cadence = { days: days.sort() };
    // Re-plan anything not written yet; keep written, recorded and skipped items.
    var t = today();
    loop.items = loop.items.filter(function (it) { return it.status !== "planned" || it.due < t; });
    closeDialog($("loopDialog"));
    afterChange(ai ? "Planned. Writing your next scripts…" : "Planned. Tap Write it on a video, or connect your AI to have scripts written ahead.");
  });

  // ---------------- Connect your AI ----------------

  function fillProvider(provider, keepModel) {
    var info = AI.PROVIDERS[provider];
    var list = $("aiModelList");
    list.textContent = "";
    info.models.forEach(function (m) { var o = el("option"); o.value = m; list.appendChild(o); });
    if (!keepModel) $("aiModel").value = ai && ai.provider === provider ? ai.model : info.models[0];
    $("aiKey").value = "";
    $("aiKey").placeholder = ai && ai.provider === provider ? "Saved on this device: " + AI.maskKey(ai.key) : info.keyHint;
    $("aiKeyLink").href = info.keyUrl;
    $("aiRemove").hidden = !ai;
  }

  function openAi() {
    var provider = ai ? ai.provider : "openai";
    $("aiProvider").value = provider;
    fillProvider(provider);
    $("aiStatus").textContent = ai ? "Connected: " + AI.PROVIDERS[ai.provider].label + " · " + ai.model : "";
    openDialog($("aiDialog"));
  }

  // Settings from the form; reuses the saved key if the field is blank.
  function formSettings() {
    var provider = $("aiProvider").value;
    var key = $("aiKey").value.trim();
    if (!key && ai && ai.provider === provider) key = ai.key;
    return { provider: provider, model: $("aiModel").value.trim() || AI.PROVIDERS[provider].models[0], key: key,
      via: ai && ai.provider === provider && !$("aiKey").value.trim() ? ai.via : "key" };
  }

  $("aiProvider").addEventListener("change", function () { fillProvider($("aiProvider").value); $("aiStatus").textContent = ""; });

  $("aiTest").addEventListener("click", async function () {
    $("aiStatus").textContent = "Testing…";
    var r = await AI.testConnection(formSettings(), window.fetch.bind(window));
    $("aiStatus").textContent = r.message;
  });

  $("aiSave").addEventListener("click", async function () {
    var s = formSettings();
    if (!s.key) { $("aiStatus").textContent = "Paste your API key first."; $("aiKey").focus(); return; }
    $("aiStatus").textContent = "Testing…";
    var r = await AI.testConnection(s, window.fetch.bind(window));
    if (!r.ok) { $("aiStatus").textContent = r.message + " Nothing was saved."; return; }
    ai = AI.saveSettings(store, s);
    fillProvider(ai.provider, true);
    $("aiStatus").textContent = r.message + " Saved on this device.";
    render();
    autoWrite();
  });

  $("aiLoadModels").addEventListener("click", async function () {
    var s = formSettings();
    $("aiStatus").textContent = "Loading models…";
    var models = [];
    if (s.provider === "openrouter") {
      try {
        var res = await fetch("https://openrouter.ai/api/v1/models");
        models = AI.modelIds("openrouter", await res.json());
      } catch (e) { $("aiStatus").textContent = "Couldn't load OpenRouter models."; return; }
    } else {
      var r = await AI.testConnection(s, window.fetch.bind(window));
      if (!r.ok) { $("aiStatus").textContent = r.message; return; }
      models = r.models;
    }
    var list = $("aiModelList");
    list.textContent = "";
    models.slice(0, 300).forEach(function (m) { var o = el("option"); o.value = m; list.appendChild(o); });
    $("aiStatus").textContent = models.length + " models loaded. Start typing in the Model box to pick one.";
  });

  $("aiRemove").addEventListener("click", function () {
    AI.removeSettings(store);
    ai = null;
    fillProvider($("aiProvider").value);
    $("aiStatus").textContent = "Key removed from this device.";
    render();
  });

  $("aiOpenRouter").addEventListener("click", async function () {
    try {
      var url = await AI.startOpenRouterAuth(window.crypto, session, location.origin + location.pathname);
      location.assign(url);
    } catch (e) {
      $("aiStatus").textContent = "Couldn't start OpenRouter sign-in in this browser.";
    }
  });

  // Back from OpenRouter with ?code=...: trade it for the user's key.
  async function finishOpenRouter() {
    var params = new URLSearchParams(location.search);
    if (!params.get("code")) return;
    var hasPending = false;
    try { hasPending = !!session.getItem(AI.PKCE_KEY); } catch (e) {}
    if (!hasPending) return;
    history.replaceState(null, "", location.pathname + location.hash);
    try {
      var key = await AI.finishOpenRouterAuth(params, session, window.fetch.bind(window));
      ai = AI.saveSettings(store, { provider: "openrouter", model: AI.PROVIDERS.openrouter.models[0], key: key, via: "oauth" });
      status("Connected with OpenRouter. Key saved on this device only.");
    } catch (e) {
      status(e.message);
    }
    render();
  }

  $("aiClose").addEventListener("click", function () { closeDialog($("aiDialog")); });
  $("loopClose").addEventListener("click", function () { closeDialog($("loopDialog")); });
  $("openAi").addEventListener("click", openAi);
  $("openLoop").addEventListener("click", openLoop);
  $("setupLoop").addEventListener("click", openLoop);

  // ---------------- start ----------------
  (async function start() {
    await finishOpenRouter();
    L.planUpcoming(loop, today(), 14);
    save();
    render();
    if (L.isConfigured(loop) && !ai && L.dueForGeneration(loop, today()).length) {
      status("Tap Write it to use a free script, or connect your AI to have scripts written ahead.");
    }
    autoWrite();
  })();
}());
