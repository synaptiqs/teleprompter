// ClickPrompt smart teleprompter: "Connect your AI" (bring your own key).
//
// The user's API key is kept in this browser's localStorage (AI_KEY) and
// sent only to the provider they picked, straight from the browser. It is
// never sent to ClickPrompt's servers and never logged. All network calls
// take an injectable fetch so tests can mock them.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CPAI = api;
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var AI_KEY = "cp_ai_v1";
  var PKCE_KEY = "cp_or_pkce"; // sessionStorage: { verifier, state } during OpenRouter sign-in
  var MAX_TOKENS = 4000;       // room for reasoning models; scripts themselves are short

  // Model lists are suggestions; any model ID can be typed in, and
  // "Load my models" fills the list from the provider.
  var PROVIDERS = {
    openai: {
      label: "OpenAI", keyHint: "sk-...", keyUrl: "https://platform.openai.com/api-keys",
      models: ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]
    },
    anthropic: {
      label: "Anthropic (Claude)", keyHint: "sk-ant-...", keyUrl: "https://console.anthropic.com/settings/keys",
      models: ["claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-opus-5"]
    },
    gemini: {
      label: "Google Gemini", keyHint: "AIza...", keyUrl: "https://aistudio.google.com/app/apikey",
      models: ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"]
    },
    xai: {
      label: "xAI (Grok)", keyHint: "xai-...", keyUrl: "https://console.x.ai/",
      models: ["grok-4.7", "grok-4.6"]
    },
    openrouter: {
      label: "OpenRouter", keyHint: "sk-or-...", keyUrl: "https://openrouter.ai/keys",
      models: ["openrouter/auto", "anthropic/claude-sonnet-5", "openai/gpt-6-luna", "google/gemini-3.8-flash"]
    }
  };

  // ---- settings (this device only) ----

  function loadSettings(storage) {
    try {
      var s = JSON.parse(storage.getItem(AI_KEY) || "null");
      if (s && PROVIDERS[s.provider] && s.key) return s;
    } catch (e) {}
    return null;
  }

  function saveSettings(storage, settings) {
    var clean = {
      provider: settings.provider,
      model: String(settings.model || PROVIDERS[settings.provider].models[0]).trim(),
      key: String(settings.key || "").trim(),
      via: settings.via === "oauth" ? "oauth" : "key"
    };
    storage.setItem(AI_KEY, JSON.stringify(clean));
    return clean;
  }

  function removeSettings(storage) {
    storage.removeItem(AI_KEY);
  }

  function maskKey(key) {
    key = String(key || "");
    return key.length > 8 ? key.slice(0, 4) + "…" + key.slice(-4) : "••••";
  }

  // ---- requests ----

  // Build the provider request for one prompt { system, user }.
  function buildRequest(settings, prompt, maxTokens) {
    var p = settings.provider;
    var key = settings.key;
    var model = settings.model;
    var max = maxTokens || MAX_TOKENS;
    var messages = [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user }
    ];
    var json = { "Content-Type": "application/json" };
    if (p === "anthropic") {
      return {
        url: "https://api.anthropic.com/v1/messages",
        init: { method: "POST", headers: Object.assign({
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          // Anthropic's opt-in for calls made straight from a browser.
          "anthropic-dangerous-direct-browser-access": "true"
        }, json), body: JSON.stringify({
          model: model, max_tokens: max, system: prompt.system,
          messages: [{ role: "user", content: prompt.user }]
        }) }
      };
    }
    if (p === "gemini") {
      return {
        url: "https://generativelanguage.googleapis.com/v1beta/models/" +
          encodeURIComponent(model.replace(/^models\//, "")) + ":generateContent",
        init: { method: "POST", headers: Object.assign({ "x-goog-api-key": key }, json),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: prompt.system }] },
            contents: [{ role: "user", parts: [{ text: prompt.user }] }],
            generationConfig: { maxOutputTokens: max }
          }) }
      };
    }
    // OpenAI-compatible chat completions: OpenAI, xAI, OpenRouter.
    var urls = {
      openai: "https://api.openai.com/v1/chat/completions",
      xai: "https://api.x.ai/v1/chat/completions",
      openrouter: "https://openrouter.ai/api/v1/chat/completions"
    };
    var body = { model: model, messages: messages };
    // Newer OpenAI models take max_completion_tokens instead of max_tokens.
    if (p === "openai") body.max_completion_tokens = max; else body.max_tokens = max;
    var headers = Object.assign({ Authorization: "Bearer " + key }, json);
    if (p === "openrouter") {
      headers["HTTP-Referer"] = "https://clickprompt.app";
      headers["X-Title"] = "ClickPrompt";
    }
    return { url: urls[p], init: { method: "POST", headers: headers, body: JSON.stringify(body) } };
  }

  function parseResponse(provider, data) {
    if (!data) return "";
    if (provider === "anthropic") {
      return (data.content || []).filter(function (b) { return b.type === "text"; })
        .map(function (b) { return b.text; }).join("").trim();
    }
    if (provider === "gemini") {
      var c = data.candidates && data.candidates[0];
      return c && c.content && c.content.parts
        ? c.content.parts.map(function (x) { return x.text || ""; }).join("").trim() : "";
    }
    var ch = data.choices && data.choices[0];
    var content = ch && ch.message && ch.message.content;
    if (Array.isArray(content)) content = content.map(function (x) { return x.text || ""; }).join("");
    return String(content || "").trim();
  }

  // Turn an HTTP status into a message a creator can act on. Never
  // includes the key.
  function friendlyError(status, data, providerLabel) {
    var detail = data && (data.error && (data.error.message || data.error) || data.message);
    if (typeof detail !== "string") detail = "";
    detail = detail.replace(/(sk|xai|AIza)[-_A-Za-z0-9]{6,}/g, "[key]").slice(0, 160);
    if (status === 401 || status === 403) return providerLabel + " didn't accept this key. Check it and try again.";
    if (status === 404) return providerLabel + " doesn't know that model. Pick another or load your models.";
    if (status === 429) return providerLabel + " says you're over a rate or spend limit. Wait a minute or check billing there.";
    if (status === 402) return providerLabel + " says the account is out of credits.";
    return providerLabel + " returned an error (" + status + ")" + (detail ? ": " + detail : ".");
  }

  function AIError(message, status) {
    var e = new Error(message);
    e.status = status || 0;
    return e;
  }

  async function complete(settings, prompt, fetchImpl, maxTokens) {
    var label = PROVIDERS[settings.provider].label;
    var req = buildRequest(settings, prompt, maxTokens);
    var res;
    try {
      res = await fetchImpl(req.url, req.init);
    } catch (e) {
      throw AIError("Couldn't reach " + label + ". Check your connection.", 0);
    }
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw AIError(friendlyError(res.status, data, label), res.status);
    var text = parseResponse(settings.provider, data);
    if (!text) throw AIError(label + " sent back an empty reply. Try again or pick another model.", res.status);
    return text;
  }

  // ---- test connection / list models (no tokens spent) ----

  function modelsRequest(settings) {
    var key = settings.key;
    switch (settings.provider) {
      case "openai": return { url: "https://api.openai.com/v1/models", headers: { Authorization: "Bearer " + key } };
      case "xai": return { url: "https://api.x.ai/v1/models", headers: { Authorization: "Bearer " + key } };
      case "anthropic": return { url: "https://api.anthropic.com/v1/models?limit=100", headers: {
        "x-api-key": key, "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true" } };
      case "gemini": return { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
        headers: { "x-goog-api-key": key } };
      // /key checks the key itself; the model list is public.
      case "openrouter": return { url: "https://openrouter.ai/api/v1/key", headers: { Authorization: "Bearer " + key } };
    }
    return null;
  }

  function modelIds(provider, data) {
    if (!data) return [];
    if (provider === "gemini") {
      return (data.models || []).filter(function (m) {
        return !m.supportedGenerationMethods || m.supportedGenerationMethods.indexOf("generateContent") !== -1;
      }).map(function (m) { return String(m.name).replace(/^models\//, ""); });
    }
    return (data.data || []).map(function (m) { return m.id; }).filter(Boolean);
  }

  // Checks the key and reports whether the chosen model is available.
  async function testConnection(settings, fetchImpl) {
    var label = PROVIDERS[settings.provider].label;
    if (!settings.key) return { ok: false, message: "Paste your " + label + " key first." };
    var req = modelsRequest(settings);
    var res;
    try { res = await fetchImpl(req.url, { method: "GET", headers: req.headers }); }
    catch (e) { return { ok: false, message: "Couldn't reach " + label + ". Check your connection." }; }
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) return { ok: false, message: friendlyError(res.status, data, label) };
    var models = modelIds(settings.provider, data);
    if (settings.provider === "openrouter") {
      return { ok: true, models: [], message: "Connected to OpenRouter. Scripts will use " + settings.model + "." };
    }
    var found = models.indexOf(settings.model) !== -1;
    return {
      ok: true,
      models: models,
      modelFound: found,
      message: found
        ? "Connected to " + label + ". " + settings.model + " is ready."
        : "Key works, but " + settings.model + " isn't in your " + label + " model list. Pick one from the list."
    };
  }

  // ---- OpenRouter sign-in (OAuth PKCE, https://openrouter.ai/docs/use-cases/oauth-pkce) ----

  function base64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    var b64 = typeof btoa === "function" ? btoa(s) : Buffer.from(s, "binary").toString("base64");
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function randomString(cryptoImpl, nBytes) {
    var a = new Uint8Array(nBytes || 32);
    cryptoImpl.getRandomValues(a);
    return base64url(a);
  }

  async function s256(cryptoImpl, verifier) {
    var hash = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return base64url(new Uint8Array(hash));
  }

  // Step 1: returns the URL to send the user to, and remembers the
  // verifier + state for this tab only (sessionStorage).
  async function startOpenRouterAuth(cryptoImpl, session, callbackUrl) {
    var verifier = randomString(cryptoImpl, 32);
    var state = randomString(cryptoImpl, 16);
    session.setItem(PKCE_KEY, JSON.stringify({ verifier: verifier, state: state }));
    var challenge = await s256(cryptoImpl, verifier);
    return "https://openrouter.ai/auth?callback_url=" + encodeURIComponent(callbackUrl) +
      "&code_challenge=" + challenge + "&code_challenge_method=S256" +
      "&state=" + encodeURIComponent(state) + "&key_label=ClickPrompt";
  }

  // Step 2: on return (?code=...&state=...), trade the code for the
  // user's own key. Returns the key or throws.
  async function finishOpenRouterAuth(params, session, fetchImpl) {
    var saved = null;
    try { saved = JSON.parse(session.getItem(PKCE_KEY) || "null"); } catch (e) {}
    session.removeItem(PKCE_KEY);
    var code = params.get("code");
    if (!saved || !code) throw AIError("OpenRouter sign-in expired. Try Connect with OpenRouter again.");
    if (params.get("state") !== saved.state) throw AIError("OpenRouter sign-in didn't match this tab. Try again.");
    var res = await fetchImpl("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code, code_verifier: saved.verifier, code_challenge_method: "S256" })
    });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok || !data || !data.key) throw AIError("OpenRouter didn't finish the sign-in (" + res.status + "). Try again.");
    return data.key;
  }

  return {
    AI_KEY: AI_KEY,
    PKCE_KEY: PKCE_KEY,
    PROVIDERS: PROVIDERS,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    removeSettings: removeSettings,
    maskKey: maskKey,
    buildRequest: buildRequest,
    parseResponse: parseResponse,
    friendlyError: friendlyError,
    complete: complete,
    modelsRequest: modelsRequest,
    modelIds: modelIds,
    testConnection: testConnection,
    startOpenRouterAuth: startOpenRouterAuth,
    finishOpenRouterAuth: finishOpenRouterAuth,
    s256: s256
  };
}));
