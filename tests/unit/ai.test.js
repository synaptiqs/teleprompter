// Unit tests for smart/ai.js. Every provider call is mocked: no real API calls.
const test = require("node:test");
const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const AI = require("../../smart/ai.js");

const KEY = "sk-test-FAKEKEY-1234567890";
const prompt = { system: "SYS", user: "USER" };

function memoryStorage() {
  const m = {};
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; }, m };
}

// A fake fetch that records calls and answers from a handler.
function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const r = handler(String(url), init || {});
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

test("anthropic request uses the direct-browser-access header", () => {
  const r = AI.buildRequest({ provider: "anthropic", model: "claude-x", key: KEY }, prompt);
  assert.equal(r.url, "https://api.anthropic.com/v1/messages");
  assert.equal(r.init.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(r.init.headers["x-api-key"], KEY);
  const body = JSON.parse(r.init.body);
  assert.equal(body.system, "SYS");
  assert.deepEqual(body.messages, [{ role: "user", content: "USER" }]);
});

test("gemini key goes in a header, not the URL", () => {
  const r = AI.buildRequest({ provider: "gemini", model: "models/gemini-x", key: KEY }, prompt);
  assert.equal(r.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
  assert.ok(!r.url.includes(KEY));
  assert.equal(r.init.headers["x-goog-api-key"], KEY);
  assert.equal(JSON.parse(r.init.body).systemInstruction.parts[0].text, "SYS");
});

test("openai uses max_completion_tokens; xai and openrouter use max_tokens", () => {
  const o = JSON.parse(AI.buildRequest({ provider: "openai", model: "m", key: KEY }, prompt).init.body);
  assert.ok(o.max_completion_tokens && !o.max_tokens);
  const x = AI.buildRequest({ provider: "xai", model: "m", key: KEY }, prompt);
  assert.equal(x.url, "https://api.x.ai/v1/chat/completions");
  assert.ok(JSON.parse(x.init.body).max_tokens);
  const r = AI.buildRequest({ provider: "openrouter", model: "m", key: KEY }, prompt);
  assert.equal(r.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(r.init.headers.Authorization, "Bearer " + KEY);
  assert.equal(r.init.headers["X-Title"], "ClickPrompt");
});

test("parses each provider's reply shape", () => {
  assert.equal(AI.parseResponse("anthropic", { content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "Hi" }] }), "Hi");
  assert.equal(AI.parseResponse("gemini", { candidates: [{ content: { parts: [{ text: "A" }, { text: "B" }] } }] }), "AB");
  assert.equal(AI.parseResponse("openai", { choices: [{ message: { content: " C " } }] }), "C");
  assert.equal(AI.parseResponse("xai", null), "");
});

test("complete() calls only the chosen provider and returns text", async () => {
  const f = mockFetch(() => ({ status: 200, body: { choices: [{ message: { content: "TITLE: x\nHOOK:\nh\nBODY:\nb\nCTA:\nc" } }] } }));
  const text = await AI.complete({ provider: "openai", model: "m", key: KEY }, prompt, f);
  assert.match(text, /HOOK/);
  assert.equal(f.calls.length, 1);
  assert.equal(new URL(f.calls[0].url).host, "api.openai.com");
});

test("errors are friendly and never contain the key", async () => {
  for (const [status, re] of [[401, /didn't accept this key/], [404, /doesn't know that model/], [429, /rate or spend limit/], [500, /error \(500\)/]]) {
    const f = mockFetch(() => ({ status, body: { error: { message: "Incorrect API key provided: " + KEY } } }));
    await assert.rejects(AI.complete({ provider: "openai", model: "m", key: KEY }, prompt, f), e => {
      assert.match(e.message, re);
      assert.ok(!e.message.includes(KEY), "key leaked into: " + e.message);
      return true;
    });
  }
  const down = mockFetch(() => new TypeError("Failed to fetch"));
  await assert.rejects(AI.complete({ provider: "xai", model: "m", key: KEY }, prompt, down), /Couldn't reach xAI/);
  const empty = mockFetch(() => ({ status: 200, body: { choices: [{ message: { content: "" } }] } }));
  await assert.rejects(AI.complete({ provider: "openai", model: "m", key: KEY }, prompt, empty), /empty reply/);
});

test("test connection lists models and checks the chosen one (no tokens spent)", async () => {
  const f = mockFetch(() => ({ status: 200, body: { data: [{ id: "gpt-a" }, { id: "gpt-b" }] } }));
  const ok = await AI.testConnection({ provider: "openai", model: "gpt-b", key: KEY }, f);
  assert.equal(ok.ok, true); assert.equal(ok.modelFound, true);
  assert.equal(f.calls[0].url, "https://api.openai.com/v1/models");
  assert.equal(f.calls[0].init.method, "GET");
  const missing = await AI.testConnection({ provider: "openai", model: "nope", key: KEY }, f);
  assert.equal(missing.ok, true); assert.equal(missing.modelFound, false);
  assert.match(missing.message, /isn't in your OpenAI model list/);

  const g = mockFetch(() => ({ status: 200, body: { models: [
    { name: "models/gemini-a", supportedGenerationMethods: ["generateContent"] },
    { name: "models/embed-1", supportedGenerationMethods: ["embedContent"] }] } }));
  const gr = await AI.testConnection({ provider: "gemini", model: "gemini-a", key: KEY }, g);
  assert.deepEqual(gr.models, ["gemini-a"]);

  const bad = mockFetch(() => ({ status: 401, body: {} }));
  const br = await AI.testConnection({ provider: "anthropic", model: "x", key: KEY }, bad);
  assert.equal(br.ok, false);
  assert.equal(bad.calls[0].init.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal((await AI.testConnection({ provider: "xai", model: "x", key: "" }, bad)).ok, false);
});

test("settings stay on this device and can be removed", () => {
  const s = memoryStorage();
  assert.equal(AI.loadSettings(s), null);
  AI.saveSettings(s, { provider: "anthropic", model: " claude-x ", key: " " + KEY + " " });
  assert.deepEqual(AI.loadSettings(s), { provider: "anthropic", model: "claude-x", key: KEY, via: "key" });
  AI.removeSettings(s);
  assert.equal(AI.loadSettings(s), null);
  assert.equal(AI.maskKey(KEY), "sk-t…7890");
});

test("OpenRouter PKCE: S256 challenge, auth URL, state check, code exchange", async () => {
  const verifier = "dBjftJeZ4CVP-mJ92K5frmK9KSUhcBcAphKdJ7A6l7Q";
  const expected = nodeCrypto.createHash("sha256").update(verifier).digest("base64url");
  assert.equal(await AI.s256(nodeCrypto.webcrypto, verifier), expected);

  const session = memoryStorage();
  const url = new URL(await AI.startOpenRouterAuth(nodeCrypto.webcrypto, session, "https://clickprompt.app/"));
  assert.equal(url.origin + url.pathname, "https://openrouter.ai/auth");
  assert.equal(url.searchParams.get("callback_url"), "https://clickprompt.app/");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const saved = JSON.parse(session.getItem(AI.PKCE_KEY));
  assert.equal(url.searchParams.get("code_challenge"), await AI.s256(nodeCrypto.webcrypto, saved.verifier));
  assert.equal(url.searchParams.get("state"), saved.state);

  // Wrong state is refused.
  const f = mockFetch(() => ({ status: 200, body: { key: "sk-or-user-key" } }));
  await assert.rejects(AI.finishOpenRouterAuth(new URLSearchParams("code=abc&state=evil"), session, f), /didn't match/);
  assert.equal(f.calls.length, 0);

  // Right state exchanges the code with the verifier.
  const session2 = memoryStorage();
  await AI.startOpenRouterAuth(nodeCrypto.webcrypto, session2, "https://clickprompt.app/");
  const st = JSON.parse(session2.getItem(AI.PKCE_KEY));
  const key = await AI.finishOpenRouterAuth(new URLSearchParams("code=abc&state=" + encodeURIComponent(st.state)), session2, f);
  assert.equal(key, "sk-or-user-key");
  assert.equal(f.calls[0].url, "https://openrouter.ai/api/v1/auth/keys");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { code: "abc", code_verifier: st.verifier, code_challenge_method: "S256" });
  assert.equal(session2.getItem(AI.PKCE_KEY), null, "verifier is cleared after use");
});
