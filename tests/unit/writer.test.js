// Unit tests for smart/writer.js with mocked providers and a mocked hosted writer.
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../../smart/loop.js");
const W = require("../../smart/writer.js");

const REPLY = "TITLE: Bloom your coffee\nHOOK:\nStop pouring all at once.\nBODY:\nWet the grounds first.\nCTA:\nFollow for more.";

function loop() {
  const l = L.defaultLoop();
  l.profile = { name: "Sam", topic: "coffee", audience: "beginners", voice: "warm", samples: [] };
  l.pillars = L.pillarsFromText("Tips");
  l.platforms = [{ id: "short", label: "Short", seconds: 30, orientation: "portrait" }];
  l.cadence = { days: [0, 1, 2, 3, 4, 5, 6] };
  L.planUpcoming(l, "2026-10-19", 7);
  return l;
}

function fetchReturning(content) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }; };
  f.calls = calls;
  return f;
}

const ai = { provider: "openai", model: "gpt-test", key: "sk-test-123456789" };

test("your AI: writes a ready-to-record script", async () => {
  const l = loop();
  const f = fetchReturning(REPLY);
  const it = await W.writeItem(l, l.items[0], { ai, fetch: f }, 42);
  assert.equal(it.status, "ready");
  assert.equal(it.title, "Bloom your coffee");
  assert.deepEqual(it.script, { hook: "Stop pouring all at once.", body: "Wet the grounds first.", cta: "Follow for more." });
  assert.equal(it.model, "OpenAI · gpt-test");
  assert.equal(it.generatedAt, 42);
});

test("hosted writer: never sees a key, gets the loop brief, title falls back to the hook", async () => {
  const l = loop();
  const briefs = [];
  const hosted = { generate: async b => { briefs.push(b); return { script: "Stop pouring all at once, seriously.\n\nWet the grounds.\n\nFollow me." }; } };
  const it = await W.writeItem(l, l.items[0], { ai: null, hosted });
  assert.equal(it.status, "ready");
  assert.equal(it.title, "Stop pouring all at once, seriously");
  assert.equal(it.model, "ClickPrompt writer");
  assert.equal(briefs[0].role, "I make videos about coffee");
  assert.ok(!JSON.stringify(briefs[0]).includes("sk-"));
});

test("writeDue writes up to max and stops at the free cap", async () => {
  const l = loop();
  let n = 0;
  const hosted = { generate: async () => {
    n += 1;
    if (n === 3) { const e = new Error("You've used your 3 free scripts today."); e.code = "daily_limit"; throw e; }
    return { script: "Hook.\n\nBody.\n\nCTA." };
  } };
  const res = await W.writeDue(l, "2026-10-19", { ai: null, hosted }, { max: 5, lookaheadDays: 6 });
  assert.equal(res.written, 2);
  assert.match(res.error.message, /3 free scripts/);
  assert.equal(l.items.filter(i => i.status === "ready").length, 2);
});

test("writeDue only looks ahead 3 days by default", async () => {
  const l = loop();
  const f = fetchReturning(REPLY);
  const res = await W.writeDue(l, "2026-10-19", { ai, fetch: f }, { max: 10 });
  assert.equal(res.written, 4); // Oct 19..22
});

test("rewriting one section leaves the others alone", async () => {
  const l = loop();
  const it = l.items[0];
  it.status = "ready"; it.title = "T";
  it.script = { hook: "Old hook.", body: "Body stays.", cta: "CTA stays." };
  const f = fetchReturning("HOOK: Brand new hook.");
  await W.rewriteSection(l, it, "hook", { ai, fetch: f });
  assert.deepEqual(it.script, { hook: "Brand new hook.", body: "Body stays.", cta: "CTA stays." });
  assert.match(JSON.parse(f.calls[0].init.body).messages[1].content, /Rewrite only the HOOK section/);
  await assert.rejects(W.rewriteSection(l, it, "intro", { ai, fetch: f }), /Unknown section/);
});
