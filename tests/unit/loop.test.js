// Unit tests for smart/loop.js. Run: node --test tests/unit/
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../../smart/loop.js");

function sampleLoop() {
  const loop = L.defaultLoop();
  loop.profile = { name: "Sam Test", topic: "home coffee brewing", audience: "beginners",
    voice: "friendly, no jargon", samples: ["My old script about grinders."] };
  loop.pillars = L.pillarsFromText("Quick tips\nGear reviews\nMyths");
  loop.platforms = [
    { id: "short", label: "TikTok / YouTube Short", seconds: 30, orientation: "portrait" },
    { id: "youtube", label: "YouTube video", seconds: 480, orientation: "landscape" }
  ];
  loop.cadence = { days: [1, 3, 5] }; // Mon, Wed, Fri
  return loop;
}

function memoryStorage() {
  const m = {};
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; }, m };
}

test("plans one item per posting day across the horizon", () => {
  const loop = sampleLoop();
  const added = L.planUpcoming(loop, "2026-10-19", 14); // a Monday
  assert.equal(added, 6);
  assert.deepEqual(loop.items.map(i => i.due),
    ["2026-10-19", "2026-10-21", "2026-10-23", "2026-10-26", "2026-10-28", "2026-10-30"]);
  assert.ok(loop.items.every(i => i.status === "planned"));
});

test("rotates platforms and pillars", () => {
  const loop = sampleLoop();
  L.planUpcoming(loop, "2026-10-19", 14);
  assert.deepEqual(loop.items.slice(0, 4).map(i => i.platformId), ["short", "youtube", "short", "youtube"]);
  assert.deepEqual(loop.items.slice(0, 4).map(i => i.pillarId), ["quick-tips", "gear-reviews", "myths", "quick-tips"]);
});

test("planning is idempotent and keeps existing items", () => {
  const loop = sampleLoop();
  L.planUpcoming(loop, "2026-10-19", 14);
  loop.items[0].title = "Keep me";
  assert.equal(L.planUpcoming(loop, "2026-10-19", 14), 0);
  assert.equal(loop.items[0].title, "Keep me");
  assert.equal(L.planUpcoming(loop, "2026-10-19", 21), 3);
});

test("an unconfigured loop plans nothing", () => {
  assert.equal(L.planUpcoming(L.defaultLoop(), "2026-10-19", 14), 0);
});

test("due for generation = planned items within the lookahead, overdue included", () => {
  const loop = sampleLoop();
  L.planUpcoming(loop, "2026-10-19", 14);
  loop.items.unshift({ id: "old", due: "2026-10-16", status: "planned" });
  loop.items[2].status = "ready";
  const due = L.dueForGeneration(loop, "2026-10-19", 3).map(i => i.due);
  assert.deepEqual(due, ["2026-10-16", "2026-10-19"]);
});

test("up next hides recorded and skipped", () => {
  const loop = sampleLoop();
  L.planUpcoming(loop, "2026-10-19", 14);
  L.recordOutcome(loop, loop.items[0].id, "recorded", "up", ["Great hook"], 1);
  L.recordOutcome(loop, loop.items[1].id, "skipped", "", [], 2);
  assert.equal(L.upNext(loop).length, 4);
});

test("feedback goes into the next prompt", () => {
  const loop = sampleLoop();
  L.planUpcoming(loop, "2026-10-19", 14);
  loop.items[0].title = "Why your grinder matters";
  L.recordOutcome(loop, loop.items[0].id, "recorded", "down", ["Too long", "less intro"], 5);
  const p = L.buildScriptPrompt(loop, loop.items[1]);
  assert.match(p.user, /Why your grinder matters": disliked, Too long; less intro/);
  assert.match(p.user, /pick a fresh angle/);
  assert.match(p.user, /YouTube video\. Target length: 480 seconds.*about 1152 words/);
  assert.match(p.user, /Pillar \/ series for this one: Gear reviews/);
  assert.match(p.user, /sample 1 ---\nMy old script about grinders\./);
  assert.match(p.user, /TITLE:[\s\S]*HOOK:[\s\S]*BODY:[\s\S]*CTA:/);
  assert.match(p.user, /each sentence on its own line/);
});

test("section prompt asks for one section only", () => {
  const loop = sampleLoop();
  L.planUpcoming(loop, "2026-10-19", 14);
  const it = loop.items[0];
  it.title = "T"; it.script = { hook: "H.", body: "B.", cta: "C." };
  const p = L.buildSectionPrompt(loop, it, "hook");
  assert.match(p.user, /Rewrite only the HOOK section/);
  assert.match(p.user, /Reply with only the new HOOK text/);
});

test("parses a labelled reply", () => {
  const r = L.parseScriptResponse("TITLE: Bloom your coffee\nHOOK:\nStop pouring all at once.\nBODY:\nWet the grounds first.\nWait thirty seconds.\nCTA:\nFollow for more.");
  assert.deepEqual(r, { title: "Bloom your coffee", hook: "Stop pouring all at once.",
    body: "Wet the grounds first.\nWait thirty seconds.", cta: "Follow for more." });
});

test("parses markdown-ish labels", () => {
  const r = L.parseScriptResponse("**TITLE:** A\n**HOOK:** Hi.\n**BODY:** Middle.\n**CTA:** Bye.");
  assert.equal(r.title, "A"); assert.equal(r.hook, "Hi."); assert.equal(r.cta, "Bye.");
});

test("falls back to paragraphs when labels are missing", () => {
  const r = L.parseScriptResponse("Hook line.\n\nMiddle one.\n\nMiddle two.\n\nFollow me.");
  assert.equal(r.hook, "Hook line.");
  assert.equal(r.body, "Middle one.\n\nMiddle two.");
  assert.equal(r.cta, "Follow me.");
  assert.equal(L.parseScriptResponse("   "), null);
});

test("prompter text is one sentence per line with breathing room", () => {
  const text = L.scriptToPrompterText({ hook: "Stop. Look at this!", body: "First idea is here. Second one?\n\nNew thought.", cta: "Follow for more." });
  assert.equal(text, "Stop.\nLook at this!\n\nFirst idea is here.\nSecond one?\n\nNew thought.\n\nFollow for more.");
});

test("hosted brief respects the Worker's limits", () => {
  const loop = sampleLoop();
  L.planUpcoming(loop, "2026-10-19", 14);
  for (let i = 0; i < 6; i++) { loop.items[i].title = "A fairly long working title number " + i + " ".repeat(10) + "x".repeat(60); }
  const b = L.briefForHosted(loop, loop.items[1]);
  assert.ok(b.point.length <= 500);
  assert.equal(b.lengthSeconds, 300); // 8 min clamps to the hosted max
  assert.equal(b.role, "I make videos about home coffee brewing");
  assert.equal(b.tone, "friendly, no jargon");
});

test("pillars and samples parse from text", () => {
  assert.deepEqual(L.pillarsFromText("A\n\nA\nB "), [{ id: "a", name: "A" }, { id: "a-2", name: "A" }, { id: "b", name: "B" }]);
  assert.deepEqual(L.samplesFromText("one\n---\ntwo\n -----\nthree"), ["one", "two", "three"]);
});

test("load/save round trip; corrupt data falls back to a fresh loop", () => {
  const s = memoryStorage();
  const loop = sampleLoop();
  L.saveLoop(s, loop);
  assert.equal(L.loadLoop(s).profile.topic, "home coffee brewing");
  s.setItem(L.LOOP_KEY, "{not json");
  assert.deepEqual(L.loadLoop(s), L.defaultLoop());
});

test("due labels", () => {
  assert.equal(L.dueLabel("2026-10-19", "2026-10-19"), "Today · Mon Oct 19");
  assert.equal(L.dueLabel("2026-10-20", "2026-10-19"), "Tomorrow · Tue Oct 20");
  assert.equal(L.dueLabel("2026-10-16", "2026-10-19"), "Overdue · Fri Oct 16");
});
