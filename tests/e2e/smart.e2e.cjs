// End-to-end check of the smart teleprompter in a real browser, with every
// network call mocked (AI providers, OpenRouter, and our Worker). No real
// API calls, no real keys.
//
// Needs Playwright (not a repo dependency, so Cloudflare Pages has nothing
// to install):
//   npm i -g playwright && npx playwright install chromium webkit
//   node tests/e2e/smart.e2e.cjs [screenshot-dir]
const { chromium, webkit, devices } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");

const ROOT = path.resolve(__dirname, "../..");
const SHOTS = process.argv[2] || "";
const FAKE_KEY = "sk-test-FAKE-e2e-0000000000";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".mp3": "audio/mpeg" };

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p === "/") p = "/index.html";
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

let aiCount = 0;
function scriptReply(n) {
  return "TITLE: Coffee fix #" + n + ": bloom your grounds\nHOOK:\nYour coffee tastes flat for one reason. You skip the bloom.\n" +
    "BODY:\nPour just enough water to wet the grounds. Wait thirty seconds.\nYou'll see bubbles. That's gas leaving.\n\n" +
    "Then pour the rest slowly, in circles. That's it.\nCTA:\nTry it tomorrow and tell me if you taste the difference. Follow for more quick fixes.";
}

// Every outside request goes through here. Records what was sent where.
async function mockNetwork(context, log) {
  await context.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await context.route("https://teleprompter-script-api.synaptiqs.workers.dev/**", async route => {
    const req = route.request();
    log.push({ host: "worker", url: req.url(), body: req.postData() || "" });
    const p = new URL(req.url()).pathname;
    if (p === "/api/generate-script") {
      return route.fulfill({ json: { script: "Your coffee tastes flat because you rush it.\n\nWet the grounds and wait thirty seconds.\n\nFollow for more fixes.", remaining: 2, subscribed: false } });
    }
    return route.fulfill({ json: { ok: true, unlocked: false } });
  });
  await context.route("https://api.openai.com/**", async route => {
    const req = route.request();
    log.push({ host: "openai", url: req.url(), body: req.postData() || "", auth: req.headers().authorization });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204 });
    if (req.url().endsWith("/v1/models")) return route.fulfill({ json: { data: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }] } });
    const body = JSON.parse(req.postData());
    const user = body.messages[1].content;
    aiCount += 1;
    const content = /Rewrite only the HOOK/.test(user) ? "Stop. Your coffee isn't bad beans. It's a skipped step." : scriptReply(aiCount);
    return route.fulfill({ json: { choices: [{ message: { content } }] } });
  });
  await context.route("https://openrouter.ai/**", async route => {
    const req = route.request();
    const u = new URL(req.url());
    log.push({ host: "openrouter", url: req.url(), body: req.postData() || "" });
    if (u.pathname === "/auth") {
      const back = u.searchParams.get("callback_url") + "?code=or-test-code&state=" + encodeURIComponent(u.searchParams.get("state"));
      return route.fulfill({ status: 302, headers: { Location: back } });
    }
    if (u.pathname === "/api/v1/auth/keys") return route.fulfill({ json: { key: "sk-or-test-user-key" } });
    return route.fulfill({ json: { data: [] } });
  });
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

async function newPage(browser, opts, base) {
  const context = await browser.newContext(Object.assign({
    permissions: browser.browserType().name() === "chromium" ? ["camera", "microphone"] : []
  }, opts));
  await context.addInitScript(() => {
    localStorage.setItem("clickprompt_tour_seen", "1");
    localStorage.setItem("cp_platform", JSON.stringify({ key: "skipped", label: "skipped" }));
  });
  const log = [];
  await mockNetwork(context, log);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.clock.setFixedTime(new Date("2026-10-19T09:00:00"));
  await page.goto(base);
  return { context, page, log, errors };
}

async function desktopFlow(browser, base) {
  const { context, page, log, errors } = await newPage(browser, { viewport: { width: 1280, height: 900 } }, base);

  // 1. Empty state.
  await page.waitForSelector("#smartEmpty:not([hidden])");
  await shot(page, "desktop-01-up-next-empty");

  // 2. Content loop.
  await page.click("#setupLoop");
  await page.fill("#loopName", "Sam Rivera");
  await page.fill("#loopTopic", "Better coffee at home in 5 minutes");
  await page.fill("#loopAudience", "busy beginners with a basic kettle");
  await page.fill("#loopVoice", "warm, quick, a little funny");
  await page.fill("#loopSamples", "Okay, quick one. Your grinder matters more than your beans.\n---\nStop buying pods. Here's why.");
  await page.fill("#loopPillars", "Quick fixes\nGear on a budget\nCoffee myths");
  await page.check("#lp-short");
  await page.check("#lp-youtube");
  await page.selectOption("[aria-label='YouTube video length']", "480");
  await shot(page, "desktop-02-content-loop");
  await page.click("#loopSave");

  // 3. Planned queue, written by the hosted writer on request.
  await page.waitForSelector(".queue-item");
  const planned = await page.$$eval(".queue-item", els => els.map(e => e.getAttribute("data-status")));
  assert.ok(planned.length >= 4 && planned.every(s => s === "planned"), "queue planned: " + planned);
  assert.match(await page.textContent(".queue-item .q-when"), /^Today · Mon Oct 19/);
  await shot(page, "desktop-03-up-next-planned");
  await page.click(".queue-item >> text=Write it");
  await page.waitForSelector(".queue-item[data-status='ready']");
  const gen = log.filter(l => l.host === "worker" && l.url.endsWith("/api/generate-script"));
  assert.equal(gen.length, 1);
  const brief = JSON.parse(gen[0].body);
  assert.equal(brief.role, "I make videos about Better coffee at home in 5 minutes");
  assert.equal(brief.lengthSeconds, 30);
  assert.ok(brief.visitor_id, "hosted call carries the free-cap visitor id");

  // 4. Connect your AI (OpenAI, mocked).
  await page.click("#openAi");
  await page.selectOption("#aiProvider", "openai");
  await page.fill("#aiKey", FAKE_KEY);
  await page.click("#aiSave");
  await page.waitForFunction(() => /Saved on this device/.test(document.getElementById("aiStatus").textContent));
  assert.match(await page.textContent("#aiStatus"), /gpt-6-luna is ready/);
  await shot(page, "desktop-04-connect-ai");
  await page.click("#aiClose");

  // 5. Auto-write: due items get scripts ahead of time.
  await page.waitForFunction(() => document.querySelectorAll(".queue-item[data-status='ready']").length >= 2);
  await page.waitForFunction(() => /ready to record/.test(document.getElementById("smartStatus").textContent));
  assert.match(await page.textContent("#aiLabel"), /AI: OpenAI/);
  await shot(page, "desktop-05-up-next-ready");

  // 6. Editor + regenerate one section.
  await page.click(".queue-item[data-status='ready'] >> nth=1 >> text=Edit");
  await page.waitForSelector("#itemDialog[open]");
  const bodyBefore = await page.inputValue("#itemBody");
  await page.click("[data-regen='hook']");
  await page.waitForFunction(() => /isn't bad beans/.test(document.getElementById("itemHook").value));
  assert.equal(await page.inputValue("#itemBody"), bodyBefore, "body untouched by hook regen");
  await shot(page, "desktop-06-script-editor");

  // 7. One tap into the prompter.
  await page.click("#itemRecord");
  await page.waitForSelector("#app[data-view='prompter']");
  const prompt = await page.textContent("#promptCopy");
  assert.match(prompt, /^Stop\.\nYour coffee isn't bad beans\./);
  assert.match(prompt, /Follow for more quick fixes\.$/);
  await page.waitForTimeout(600);
  await shot(page, "desktop-07-prompter");

  // 8. After the take: Recorded + feedback.
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent("cp:take-complete"));
    document.getElementById("reviewDialog").showModal();
  });
  await page.waitForSelector("#takeFeedback:not([hidden]) >> text=How did it go?");
  await page.click("#takeFeedback >> text=Liked it");
  await page.click("#takeFeedback >> text=Too long");
  await page.fill("#takeFeedback input[type='text']", "more examples");
  await shot(page, "desktop-08-take-feedback");
  await page.click("#takeFeedback >> text=Mark recorded");
  await page.waitForSelector("#takeFeedback >> text=Marked recorded.");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("cp_loop_v1")));
  const rec = saved.items.find(i => i.status === "recorded");
  assert.equal(rec.rating, "up");
  assert.deepEqual(rec.notes, ["Too long", "more examples"]);

  // Feedback reaches the next prompt.
  await page.evaluate(() => document.getElementById("reviewDialog").close());
  await page.click("#changeScript");
  await page.click(".queue-item[data-status='ready'] >> nth=0 >> text=Edit");
  await page.click("#itemRegenAll");
  await page.waitForFunction(() => /Fresh script in/.test(document.getElementById("itemStatus").textContent));
  const lastPrompt = JSON.parse(log.filter(l => l.host === "openai" && l.url.endsWith("/chat/completions")).pop().body).messages[1].content;
  assert.match(lastPrompt, /liked, Too long; more examples/);
  await page.click("#itemClose");

  // Key privacy: only api.openai.com ever saw it; it lives in localStorage.
  for (const l of log) {
    if (l.host !== "openai") assert.ok(!l.url.includes(FAKE_KEY) && !l.body.includes(FAKE_KEY), "key sent to " + l.host);
  }
  assert.ok(log.filter(l => l.host === "openai").every(l => l.auth === "Bearer " + FAKE_KEY));
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("cp_ai_v1"))).key, FAKE_KEY);

  // Remove key.
  await page.click("#openAi");
  await page.click("#aiRemove");
  assert.equal(await page.evaluate(() => localStorage.getItem("cp_ai_v1")), null);
  assert.match(await page.textContent("#aiStatus"), /Key removed from this device/);

  // OpenRouter OAuth PKCE round trip (mocked).
  await page.click("#aiOpenRouter");
  await page.waitForFunction(() => /Connected with OpenRouter/.test(document.getElementById("smartStatus").textContent));
  assert.equal(new URL(page.url()).search, "", "code removed from the URL");
  const or = JSON.parse(await page.evaluate(() => localStorage.getItem("cp_ai_v1")));
  assert.deepEqual([or.provider, or.key, or.via], ["openrouter", "sk-or-test-user-key", "oauth"]);
  const exchange = log.find(l => l.url.endsWith("/api/v1/auth/keys"));
  assert.equal(JSON.parse(exchange.body).code_challenge_method, "S256");

  const state = await page.evaluate(() => ({ loop: localStorage.getItem("cp_loop_v1") }));
  assert.deepEqual(errors, []);
  await context.close();
  return state;
}

async function phoneFlow(browser, base, state, tag) {
  const device = devices["iPhone 13"];
  const { context, page, errors } = await newPage(browser, Object.assign({}, device), base);
  await page.evaluate(s => {
    localStorage.setItem("cp_loop_v1", s.loop);
    localStorage.setItem("cp_ai_v1", JSON.stringify({ provider: "anthropic", model: "claude-sonnet-5", key: "sk-ant-test-FAKE-1234", via: "key" }));
  }, state);
  await page.reload();
  await page.waitForSelector(".queue-item[data-status='ready']");
  await shot(page, tag + "-01-up-next");
  await page.click("#openAi");
  await page.waitForSelector("#aiDialog[open]");
  assert.match(await page.getAttribute("#aiKey", "placeholder"), /Saved on this device: sk-a…1234/);
  await shot(page, tag + "-02-connect-ai");
  await page.click("#aiClose");
  await page.click(".queue-item[data-status='ready'] >> nth=0 >> text=Edit");
  await page.waitForSelector("#itemDialog[open]");
  await shot(page, tag + "-03-script-editor");
  await page.click("#itemClose");
  await page.click("#openLoop");
  await shot(page, tag + "-04-content-loop");
  assert.deepEqual(errors, []);
  await context.close();
}

(async () => {
  const srv = await serve();
  const base = "http://127.0.0.1:" + srv.address().port + "/";
  const chrome = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  let failed = false;
  try {
    const state = await desktopFlow(chrome, base);
    console.log("ok - desktop flow (chromium)");
    await phoneFlow(chrome, base, state, "phone");
    console.log("ok - phone flow (chromium, iPhone 13 viewport)");
    const safari = await webkit.launch();
    await phoneFlow(safari, base, state, "phone-webkit");
    await safari.close();
    console.log("ok - phone flow (webkit, iPhone 13 viewport)");
  } catch (e) {
    failed = true;
    console.error("not ok -", e && e.stack || e);
  } finally {
    await chrome.close();
    srv.close();
  }
  process.exit(failed ? 1 : 0);
})();
