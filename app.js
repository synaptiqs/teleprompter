(function () {
      "use strict";

      var app = document.getElementById("app");
      var camera = document.getElementById("camera");
      var cameraCanvas = document.getElementById("cameraCanvas");
      var cameraContext = cameraCanvas.getContext("2d", { alpha: false });
      var cameraEmpty = document.getElementById("cameraEmpty");
      var enableCamera = document.getElementById("enableCamera");
      var cameraSelect = document.getElementById("cameraSelect");
      var portraitFrame = document.getElementById("portraitFrame");
      var landscapeFrame = document.getElementById("landscapeFrame");
      var recordModeTool = document.getElementById("recordModeTool");
      var orientationTool = document.getElementById("orientationTool");
      var cameraTool = document.getElementById("cameraTool");
      var videoModeBtn = document.getElementById("videoMode");
      var audioModeBtn = document.getElementById("audioMode");
      var waveform = document.getElementById("waveform");
      var waveformCtx = waveform.getContext("2d");
      var micEmpty = document.getElementById("micEmpty");
      var enableMic = document.getElementById("enableMic");
      var stageHint = document.getElementById("stageHint");
      var scriptInput = document.getElementById("scriptInput");
      var qName = document.getElementById("qName");
      var qRole = document.getElementById("qRole");
      var qAudience = document.getElementById("qAudience");
      var qPoint = document.getElementById("qPoint");
      var qLength = document.getElementById("qLength");
      var generateButton = document.getElementById("generateScript");
      var generateStatus = document.getElementById("generateStatus");
      // Script-writing API (Cloudflare Worker). Redeploy the frontend if this moves.
      var SCRIPT_API_URL = "https://teleprompter-script-api.synaptiqs.workers.dev/api/generate-script";
      var API_BASE = "https://teleprompter-script-api.synaptiqs.workers.dev";

      // ---- visitor identity + analytics (brief §1, §10) ----
      // Free-cap identity: a first-party visitor cookie (cp_vid), with the
      // client IP as the server-side fallback. Set once, lasts a year.
      function visitorId() {
        var m = document.cookie.match(/(?:^|;\s*)cp_vid=([0-9a-f]{32})/);
        if (m) return m[1];
        var id = "";
        try {
          var bytes = new Uint8Array(16);
          crypto.getRandomValues(bytes);
          for (var i = 0; i < bytes.length; i++) {
            id += ("0" + bytes[i].toString(16)).slice(-2);
          }
        } catch (e) {
          id = String(Date.now().toString(16)) + String(Math.random()).slice(2, 18);
          id = (id + "00000000000000000000000000000000").slice(0, 32);
        }
        document.cookie = "cp_vid=" + id + "; max-age=31536000; path=/; SameSite=Lax";
        return id;
      }

      // "3 free scripts today" indicator under the Generate button.
      function updateFreeCap(remaining, subscribed) {
        var el = document.getElementById("freeCap");
        if (!el) return;
        if (subscribed) {
          el.textContent = "Pro: unlimited scripts";
          return;
        }
        if (typeof remaining !== "number") return;
        if (remaining <= 0) {
          el.textContent = "No free scripts left today — back tomorrow, or go Pro";
        } else {
          el.textContent = remaining + (remaining === 1 ? " free script" : " free scripts") + " today";
        }
      }

      // Client analytics events (brief §10): generated, recording_started,
      // download, subscribe. Fire-and-forget; never blocks the UI.
      function trackEvent(name) {
        try {
          fetch(API_BASE + "/api/event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event: name }),
            keepalive: true
          }).catch(function () {});
        } catch (e) {}
      }

      // ---- platform overlay (brief §6) ----
      // One-time, mobile-only, shown right after the tutorial. Sets the
      // recording orientation, the default script length, and the tone
      // the generator writes in. Unknown platforms are added on the fly
      // and remembered for autocomplete.
      var PLATFORM_DEFAULTS = {
        youtube:   { label: "YouTube",         orientation: "landscape", lengthSeconds: 120, tone: "clear and instructive" },
        tiktok:    { label: "TikTok",          orientation: "portrait",  lengthSeconds: 30,  tone: "punchy and fast" },
        instagram: { label: "Instagram Reels", orientation: "portrait",  lengthSeconds: 30,  tone: "punchy and fast" },
        facebook:  { label: "Facebook",        orientation: "portrait",  lengthSeconds: 45,  tone: "warm and conversational" },
        linkedin:  { label: "LinkedIn",        orientation: "portrait",  lengthSeconds: 60,  tone: "professional and direct" },
        x:         { label: "X",               orientation: "landscape", lengthSeconds: 60,  tone: "sharp and opinionated" }
      };
      var PLATFORM_KEY = "cp_platform";
      var PLATFORM_CUSTOM_KEY = "cp_platforms_custom";

      function isMobileLayout() {
        return (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
          window.innerWidth < 700;
      }

      function platformRecord() {
        try {
          var raw = localStorage.getItem(PLATFORM_KEY);
          return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
      }

      // Normalized platform key for the generate payload (or "" if none).
      function platformChoice() {
        var rec = platformRecord();
        return rec && rec.key ? rec.key : "";
      }

      function platformToneValue() {
        var rec = platformRecord();
        return rec && rec.tone ? rec.tone : "";
      }

      function customPlatforms() {
        try {
          var raw = localStorage.getItem(PLATFORM_CUSTOM_KEY);
          var arr = raw ? JSON.parse(raw) : [];
          return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
      }

      function savePlatformChoice(key, label, orientation, lengthSeconds, tone) {
        try {
          localStorage.setItem(PLATFORM_KEY, JSON.stringify({
            key: key, label: label, orientation: orientation,
            lengthSeconds: lengthSeconds, tone: tone, at: Date.now()
          }));
        } catch (e) {}
      }

      function applyPlatformChoice(key, label, orientation, lengthSeconds, tone) {
        // Orientation: flip the frame toggle like a tap would.
        if (orientation === "landscape") landscapeFrame.click();
        else portraitFrame.click();
        // Default script length.
        if (qLength) {
          var opt = qLength.querySelector('option[value="' + lengthSeconds + '"]');
          if (opt) qLength.value = String(lengthSeconds);
        }
        savePlatformChoice(key, label, orientation, lengthSeconds, tone);
      }

      function choosePlatform(key, label) {
        var def = PLATFORM_DEFAULTS[key];
        var orientation, lengthSeconds, tone;
        if (def) {
          orientation = def.orientation;
          lengthSeconds = def.lengthSeconds;
          tone = def.tone;
        } else {
          // Unknown platform, added on the fly: sensible defaults, and
          // remember it for the autocomplete list.
          orientation = "portrait";
          lengthSeconds = 60;
          tone = "conversational";
          var customs = customPlatforms();
          if (customs.indexOf(label) === -1) {
            customs.push(label);
            try { localStorage.setItem(PLATFORM_CUSTOM_KEY, JSON.stringify(customs.slice(-20))); } catch (e) {}
          }
          key = "custom:" + label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        }
        var working = document.getElementById("platformWorking");
        var dialog = document.getElementById("platformDialog");
        if (working) {
          working.hidden = false;
          working.textContent = "Optimizing for " + label + "…";
        }
        applyPlatformChoice(key, label, orientation, lengthSeconds, tone);
        setTimeout(function () {
          if (working) working.hidden = true;
          if (dialog && typeof dialog.close === "function") dialog.close();
        }, 900);
      }

      function maybeShowPlatformOverlay() {
        // Mobile only, once ever, right after the tutorial.
        if (!isMobileLayout()) return;
        if (platformRecord()) return;
        var dialog = document.getElementById("platformDialog");
        if (!dialog || typeof dialog.showModal !== "function") return;
        // Autocomplete: known platforms + previously added customs.
        var dl = document.getElementById("platformDatalist");
        if (dl) {
          dl.innerHTML = "";
          Object.keys(PLATFORM_DEFAULTS).forEach(function (k) {
            var o = document.createElement("option");
            o.value = PLATFORM_DEFAULTS[k].label;
            dl.appendChild(o);
          });
          customPlatforms().forEach(function (label) {
            var o = document.createElement("option");
            o.value = label;
            dl.appendChild(o);
          });
        }
        dialog.showModal();
      }
      var promptCopy = document.getElementById("promptCopy");
      var promptScroll = document.getElementById("promptScroll");
      var promptTrack = document.getElementById("promptTrack");
      var guide = document.getElementById("guide");
      var speed = document.getElementById("speed");
      var fontSize = document.getElementById("fontSize");
      var speedValue = document.getElementById("speedValue");
      var fontValue = document.getElementById("fontValue");
      var wordCount = document.getElementById("wordCount");
      var readTime = document.getElementById("readTime");
      var countdownToggle = document.getElementById("countdownToggle");
      var mirrorToggle = document.getElementById("mirrorToggle");
      var backplateToggle = document.getElementById("backplateToggle");
      var flipTextToggle = document.getElementById("flipTextToggle");
      var playScroll = document.getElementById("playScroll");
      var playIcon = document.getElementById("playIcon");
      var rewind = document.getElementById("rewind");
      var recordButton = document.getElementById("recordButton");
      var pauseRecording = document.getElementById("pauseRecording");
      var pauseRecordingIcon = document.getElementById("pauseRecordingIcon");
      var fullscreen = document.getElementById("fullscreen");
      var stage = document.getElementById("stage");
      var countdown = document.getElementById("countdown");
      var recordStatus = document.getElementById("recordStatus");
      var statusLabel = document.getElementById("statusLabel");
      var timer = document.getElementById("timer");
      var errorMessage = document.getElementById("errorMessage");
      var reviewDialog = document.getElementById("reviewDialog");
      var reviewVideo = document.getElementById("reviewVideo");
    var reviewAudio = document.getElementById("reviewAudio");
    var reviewTitle = document.getElementById("reviewTitle");
    var reviewSubtitle = document.getElementById("reviewSubtitle");
    var saveAudioCloud = document.getElementById("saveAudioCloud");
      var downloadLink = document.getElementById("downloadLink");
      var downloadStatus = document.getElementById("downloadStatus");
      var newTake = document.getElementById("newTake");
      var openPrompter = document.getElementById("openPrompter");
      var changeScript = document.getElementById("changeScript");

      // ---- Paywall: script saving ($2.99/mo, $34.99 lifetime, or access code) ----
      // Everything else (interview, generation, prompter) stays free.
      var API_BASE = "https://teleprompter-script-api.synaptiqs.workers.dev";
      var TOKEN_KEY = "clickprompt_token";
      var saveScriptButton = document.getElementById("saveScript");
      var saveStatus = document.getElementById("saveStatus");
      var library = document.getElementById("library");
      var libraryList = document.getElementById("libraryList");
      var audioLibrary = document.getElementById("audioLibrary");
      var audioLibraryList = document.getElementById("audioLibraryList");
      var paywallDialog = document.getElementById("paywallDialog");
      var subscribeButton = document.getElementById("subscribeButton");
      var paywallStatus = document.getElementById("paywallStatus");
      var codeInput = document.getElementById("codeInput");
      var redeemButton = document.getElementById("redeemButton");
      var paywallClose = document.getElementById("paywallClose");
      var unlockState = { unlocked: false, via: null };
      var lastMe = null; // last /api/me response (carries storage quota info)

      // Storage meter for the voiceover library (brief §2).
      function formatGB(bytes) {
        var gb = bytes / (1024 * 1024 * 1024);
        return (gb < 10 ? gb.toFixed(1) : Math.round(gb)) + " GB";
      }
      async function refreshStorageLine() {
        var el = document.getElementById("storageLine");
        if (!el) return;
        var token = getToken();
        if (!token || !unlockState.unlocked) { el.hidden = true; return; }
        try {
          var m = await apiGet("/api/me?token=" + encodeURIComponent(token));
          lastMe = m;
          if (m && m.unlocked && typeof m.storage_gb === "number") {
            var used = Number(m.storage_used_bytes) || 0;
            el.hidden = false;
            el.textContent = "Storage: " + formatGB(used) + " of " + m.storage_gb + " GB used";
          } else {
            el.hidden = true;
          }
        } catch (e) { el.hidden = true; }
      }

      function getToken() {
        try { return localStorage.getItem(TOKEN_KEY) || ""; }
        catch (e) { return ""; }
      }

      function setToken(token) {
        try {
          if (token) localStorage.setItem(TOKEN_KEY, token);
          else localStorage.removeItem(TOKEN_KEY);
        } catch (e) { /* private mode: saving just won't persist */ }
      }

      async function apiGet(path) {
        var res = await fetch(API_BASE + path);
        return res.json();
      }

      async function apiPost(path, body) {
        var res = await fetch(API_BASE + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        var data = await res.json().catch(function () { return {}; });
        data._ok = res.ok;
        return data;
      }

      async function refreshUnlock() {
        // Returning from Lemon Squeezy checkout lands here with
        // ?checkout=done. The unlock token was stored before redirecting;
        // the webhook may take a few seconds, so poll briefly.
        var params = new URLSearchParams(window.location.search);
        if (params.get("checkout") === "done") {
          params.delete("checkout");
          var cleanUrl = window.location.pathname + (params.toString() ? "?" + params.toString() : "");
          window.history.replaceState({}, "", cleanUrl);
          var attempts = 0;
          var poll = async function () {
            attempts++;
            try {
              var s = await apiGet("/api/me?token=" + encodeURIComponent(getToken()));
              if (s && s.unlocked) {
                unlockState = { unlocked: true, via: s.via || "subscription" };
                updateUnlockUI();
                return;
              }
            } catch (e) { /* keep polling */ }
            if (attempts < 15) setTimeout(poll, 2000);
          };
          poll();
        }
        if (!unlockState.unlocked) {
          try {
            var m = await apiGet("/api/me?token=" + encodeURIComponent(getToken()));
            if (m && m.unlocked) unlockState = { unlocked: true, via: m.via || null };
            else { unlockState = { unlocked: false, via: null }; setToken(""); }
          } catch (e) { unlockState = { unlocked: false, via: null }; }
        }
        updateUnlockUI();
      }

      function updateUnlockUI() {
        if (unlockState.unlocked) {
          library.hidden = false;
          audioLibrary.hidden = false;
          saveStatus.textContent = unlockState.via === "code"
            ? "Saving unlocked with your access code."
            : unlockState.via === "lifetime"
            ? "Saving unlocked for life. Thank you!"
            : "Saving unlocked — subscription active.";
          loadLibrary();
          loadAudioLibrary();
        } else {
          library.hidden = true;
          libraryList.innerHTML = "";
          audioLibrary.hidden = true;
          audioLibraryList.innerHTML = "";
          stopLibraryPlayback();
          saveStatus.textContent = "";
        }
      }

      function openPaywall(reason) {
        paywallStatus.textContent = "";
        codeInput.value = "";
        // When the free generation cap is hit, say so up front.
        if (reason === "limit") {
          paywallStatus.textContent = "You've used your 3 free scripts today. Go Pro for unlimited generations, or come back tomorrow.";
        }
        if (typeof paywallDialog.showModal === "function") paywallDialog.showModal();
      }

      function closePaywall() {
        if (paywallDialog.open) paywallDialog.close();
      }

      var PLAN_LABELS = {
        monthly: "Continue — $2.99/mo",
        lifetime: "Continue — $34.99 once"
      };
      function selectedPlan() {
        var checked = document.querySelector('input[name="plan"]:checked');
        return checked ? checked.value : "monthly";
      }
      function refreshSubscribeButton() {
        subscribeButton.innerHTML = PLAN_LABELS[selectedPlan()] || PLAN_LABELS.monthly;
      }
      async function startCheckout() {
        subscribeButton.disabled = true;
        paywallStatus.textContent = "Opening secure checkout…";
        try {
          var data = await apiPost("/api/checkout", { origin: window.location.origin, plan: selectedPlan() });
          if (data._ok && data.url && data.token) {
            // Store the unlock token BEFORE leaving: the webhook matches it
            // back via checkout custom data, and /api/me polls it on return.
            setToken(data.token);
            window.location.href = data.url;
            return;
          }
          paywallStatus.textContent = data.error || "Checkout isn't available right now. Try again later.";
        } catch (e) {
          paywallStatus.textContent = "Couldn't reach the checkout. Check your connection and try again.";
        } finally {
          subscribeButton.disabled = false;
        }
      }

      async function redeemCode() {
        var code = codeInput.value.trim();
        if (!code) {
          paywallStatus.textContent = "Enter your access code first.";
          codeInput.focus();
          return;
        }
        redeemButton.disabled = true;
        paywallStatus.textContent = "Checking your code…";
        try {
          var data = await apiPost("/api/redeem", { code: code });
          if (data._ok && data.unlocked) {
            setToken(data.token);
            unlockState = { unlocked: true, via: "code" };
            updateUnlockUI();
            closePaywall();
            saveStatus.textContent = "Code accepted — saving is unlocked.";
            return;
          }
          paywallStatus.textContent = data.error || "That code didn't work.";
        } catch (e) {
          paywallStatus.textContent = "Couldn't reach the server. Check your connection and try again.";
        } finally {
          redeemButton.disabled = false;
        }
      }

      function defaultScriptTitle() {
        var text = scriptInput.value.trim();
        var first = text.split("\n")[0] || "";
        first = first.replace(/^[^a-zA-Z0-9]+/, "").slice(0, 48).trim();
        if (!first) first = "Untitled script";
        var d = new Date();
        return first + " — " + (d.getMonth() + 1) + "/" + d.getDate();
      }

      async function saveCurrentScript() {
        var text = scriptInput.value.trim();
        if (!text) {
          saveStatus.textContent = "Write or generate a script first.";
          return;
        }
        if (!unlockState.unlocked) {
          openPaywall();
          return;
        }
        saveScriptButton.disabled = true;
        saveStatus.textContent = "Saving…";
        try {
          var data = await apiPost("/api/scripts", {
            token: getToken(),
            title: defaultScriptTitle(),
            body: text
          });
          if (data._ok) {
            saveStatus.textContent = "Saved.";
            renderLibrary(data.scripts || []);
          } else if (data.unlocked === false) {
            // Subscription lapsed or code revoked: drop back to the paywall.
            setToken("");
            unlockState = { unlocked: false, via: null };
            updateUnlockUI();
            openPaywall();
          } else {
            saveStatus.textContent = data.error || "Couldn't save. Try again.";
          }
        } catch (e) {
          saveStatus.textContent = "Couldn't reach the server. Try again.";
        } finally {
          saveScriptButton.disabled = false;
        }
      }

      function renderLibrary(scripts) {
        libraryList.innerHTML = "";
        if (!scripts.length) {
          var empty = document.createElement("li");
          empty.className = "library-empty";
          empty.textContent = "Nothing saved yet. Your scripts will live here.";
          libraryList.appendChild(empty);
          return;
        }
        scripts.forEach(function (s) {
          var li = document.createElement("li");
          li.className = "library-item";
          var name = document.createElement("button");
          name.type = "button";
          name.className = "library-load";
          name.textContent = s.title || "Untitled script";
          name.title = "Load into editor";
          name.addEventListener("click", function () {
            scriptInput.value = s.body || "";
            setPromptOffset(0);
            setScrollState(false);
            updateScript();
            saveStatus.textContent = "Loaded “" + (s.title || "script") + "”.";
            scriptInput.focus();
          });
          var del = document.createElement("button");
          del.type = "button";
          del.className = "library-delete";
          del.textContent = "Delete";
          del.setAttribute("aria-label", "Delete " + (s.title || "script"));
          del.addEventListener("click", function () { deleteScript(s.id); });
          li.appendChild(name);
          li.appendChild(del);
          libraryList.appendChild(li);
        });
      }

      async function loadLibrary() {
        if (!unlockState.unlocked) return;
        try {
          var data = await apiGet("/api/scripts?token=" + encodeURIComponent(getToken()));
          if (data && Array.isArray(data.scripts)) renderLibrary(data.scripts);
          else if (data && data.unlocked === false) {
            setToken("");
            unlockState = { unlocked: false, via: null };
            updateUnlockUI();
          }
        } catch (e) { /* library just stays as-is on network failure */ }
      }

      async function deleteScript(id) {
        if (!id || !unlockState.unlocked) return;
        try {
          var res = await fetch(
            API_BASE + "/api/scripts?id=" + encodeURIComponent(id) +
            "&token=" + encodeURIComponent(getToken()),
            { method: "DELETE" }
          );
          var data = await res.json().catch(function () { return {}; });
          if (res.ok && Array.isArray(data.scripts)) renderLibrary(data.scripts);
        } catch (e) { /* leave the list as-is */ }
      }


      var stream = null;
      var recordingStream = null;
      var recorder = null;
      var chunks = [];
      // Audio-only (voiceover) mode state.
      var recordMode = "video"; // "video" | "audio"
      var micStream = null;
      var micAnalyser = null;
      var micAudioContext = null;
      var waveformFrame = 0;
      var libraryAudio = new Audio();
      var libraryPlayingId = null;
      var cameraFrame = 0;
      var scrolling = false;
      var scrollFrame = 0;
      var scrollOffset = 0;
      var lastFrameTime = 0;
      var timerInterval = 0;
      var startedAt = 0;
      var pausedAt = 0;
      var totalPausedMs = 0;
      var recordingUrl = "";
      var recordingBlob = null;
      var recordingFilename = "teleprompter-take.webm";
      var startingRecording = false;
      var recordingOrientation = "portrait";
      var recordingAudioContext = null;
      var recordingAudioSource = null;
      var recordingAudioDestination = null;
      var wakeLock = null;

      function setToggle(button, active) {
        button.setAttribute("aria-pressed", active ? "true" : "false");
      }

      function togglePressed(button) {
        setToggle(button, button.getAttribute("aria-pressed") !== "true");
      }

      function updateScript() {
        var text = scriptInput.value.trim();
        promptCopy.textContent = text || "Your script will appear here.";
        var words = text ? text.split(/\s+/).filter(Boolean).length : 0;
        var seconds = Math.round(words / 145 * 60);
        wordCount.textContent = words + (words === 1 ? " word" : " words");
        readTime.textContent = "about " + Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
        openPrompter.disabled = !text;
      }

      // Send the five interview answers to the script-writing Worker and load
      // the result into the editable script box.
      async function generateScript() {
        var answers = {
          name: qName.value.trim(),
          role: qRole.value.trim(),
          audience: qAudience.value.trim(),
          point: qPoint.value.trim(),
          lengthSeconds: Number(qLength.value) || 60
        };
        if (!answers.point) {
          generateStatus.textContent = "Answer question 4 first, then generate.";
          qPoint.focus();
          return;
        }
        generateButton.disabled = true;
        generateStatus.textContent = "Writing your script…";
        try {
          var payload = {
            name: qName.value.trim(),
            role: qRole.value.trim(),
            audience: qAudience.value.trim(),
            point: qPoint.value.trim(),
            lengthSeconds: Number(qLength.value) || 60,
            // Free-cap identity: first-party visitor cookie, IP fallback.
            // The platform choice (overlay) tunes tone/length defaults.
            visitor_id: visitorId(),
            platform: platformChoice(),
            tone: platformToneValue()
          };
          // Send the unlock token when present so subscribers skip the
          // free cap entirely.
          var genToken = getToken();
          if (genToken) payload.token = genToken;
          var response = await fetch(SCRIPT_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          var data = null;
          try { data = await response.json(); } catch (e) {}
          if (!response.ok) {
            generateStatus.textContent = (data && data.error) ||
              "Couldn't reach the script writer. Check your connection and try again, or write your own below.";
            if (data && typeof data.remaining === "number") {
              updateFreeCap(data.remaining, data.subscribed);
            }
            // Free cap hit: point at the paywall without trapping the user.
            if (data && data.code === "daily_limit") openPaywall("limit");
            return;
          }
          if (!data || !data.script) throw new Error("empty script");
          scriptInput.value = data.script;
          setPromptOffset(0);
          setScrollState(false);
          updateScript();
          updateFreeCap(data.remaining, data.subscribed);
          trackEvent("generated");
          generateStatus.textContent = "Done. Edit anything you like, then open the prompter.";
        } catch (error) {
          generateStatus.textContent = "Couldn't reach the script writer. Check your connection and try again, or write your own below.";
        } finally {
          generateButton.disabled = false;
        }
      }

      function updateRangeLabels() {
        speedValue.textContent = speed.value + " px/s";
        fontValue.textContent = fontSize.value + " px";
        promptCopy.style.fontSize = fontSize.value + "px";
      }

      function showError(message) {
        errorMessage.textContent = message;
        errorMessage.classList.add("show");
      }

      function clearError() {
        errorMessage.textContent = "";
        errorMessage.classList.remove("show");
      }

      async function showPrompter() {
        if (!scriptInput.value.trim()) return;
        app.setAttribute("data-view", "prompter");
        window.scrollTo(0, 0);
        if (recordMode === "audio") {
          if (!micStream) await startMic();
          else { micEmpty.style.display = "none"; startWaveform(); }
        } else if (!stream) {
          await startCamera();
        } else {
          syncRecordingFrame();
        }
      }

      async function showSetup() {
        if (startingRecording || (recorder && recorder.state !== "inactive")) return;
        setScrollState(false);
        await stopStream();
        stopMic();
        stopLibraryPlayback();
        camera.srcObject = null;
        if (recordMode === "audio") {
          micEmpty.style.display = "none";
          cameraEmpty.style.display = "none";
        } else {
          cameraEmpty.style.display = "grid";
        }
        app.setAttribute("data-view", "setup");
        window.scrollTo(0, 0);
      }

      function syncRecordingFrame() {
        var width = camera.videoWidth;
        var height = camera.videoHeight;
        if (!width || !height) {
          var track = stream && stream.getVideoTracks()[0];
          var settings = track && track.getSettings ? track.getSettings() : null;
          width = settings && settings.width;
          height = settings && settings.height;
        }
        if (!width || !height) return;
        var longSide = Math.min(Math.max(width, height), 1920);
        var shortSide = Math.round(longSide * 9 / 16);
        var frameWidth = recordingOrientation === "portrait" ? shortSide : longSide;
        var frameHeight = recordingOrientation === "portrait" ? longSide : shortSide;
        if (cameraCanvas.width !== frameWidth || cameraCanvas.height !== frameHeight) {
          cameraCanvas.width = frameWidth;
          cameraCanvas.height = frameHeight;
        }
        stage.style.setProperty("--recording-aspect", frameWidth + " / " + frameHeight);
        stage.style.setProperty("--recording-ratio", String(frameWidth / frameHeight));
      }

      function drawCameraFrame() {
        if (!stream || camera.readyState < 2) return;
        var sourceWidth = camera.videoWidth;
        var sourceHeight = camera.videoHeight;
        var outputWidth = cameraCanvas.width;
        var outputHeight = cameraCanvas.height;
        if (!sourceWidth || !sourceHeight || !outputWidth || !outputHeight) return;
        var coverScale = Math.max(outputWidth / sourceWidth, outputHeight / sourceHeight);
        var containScale = Math.min(outputWidth / sourceWidth, outputHeight / sourceHeight);
        var scale = Math.max(containScale, coverScale * 0.5);
        var drawWidth = sourceWidth * scale;
        var drawHeight = sourceHeight * scale;
        var drawX = (outputWidth - drawWidth) / 2;
        var drawY = (outputHeight - drawHeight) / 2;
        cameraContext.fillStyle = "#11191e";
        cameraContext.fillRect(0, 0, outputWidth, outputHeight);
        cameraContext.drawImage(camera, drawX, drawY, drawWidth, drawHeight);
      }

      function cameraLoop() {
        drawCameraFrame();
        cameraFrame = requestAnimationFrame(cameraLoop);
      }

      function startCameraLoop() {
        if (cameraFrame) cancelAnimationFrame(cameraFrame);
        cameraFrame = requestAnimationFrame(cameraLoop);
      }

      async function setRecordingOrientation(orientation) {
        if (startingRecording || (recorder && recorder.state !== "inactive") || orientation === recordingOrientation) return;
        recordingOrientation = orientation;
        setToggle(portraitFrame, orientation === "portrait");
        setToggle(landscapeFrame, orientation === "landscape");
        var ratio = orientation === "portrait" ? 9 / 16 : 16 / 9;
        stage.style.setProperty("--recording-aspect", orientation === "portrait" ? "9 / 16" : "16 / 9");
        stage.style.setProperty("--recording-ratio", String(ratio));
        if (stream) {
          portraitFrame.disabled = true;
          landscapeFrame.disabled = true;
          await startCamera(cameraSelect.value || undefined);
          portraitFrame.disabled = false;
          landscapeFrame.disabled = false;
        } else {
          refreshPromptLayer();
        }
      }

      function setPromptOffset(value) {
        var maxOffset = Math.max(0, promptTrack.scrollHeight - promptScroll.clientHeight);
        scrollOffset = Math.max(0, Math.min(value, maxOffset));
        var transform = "translate3d(0, " + (-scrollOffset) + "px, 0)";
        promptTrack.style.transform = transform;
        promptTrack.style.webkitTransform = transform;
        return maxOffset;
      }

      function refreshPromptLayer() {
        updateScript();
        guide.style.visibility = "hidden";
        void guide.offsetHeight;
        requestAnimationFrame(function () {
          var guideHeight = guide.clientHeight;
          promptTrack.style.paddingTop = Math.round(guideHeight * 0.42) + "px";
          promptTrack.style.paddingBottom = Math.round(guideHeight * 0.58) + "px";
          setPromptOffset(scrollOffset);
          guide.style.visibility = "visible";
        });
      }

      async function stopStream() {
        if (cameraFrame) {
          cancelAnimationFrame(cameraFrame);
          cameraFrame = 0;
        }
        if (stream) {
          stream.getTracks().forEach(function (track) { track.stop(); });
          stream = null;
        }
      }

      async function startCamera(deviceId) {
        clearError();
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          showError("This browser does not provide camera access here. Open the page in Safari or Chrome and try again.");
          return false;
        }
        try {
          await stopStream();
          var videoConstraints = {
            width: { ideal: 1920 },
            height: { ideal: 1080 }
          };
          if (deviceId) videoConstraints.deviceId = { exact: deviceId };
          else videoConstraints.facingMode = "user";
          stream = await navigator.mediaDevices.getUserMedia({
            video: videoConstraints,
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          });
          camera.srcObject = stream;
          await camera.play();
          syncRecordingFrame();
          startCameraLoop();
          cameraEmpty.style.display = "none";
          statusLabel.textContent = "READY";
          refreshPromptLayer();
          await loadCameras();
          return true;
        } catch (error) {
          var message = "Camera access failed. Check the camera and microphone permissions, then try again.";
          if (error && error.name === "NotAllowedError") message = "Camera or microphone permission was blocked. Allow access in your browser settings, then try again.";
          if (error && error.name === "NotFoundError") message = "No camera or microphone was found on this device.";
          showError(message);
          cameraEmpty.style.display = "grid";
          return false;
        }
      }

      async function loadCameras() {
        try {
          var devices = await navigator.mediaDevices.enumerateDevices();
          var cameras = devices.filter(function (device) { return device.kind === "videoinput"; });
          var activeTrack = stream && stream.getVideoTracks()[0];
          var activeId = activeTrack && activeTrack.getSettings ? activeTrack.getSettings().deviceId : "";
          cameraSelect.innerHTML = "";
          cameras.forEach(function (device, index) {
            var option = document.createElement("option");
            option.value = device.deviceId;
            option.textContent = device.label || "Camera " + (index + 1);
            if (device.deviceId === activeId) option.selected = true;
            cameraSelect.appendChild(option);
          });
          cameraSelect.disabled = cameras.length < 2;
        } catch (error) {
          cameraSelect.disabled = true;
        }
      }

      async function requestWakeLock() {
        if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
        try { wakeLock = await navigator.wakeLock.request("screen"); } catch (error) { wakeLock = null; }
      }

      function releaseWakeLock() {
        if (wakeLock) {
          wakeLock.release().catch(function () {});
          wakeLock = null;
        }
      }

      function setScrollState(active) {
        scrolling = active;
        playScroll.setAttribute("aria-label", active ? "Pause script" : "Start script");
        playIcon.innerHTML = active
          ? '<path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z"/>'
          : '<path d="m8 5 11 7-11 7V5Z"/>';
        if (active) {
          requestWakeLock();
          lastFrameTime = performance.now();
          scrollFrame = requestAnimationFrame(scrollStep);
        } else {
          releaseWakeLock();
          if (scrollFrame) {
            cancelAnimationFrame(scrollFrame);
            scrollFrame = 0;
          }
        }
      }

      function scrollStep(now) {
        if (!scrolling) return;
        var elapsed = Math.min(50, now - lastFrameTime);
        lastFrameTime = now;
        var maxOffset = setPromptOffset(scrollOffset + Number(speed.value) * elapsed / 1000);
        if (scrollOffset >= maxOffset - 1) {
          setScrollState(false);
          return;
        }
        scrollFrame = requestAnimationFrame(scrollStep);
      }

      function updateTimer() {
        if (!startedAt) { timer.textContent = "00:00"; return; }
        var pendingPause = pausedAt ? Date.now() - pausedAt : 0;
        var elapsed = Math.max(0, Math.floor((Date.now() - startedAt - totalPausedMs - pendingPause) / 1000));
        timer.textContent = String(Math.floor(elapsed / 60)).padStart(2, "0") + ":" + String(elapsed % 60).padStart(2, "0");
      }

      function setRecordingPaused(paused) {
        pauseRecording.classList.toggle("paused", paused);
        pauseRecording.setAttribute("aria-label", paused ? "Resume recording" : "Pause recording");
        pauseRecording.title = paused ? "Resume recording" : "Pause recording";
        pauseRecordingIcon.innerHTML = paused
          ? '<path d="m8 5 11 7-11 7V5Z"/>'
          : '<path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z"/>';
        recordStatus.classList.toggle("paused", paused);
        recordStatus.classList.toggle("live", !paused && recorder && recorder.state === "recording");
        statusLabel.textContent = paused ? "PAUSED" : "RECORDING";
      }

      function toggleRecordingPause() {
        if (!recorder) return;
        if (recorder.state === "recording") {
          recorder.pause();
          pausedAt = Date.now();
          updateTimer();
          clearInterval(timerInterval);
          timerInterval = 0;
          setRecordingPaused(true);
        } else if (recorder.state === "paused") {
          totalPausedMs += Date.now() - pausedAt;
          pausedAt = 0;
          recorder.resume();
          setRecordingPaused(false);
          timerInterval = setInterval(updateTimer, 250);
        }
      }

      function chooseMimeType() {
        var isAppleWebKit = /AppleWebKit/i.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//i.test(navigator.userAgent);
        var webmTypes = [
          "video/webm;codecs=vp8,opus",
          "video/webm;codecs=vp9,opus",
          "video/webm"
        ];
        var mp4Types = [
          "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
          "video/mp4;codecs=h264,aac",
          "video/mp4"
        ];
        var types = isAppleWebKit ? mp4Types.concat(webmTypes) : webmTypes.concat(mp4Types);
        if (!window.MediaRecorder) return "";
        for (var i = 0; i < types.length; i++) {
          if (!MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(types[i])) return types[i];
        }
        return "";
      }

      async function prepareRecordingAudio() {
        var microphoneTracks = stream ? stream.getAudioTracks().filter(function (track) {
          return track.enabled && track.readyState === "live";
        }) : [];
        if (!microphoneTracks.length) return false;

        var AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return true;
        try {
          recordingAudioContext = new AudioContextClass();
          recordingAudioSource = recordingAudioContext.createMediaStreamSource(stream);
          recordingAudioDestination = recordingAudioContext.createMediaStreamDestination();
          recordingAudioSource.connect(recordingAudioDestination);
          if (recordingAudioContext.state === "suspended") await recordingAudioContext.resume();
        } catch (error) {
          if (recordingAudioContext) recordingAudioContext.close().catch(function () {});
          recordingAudioContext = null;
          recordingAudioSource = null;
          recordingAudioDestination = null;
        }
        return true;
      }

      function createRecordingStream() {
        var capture = cameraCanvas.captureStream || cameraCanvas.webkitCaptureStream;
        if (!capture || !window.MediaStream) return null;
        var microphoneTracks = stream ? stream.getAudioTracks().filter(function (track) {
          return track.enabled && track.readyState === "live";
        }) : [];
        if (!microphoneTracks.length) return null;

        drawCameraFrame();
        var canvasStream = capture.call(cameraCanvas, 30);
        var audioTrack = microphoneTracks[0];
        if (recordingAudioDestination && recordingAudioContext && recordingAudioContext.state === "running") {
          var processedTrack = recordingAudioDestination.stream.getAudioTracks()[0];
          if (processedTrack && processedTrack.readyState === "live") audioTrack = processedTrack;
        }
        return new MediaStream(canvasStream.getVideoTracks().concat([audioTrack]));
      }

      function releaseRecordingStream() {
        if (recordingStream) {
          recordingStream.getVideoTracks().forEach(function (track) { track.stop(); });
          if (recordingAudioDestination) {
            recordingAudioDestination.stream.getAudioTracks().forEach(function (track) { track.stop(); });
          }
          recordingStream = null;
        }
        if (recordingAudioSource) {
          try { recordingAudioSource.disconnect(); } catch (error) {}
          recordingAudioSource = null;
        }
        recordingAudioDestination = null;
        if (recordingAudioContext) {
          recordingAudioContext.close().catch(function () {});
          recordingAudioContext = null;
        }
      }

      function runCountdown(force) {
        return new Promise(function (resolve) {
          if (!force && countdownToggle.getAttribute("aria-pressed") !== "true") { resolve(); return; }
          var number = 3;
          countdown.textContent = number;
          countdown.classList.add("show");
          var interval = setInterval(function () {
            number -= 1;
            if (number <= 0) {
              clearInterval(interval);
              countdown.classList.remove("show");
              resolve();
            } else {
              countdown.textContent = number;
            }
          }, 1000);
        });
      }

      async function startRecording() {
        if (startingRecording) return;
        startingRecording = true;
        trackEvent("recording_started");
        changeScript.disabled = true;
        portraitFrame.disabled = true;
        landscapeFrame.disabled = true;
        if (recordMode === "audio") {
          await startAudioRecording();
          return;
        }
        if (!stream) {
          var enabled = await startCamera();
          if (!enabled) {
            startingRecording = false;
            changeScript.disabled = false;
            portraitFrame.disabled = false;
            landscapeFrame.disabled = false;
            return;
          }
        }
        if (!window.MediaRecorder) {
          showError("Recording is not supported in this browser. Try opening the page in Safari or Chrome.");
          startingRecording = false;
          changeScript.disabled = false;
          portraitFrame.disabled = false;
          landscapeFrame.disabled = false;
          return;
        }
        if (scrolling) setScrollState(false);
        chunks = [];
        releaseRecordingStream();
        var audioReady = await prepareRecordingAudio();
        if (!audioReady) {
          showError("The recording could not include your microphone. Check microphone permission, then enable the camera and mic again.");
          startingRecording = false;
          changeScript.disabled = false;
          portraitFrame.disabled = false;
          landscapeFrame.disabled = false;
          return;
        }
        await runCountdown();
        recordingStream = createRecordingStream();
        if (!recordingStream) {
          releaseRecordingStream();
          showError("The recording could not include your microphone. Check microphone permission, then enable the camera and mic again.");
          startingRecording = false;
          changeScript.disabled = false;
          portraitFrame.disabled = false;
          landscapeFrame.disabled = false;
          return;
        }
        var mimeType = chooseMimeType();
        try {
          recorder = mimeType
            ? new MediaRecorder(recordingStream, { mimeType: mimeType, audioBitsPerSecond: 128000 })
            : new MediaRecorder(recordingStream, { audioBitsPerSecond: 128000 });
        } catch (error) {
          releaseRecordingStream();
          showError("The camera is available, but this browser could not start a recording.");
          startingRecording = false;
          changeScript.disabled = false;
          portraitFrame.disabled = false;
          landscapeFrame.disabled = false;
          return;
        }
        recorder.ondataavailable = function (event) {
          if (event.data && event.data.size) chunks.push(event.data);
        };
        recorder.onstop = finishRecording;
        recorder.onerror = function () {
          showError("Recording stopped because the browser reported an error.");
        };
        recorder.start(1000);
        videoModeBtn.disabled = true;
        audioModeBtn.disabled = true;
        recordButton.classList.add("recording");
        recordButton.setAttribute("aria-label", "Stop recording");
        pauseRecording.disabled = false;
        pausedAt = 0;
        totalPausedMs = 0;
        startedAt = Date.now();
        setRecordingPaused(false);
        updateTimer();
        timerInterval = setInterval(updateTimer, 250);
        setScrollState(true);
        startingRecording = false;
      }

      function stopRecording() {
        if (recorder && recorder.state !== "inactive") recorder.stop();
        recordButton.classList.remove("recording");
        recordButton.setAttribute("aria-label", "Start recording");
        pauseRecording.disabled = true;
        pauseRecording.classList.remove("paused");
        pauseRecording.setAttribute("aria-label", "Pause recording");
        pauseRecording.title = "Pause recording";
        pauseRecordingIcon.innerHTML = '<path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z"/>';
        recordStatus.classList.remove("live", "paused");
        statusLabel.textContent = "READY";
        changeScript.disabled = false;
        portraitFrame.disabled = false;
        landscapeFrame.disabled = false;
        videoModeBtn.disabled = false;
        audioModeBtn.disabled = false;
        clearInterval(timerInterval);
        timerInterval = 0;
        pausedAt = 0;
        totalPausedMs = 0;
        startedAt = 0;
      }

      function finishRecording() {
        var isAudioTake = recordMode === "audio";
        var fallbackType = isAudioTake ? "audio/webm" : "video/webm";
        var actualType = (recorder && recorder.mimeType) || (chunks[0] && chunks[0].type) || fallbackType;
        releaseRecordingStream();
        if (!chunks.length) {
          showError(isAudioTake
            ? "No audio was captured. Keep the page open and try another take."
            : "No video data was captured. Keep the page open and try another take.");
          return;
        }
        if (recordingUrl) URL.revokeObjectURL(recordingUrl);
        recordingBlob = new Blob(chunks, { type: actualType });
        recordingUrl = URL.createObjectURL(recordingBlob);
        var stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        if (isAudioTake) {
          var audioExt = actualType.indexOf("mp4") !== -1 ? "m4a" : "webm";
          recordingFilename = "clickprompt-voiceover-" + stamp + "." + audioExt;
          reviewVideo.pause();
          reviewVideo.removeAttribute("src");
          reviewVideo.load();
          reviewVideo.hidden = true;
          reviewAudio.hidden = false;
          reviewAudio.src = recordingUrl;
          reviewAudio.load();
          reviewTitle.textContent = "Voiceover complete";
          reviewSubtitle.textContent = "Listen back, then download the file or save it to your cloud library.";
          downloadLink.textContent = "Download voiceover";
          saveAudioCloud.hidden = false;
        } else {
          var extension = actualType.indexOf("mp4") !== -1 ? "mp4" : "webm";
          recordingFilename = "clickprompt-take-" + stamp + "." + extension;
          reviewAudio.pause();
          reviewAudio.removeAttribute("src");
          reviewAudio.hidden = true;
          reviewVideo.hidden = false;
          reviewVideo.pause();
          reviewVideo.defaultMuted = false;
          reviewVideo.muted = false;
          reviewVideo.volume = 1;
          reviewVideo.src = recordingUrl;
          reviewVideo.load();
          reviewTitle.textContent = "Take complete";
          reviewSubtitle.textContent = "Review it now, then download the file to keep it.";
          downloadLink.textContent = "Download take";
          saveAudioCloud.hidden = true;
        }
        downloadStatus.textContent = "";
        downloadLink.disabled = false;
        if (typeof reviewDialog.showModal === "function") reviewDialog.showModal();
        else reviewDialog.setAttribute("open", "");
      }

      function triggerBrowserDownload() {
        var saveUrl = URL.createObjectURL(recordingBlob);
        var anchor = document.createElement("a");
        anchor.href = saveUrl;
        anchor.download = recordingFilename;
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(function () { URL.revokeObjectURL(saveUrl); }, 60000);
      }

      async function downloadTake() {
        if (!recordingBlob) {
          downloadStatus.textContent = "This take is no longer available. Record another take and try again.";
          return;
        }
        trackEvent("download");
        downloadLink.disabled = true;
        downloadStatus.textContent = "Preparing your file…";
        var isAudioFile = recordMode === "audio";
        var extension = "." + recordingFilename.split(".").pop();
        var mime = recordingBlob.type || (isAudioFile ? "audio/webm" : "video/webm");
        var pickerDescription = isAudioFile ? "Audio recording" : "Video recording";
        try {
          if (typeof window.showSaveFilePicker === "function") {
            try {
              var handle = await window.showSaveFilePicker({
                suggestedName: recordingFilename,
                types: [{ description: pickerDescription, accept: { [mime]: [extension] } }]
              });
              var writable = await handle.createWritable();
              await writable.write(recordingBlob);
              await writable.close();
              downloadStatus.textContent = "Take saved.";
              return;
            } catch (pickerError) {
              if (pickerError && pickerError.name === "AbortError") {
                downloadStatus.textContent = "Save canceled.";
                return;
              }
            }
          }

          var file = typeof File === "function" ? new File([recordingBlob], recordingFilename, { type: mime }) : null;
          var touchDevice = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
          if (touchDevice && file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
              await navigator.share({ files: [file], title: recordingFilename });
              downloadStatus.textContent = "Take sent to your device's save menu.";
              return;
            } catch (shareError) {
              if (shareError && shareError.name === "AbortError") {
                downloadStatus.textContent = "Save canceled.";
                return;
              }
            }
          }

          triggerBrowserDownload();
          downloadStatus.textContent = "Download started.";
        } catch (error) {
          downloadStatus.textContent = "The file could not be saved. Keep this window open and try again.";
        } finally {
          downloadLink.disabled = false;
        }
      }

      // ---------- Audio-only (voiceover) mode ----------

      function setRecordMode(mode) {
        if (mode === recordMode) return;
        if (startingRecording) return;
        if (recorder && recorder.state !== "inactive") return;
        recordMode = mode;
        var isAudio = mode === "audio";
        setToggle(videoModeBtn, !isAudio);
        setToggle(audioModeBtn, isAudio);
        // Release the other mode's media; only what the mode needs stays live.
        if (isAudio) stopStream();
        else stopMic();
        orientationTool.style.display = isAudio ? "none" : "";
        cameraTool.style.display = isAudio ? "none" : "";
        cameraCanvas.style.display = isAudio ? "none" : "";
        waveform.hidden = !isAudio;
        if (isAudio) {
          cameraEmpty.style.display = "none";
          if (micStream) {
            micEmpty.style.display = "none";
            startWaveform();
          } else {
            micEmpty.style.display = "grid";
          }
          stageHint.textContent = "The white button controls the script. The red button records audio only — no video is captured.";
        } else {
          micEmpty.style.display = "none";
          stopWaveform();
          cameraEmpty.style.display = stream ? "none" : "grid";
          stageHint.textContent = "The white button controls the script. The button to the right of Record pauses or resumes the video.";
        }
        refreshPromptLayer();
      }

      async function startMic() {
        clearError();
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          showError("This browser does not provide microphone access here. Open the page in Safari or Chrome and try again.");
          return false;
        }
        try {
          stopMic();
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false
          });
          setupMicAnalyser();
          micEmpty.style.display = "none";
          statusLabel.textContent = "READY";
          startWaveform();
          refreshPromptLayer();
          return true;
        } catch (error) {
          var message = "Microphone access failed. Check the microphone permission, then try again.";
          if (error && error.name === "NotAllowedError") {
            message = "Microphone permission was blocked. Allow microphone access in your browser settings, then try again.";
          } else if (error && error.name === "NotFoundError") {
            message = "No microphone was found on this device.";
          }
          showError(message);
          micEmpty.style.display = "grid";
          return false;
        }
      }

      function stopMic() {
        stopWaveform();
        if (micAnalyser) {
          try { micAnalyser.disconnect(); } catch (ignore) {}
          micAnalyser = null;
        }
        if (micAudioContext) {
          var ctx = micAudioContext;
          micAudioContext = null;
          ctx.close().catch(function () {});
        }
        if (micStream) {
          micStream.getTracks().forEach(function (track) { track.stop(); });
          micStream = null;
        }
      }

      function setupMicAnalyser() {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC || !micStream) return;
        try {
          micAudioContext = new AC();
          var source = micAudioContext.createMediaStreamSource(micStream);
          micAnalyser = micAudioContext.createAnalyser();
          micAnalyser.fftSize = 2048;
          source.connect(micAnalyser);
          if (micAudioContext.state === "suspended") micAudioContext.resume();
        } catch (error) {
          micAnalyser = null;
        }
      }

      function sizeWaveform() {
        var rect = waveform.getBoundingClientRect();
        var ratio = window.devicePixelRatio || 1;
        var w = Math.max(2, Math.round(rect.width * ratio));
        var h = Math.max(2, Math.round(rect.height * ratio));
        if (waveform.width !== w || waveform.height !== h) {
          waveform.width = w;
          waveform.height = h;
        }
      }

      function drawWaveform() {
        waveformFrame = 0;
        if (recordMode !== "audio" || waveform.hidden) return;
        sizeWaveform();
        var w = waveform.width;
        var h = waveform.height;
        var mid = h / 2;
        waveformCtx.fillStyle = "#0a1114";
        waveformCtx.fillRect(0, 0, w, h);
        waveformCtx.strokeStyle = recordStatus.classList.contains("live") ? "#ff7c55" : "#3f8fa3";
        waveformCtx.lineWidth = Math.max(2, h * 0.016);
        waveformCtx.lineJoin = "round";
        waveformCtx.beginPath();
        if (micAnalyser) {
          var data = new Uint8Array(micAnalyser.fftSize);
          micAnalyser.getByteTimeDomainData(data);
          var step = Math.max(1, Math.floor(data.length / w));
          for (var x = 0; x < w; x++) {
            var v = data[Math.min(data.length - 1, x * step)] / 128 - 1;
            var y = mid + v * h * 0.44;
            if (x === 0) waveformCtx.moveTo(x, y);
            else waveformCtx.lineTo(x, y);
          }
        } else {
          waveformCtx.moveTo(0, mid);
          waveformCtx.lineTo(w, mid);
        }
        waveformCtx.stroke();
        waveformFrame = requestAnimationFrame(drawWaveform);
      }

      function startWaveform() {
        if (!waveformFrame) waveformFrame = requestAnimationFrame(drawWaveform);
      }

      function stopWaveform() {
        if (waveformFrame) {
          cancelAnimationFrame(waveformFrame);
          waveformFrame = 0;
        }
      }

      function chooseAudioMimeType() {
        if (!window.MediaRecorder) return "";
        var types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
        for (var i = 0; i < types.length; i++) {
          if (!window.MediaRecorder.isTypeSupported || window.MediaRecorder.isTypeSupported(types[i])) return types[i];
        }
        return "";
      }

      function audioStartFailed(message) {
        showError(message);
        startingRecording = false;
        changeScript.disabled = false;
        portraitFrame.disabled = false;
        landscapeFrame.disabled = false;
      }

      async function startAudioRecording() {
        try {
          if (!micStream) {
            var enabled = await startMic();
            if (!enabled) {
              audioStartFailed("Microphone permission is needed before a voiceover can be recorded.");
              return;
            }
          }
          if (!window.MediaRecorder) {
            audioStartFailed("Recording is not supported in this browser. Try opening the page in Safari or Chrome.");
            return;
          }
          if (scrolling) setScrollState(false);
          chunks = [];
          // Audio mode always runs the 3-2-1 countdown.
          await runCountdown(true);
          var mimeType = chooseAudioMimeType();
          try {
            recorder = mimeType
              ? new MediaRecorder(micStream, { mimeType: mimeType, audioBitsPerSecond: 128000 })
              : new MediaRecorder(micStream);
          } catch (error) {
            audioStartFailed("The microphone could not start recording. Check microphone permission, then try again.");
            return;
          }
          recorder.ondataavailable = function (event) {
            if (event.data && event.data.size) chunks.push(event.data);
          };
          recorder.onstop = finishRecording;
          recorder.onerror = function () {
            showError("The recording hit an error and stopped. Keep the page open and try another take.");
          };
          recorder.start(1000);
          videoModeBtn.disabled = true;
          audioModeBtn.disabled = true;
          recordButton.classList.add("recording");
          recordButton.setAttribute("aria-label", "Stop recording");
          recordButton.title = "Stop recording";
          statusLabel.textContent = "REC";
          recordStatus.classList.add("live");
          startTimer();
          setScrollState(true);
          pauseRecording.disabled = false;
          pauseRecording.classList.remove("paused");
          pauseRecording.setAttribute("aria-label", "Pause recording");
        } finally {
          startingRecording = false;
        }
      }

      async function saveAudioToCloud() {
        if (!recordingBlob) {
          downloadStatus.textContent = "This voiceover is no longer available. Record another take and try again.";
          return;
        }
        if (!unlockState.unlocked) {
          openPaywall();
          return;
        }
        saveAudioCloud.disabled = true;
        downloadStatus.textContent = "Saving to your cloud library…";
        try {
          var title = (defaultScriptTitle() || "Voiceover") + " — voiceover";
          var res = await fetch(API_BASE + "/api/audio?token=" + encodeURIComponent(getToken()) + "&title=" + encodeURIComponent(title), {
            method: "POST",
            headers: { "Content-Type": recordingBlob.type || "audio/webm" },
            body: recordingBlob
          });
          var data = await res.json().catch(function () { return {}; });
          if (res.ok) {
            downloadStatus.textContent = "Saved to your cloud library.";
            if (data && Array.isArray(data.audio)) renderAudioLibrary(data.audio);
            else loadAudioLibrary();
          } else if (res.status === 403) {
            setToken("");
            unlockState = { unlocked: false, via: null };
            updateUnlockUI();
            openPaywall();
          } else {
            downloadStatus.textContent = (data && data.error) || "Couldn't save. Try again.";
          }
        } catch (error) {
          downloadStatus.textContent = "Couldn't reach the server. Try again.";
        } finally {
          saveAudioCloud.disabled = false;
        }
      }

      function formatBytes(bytes) {
        bytes = Number(bytes) || 0;
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1048576) return Math.round(bytes / 1024) + " KB";
        return (bytes / 1048576).toFixed(1) + " MB";
      }

      function formatShortDate(ts) {
        try {
          return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
        } catch (error) {
          return "";
        }
      }

      async function loadAudioLibrary() {
        if (!unlockState.unlocked) return;
        try {
          var data = await apiGet("/api/audio?token=" + encodeURIComponent(getToken()));
          if (data && Array.isArray(data.audio)) {
            renderAudioLibrary(data.audio);
          } else if (data && data.unlocked === false) {
            setToken("");
            unlockState = { unlocked: false, via: null };
            updateUnlockUI();
          }
        } catch (error) {
          // The library loads quietly; setup stays usable without it.
        }
      }

      function stopLibraryPlayback() {
        libraryAudio.pause();
        libraryAudio.removeAttribute("src");
        libraryPlayingId = null;
        var buttons = audioLibraryList.querySelectorAll(".library-play");
        for (var i = 0; i < buttons.length; i++) {
          if (buttons[i].textContent === "Pause") buttons[i].textContent = "Play";
        }
      }

      function toggleLibraryPlayback(id, button) {
        if (libraryPlayingId === id) {
          stopLibraryPlayback();
          return;
        }
        stopLibraryPlayback();
        libraryAudio.src = API_BASE + "/api/audio?id=" + encodeURIComponent(id) + "&token=" + encodeURIComponent(getToken());
        libraryAudio.play().catch(function () {});
        libraryPlayingId = id;
        button.textContent = "Pause";
        libraryAudio.onended = function () { stopLibraryPlayback(); };
      }

      async function downloadLibraryAudio(item) {
        try {
          var res = await fetch(API_BASE + "/api/audio?id=" + encodeURIComponent(item.id) + "&token=" + encodeURIComponent(getToken()));
          if (!res.ok) return;
          trackEvent("download");
          var blob = await res.blob();
          var url = URL.createObjectURL(blob);
          var anchor = document.createElement("a");
          var ext = (item.contentType || "").indexOf("mp4") !== -1 ? "m4a" : "webm";
          var slug = String(item.title || "voiceover").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, 60) || "voiceover";
          anchor.href = url;
          anchor.download = slug + "." + ext;
          anchor.style.display = "none";
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          window.setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        } catch (error) {
          // Quiet: the row stays and the user can retry.
        }
      }

      async function deleteLibraryAudio(id) {
        if (!window.confirm("Delete this voiceover from your cloud library?")) return;
        try {
          var res = await fetch(API_BASE + "/api/audio?id=" + encodeURIComponent(id) + "&token=" + encodeURIComponent(getToken()), { method: "DELETE" });
          var data = await res.json().catch(function () { return {}; });
          if (res.ok && data && Array.isArray(data.audio)) {
            renderAudioLibrary(data.audio);
          } else if (res.status === 403) {
            setToken("");
            unlockState = { unlocked: false, via: null };
            updateUnlockUI();
          }
        } catch (error) {
          // Quiet: the row stays and the user can retry.
        }
      }

      function renderAudioLibrary(items) {
        audioLibraryList.innerHTML = "";
        stopLibraryPlayback();
        refreshStorageLine();
        if (!items.length) {
          var empty = document.createElement("li");
          empty.className = "library-empty";
          empty.textContent = "No voiceovers saved yet. Record in Audio only mode, then save one to the cloud.";
          audioLibraryList.appendChild(empty);
          return;
        }
        items.forEach(function (item) {
          var li = document.createElement("li");
          li.className = "library-item";

          var label = document.createElement("span");
          label.className = "library-title";
          label.textContent = item.title + " · " + formatShortDate(item.createdAt) + " · " + formatBytes(item.size);
          li.appendChild(label);

          var play = document.createElement("button");
          play.type = "button";
          play.className = "library-play";
          play.textContent = "Play";
          play.setAttribute("aria-label", "Play " + item.title);
          play.addEventListener("click", function () { toggleLibraryPlayback(item.id, play); });
          li.appendChild(play);

          var download = document.createElement("button");
          download.type = "button";
          download.className = "library-play";
          download.textContent = "Download";
          download.setAttribute("aria-label", "Download " + item.title);
          download.addEventListener("click", function () { downloadLibraryAudio(item); });
          li.appendChild(download);

          var del = document.createElement("button");
          del.type = "button";
          del.className = "library-delete";
          del.textContent = "Delete";
          del.setAttribute("aria-label", "Delete " + item.title);
          del.addEventListener("click", function () { deleteLibraryAudio(item.id); });
          li.appendChild(del);

          audioLibraryList.appendChild(li);
        });
      }

      // ---------- end audio-only mode ----------

      enableCamera.addEventListener("click", function () { startCamera(); });
      openPrompter.addEventListener("click", showPrompter);
      changeScript.addEventListener("click", showSetup);
      camera.addEventListener("loadedmetadata", function () { syncRecordingFrame(); refreshPromptLayer(); });
      camera.addEventListener("resize", function () { syncRecordingFrame(); refreshPromptLayer(); });
      window.addEventListener("resize", refreshPromptLayer);
      cameraSelect.addEventListener("change", function () { startCamera(cameraSelect.value); });
      portraitFrame.addEventListener("click", function () { setRecordingOrientation("portrait"); });
      landscapeFrame.addEventListener("click", function () { setRecordingOrientation("landscape"); });
      generateButton.addEventListener("click", generateScript);
      scriptInput.addEventListener("input", updateScript);
      speed.addEventListener("input", updateRangeLabels);
      fontSize.addEventListener("input", updateRangeLabels);
      saveScriptButton.addEventListener("click", saveCurrentScript);
      subscribeButton.addEventListener("click", function () {
        trackEvent("subscribe");
        startCheckout();
      });
      var planRadios = document.querySelectorAll('input[name="plan"]');
      for (var pi = 0; pi < planRadios.length; pi++) {
        planRadios[pi].addEventListener("change", refreshSubscribeButton);
      }
      refreshSubscribeButton();
      redeemButton.addEventListener("click", redeemCode);
      paywallClose.addEventListener("click", closePaywall);
      codeInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") redeemCode();
      });

      countdownToggle.addEventListener("click", function () { togglePressed(countdownToggle); });
      mirrorToggle.addEventListener("click", function () {
        togglePressed(mirrorToggle);
        cameraCanvas.classList.toggle("mirrored", mirrorToggle.getAttribute("aria-pressed") === "true");
      });
      backplateToggle.addEventListener("click", function () {
        togglePressed(backplateToggle);
        guide.classList.toggle("backplate", backplateToggle.getAttribute("aria-pressed") === "true");
      });
      flipTextToggle.addEventListener("click", function () {
        togglePressed(flipTextToggle);
        guide.classList.toggle("flipped", flipTextToggle.getAttribute("aria-pressed") === "true");
      });

      playScroll.addEventListener("click", function () { setScrollState(!scrolling); });
      guide.addEventListener("click", function () { setScrollState(!scrolling); });
      rewind.addEventListener("click", function () {
        setScrollState(false);
        setPromptOffset(0);
      });
      recordButton.addEventListener("click", function () {
        if (recorder && (recorder.state === "recording" || recorder.state === "paused")) stopRecording();
        else startRecording();
      });
      pauseRecording.addEventListener("click", toggleRecordingPause);
      fullscreen.addEventListener("click", function () {
        if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
        else if (stage.requestFullscreen) stage.requestFullscreen();
      });
      videoModeBtn.addEventListener("click", function () { setRecordMode("video"); });
      audioModeBtn.addEventListener("click", function () { setRecordMode("audio"); });
      enableMic.addEventListener("click", function () { startMic(); });
      saveAudioCloud.addEventListener("click", saveAudioToCloud);
      downloadLink.addEventListener("click", downloadTake);
      newTake.addEventListener("click", function () {
        reviewVideo.pause();
        reviewAudio.pause();
        reviewDialog.close();
        downloadStatus.textContent = "";
        setPromptOffset(0);
        timer.textContent = "00:00";
      });
      reviewDialog.addEventListener("close", function () { reviewVideo.pause(); reviewAudio.pause(); });
      document.addEventListener("visibilitychange", function () {
        if (document.hidden && recorder && recorder.state !== "inactive") stopRecording();
        if (document.hidden) releaseWakeLock();
        else if (scrolling) requestWakeLock();
      });
      window.addEventListener("beforeunload", function () {
        releaseRecordingStream();
        stopStream();
        stopMic();
        stopLibraryPlayback();
        if (recordingUrl) URL.revokeObjectURL(recordingUrl);
      });

      scriptInput.value = "";
      updateScript();
      updateRangeLabels();
      refreshUnlock();

      // ---- first-run tour ----
      // Lightweight hover-style walkthrough: spotlight + tooltip, 6 steps,
      // all in the setup view. Auto-shows once per browser (localStorage);
      // "Take the tour" replays it anytime. Never blocks: the spotlight
      // and dimming are pointer-events:none, and Esc/Skip dismisses.
      var TOUR_SEEN_KEY = "clickprompt_tour_seen";
      var TOUR_STEPS = [
        {
          target: "#qPoint",
          title: "Start with your one point",
          text: "Answer the five quick questions about your video. Question 4 — your one point — is what the whole script is built around."
        },
        {
          target: "#generateScript",
          title: "Generate your script",
          text: "The AI drafts your script in seconds. It's free, 3 scripts a day."
        },
        {
          target: "#scriptInput",
          title: "Make it yours",
          text: "Edit every word before you record. The prompter reads exactly what's in this box."
        },
        {
          target: "#openPrompter",
          title: "Open the prompter",
          text: "Your script scrolls on screen while you record. Inside you can pick video or audio-only, set the scroll speed, and pause anytime."
        },
        {
          target: "#saveScript",
          title: "Save to the cloud",
          text: "Pro keeps every script and voiceover saved online, on any device. Everything else — interview, script, recording — stays free forever."
        },
        {
          target: ".setup-head",
          title: "You're ready",
          text: "That's the whole flow: answer, generate, open the prompter, hit record. Happy filming."
        }
      ];
      var tourIndex = -1;
      var tourHighlight = null;
      var tourTooltip = null;

      function tourCleanup() {
        if (tourHighlight && tourHighlight.parentNode) tourHighlight.parentNode.removeChild(tourHighlight);
        if (tourTooltip && tourTooltip.parentNode) tourTooltip.parentNode.removeChild(tourTooltip);
        tourHighlight = null;
        tourTooltip = null;
        tourIndex = -1;
        window.removeEventListener("resize", tourReposition);
        window.removeEventListener("scroll", tourReposition, true);
        document.removeEventListener("keydown", tourKeyHandler);
      }

      function endTour(seen) {
        tourCleanup();
        try {
          if (seen === undefined || seen) localStorage.setItem(TOUR_SEEN_KEY, "1");
        } catch (e) {}
        // Post-tutorial: on mobile, ask where the video is going (once).
        maybeShowPlatformOverlay();
      }

      function tourKeyHandler(e) {
        if (e.key === "Escape") endTour(true);
      }

      function tourReposition() {
        if (tourIndex >= 0) positionTourStep();
      }

      function positionTourStep() {
        var step = TOUR_STEPS[tourIndex];
        var el = document.querySelector(step.target);
        if (!el) { tourAdvance(1); return; }
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) { tourAdvance(1); return; }
        var pad = 6;
        tourHighlight.style.top = (rect.top - pad) + "px";
        tourHighlight.style.left = (rect.left - pad) + "px";
        tourHighlight.style.width = (rect.width + pad * 2) + "px";
        tourHighlight.style.height = (rect.height + pad * 2) + "px";
        // Tooltip below the target when there's room, otherwise above.
        var tipH = tourTooltip.offsetHeight || 180;
        var top = rect.bottom + pad + 10;
        if (top + tipH > window.innerHeight - 8) {
          top = Math.max(8, rect.top - pad - 10 - tipH);
        }
        var left = Math.min(
          Math.max(8, rect.left),
          window.innerWidth - tourTooltip.offsetWidth - 8
        );
        tourTooltip.style.top = top + "px";
        tourTooltip.style.left = Math.max(8, left) + "px";
      }

      function renderTourStep() {
        var step = TOUR_STEPS[tourIndex];
        var last = tourIndex === TOUR_STEPS.length - 1;
        tourTooltip.innerHTML = "";
        // Q, the ClickPrompt mascot, guides the tour.
        var guide = document.createElement("div");
        guide.className = "tour-guide";
        var avatar = document.createElement("img");
        avatar.className = "tour-guide-avatar";
        avatar.src = "brand/cue.webp";
        avatar.alt = "Q, the ClickPrompt mascot";
        var who = document.createElement("div");
        who.className = "tour-guide-who";
        var guideName = document.createElement("div");
        guideName.className = "tour-guide-name";
        guideName.textContent = "Q";
        var guideSub = document.createElement("div");
        guideSub.className = "tour-guide-sub";
        guideSub.textContent = "your ClickPrompt guide";
        who.appendChild(guideName);
        who.appendChild(guideSub);
        guide.appendChild(avatar);
        guide.appendChild(who);
        var h = document.createElement("h3");
        h.textContent = step.title;
        var p = document.createElement("p");
        p.textContent = step.text;
        var nav = document.createElement("div");
        nav.className = "tour-nav";
        var count = document.createElement("span");
        count.className = "tour-count";
        count.textContent = (tourIndex + 1) + " of " + TOUR_STEPS.length;
        var skip = document.createElement("button");
        skip.type = "button";
        skip.className = "tour-skip";
        skip.textContent = "Skip tour";
        skip.addEventListener("click", function () { endTour(true); });
        var back = document.createElement("button");
        back.type = "button";
        back.className = "tour-back";
        back.textContent = "Back";
        back.disabled = tourIndex === 0;
        back.addEventListener("click", function () { tourAdvance(-1); });
        var next = document.createElement("button");
        next.type = "button";
        next.className = "tour-next";
        next.textContent = last ? "Finish" : "Next";
        next.addEventListener("click", function () {
          if (last) endTour(true);
          else tourAdvance(1);
        });
        nav.appendChild(count);
        nav.appendChild(skip);
        nav.appendChild(back);
        nav.appendChild(next);
        tourTooltip.appendChild(guide);
        tourTooltip.appendChild(h);
        tourTooltip.appendChild(p);
        tourTooltip.appendChild(nav);
        next.focus();
      }

      function tourAdvance(dir) {
        tourIndex += dir;
        if (tourIndex < 0) tourIndex = 0;
        if (tourIndex >= TOUR_STEPS.length) { endTour(true); return; }
        var el = document.querySelector(TOUR_STEPS[tourIndex].target);
        if (el && el.scrollIntoView) {
          try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
        }
        // Let smooth scrolling settle before measuring.
        setTimeout(function () {
          if (tourIndex < 0) return;
          renderTourStep();
          positionTourStep();
        }, 350);
      }

      function startTour() {
        if (tourIndex >= 0) return; // already running
        tourCleanup();
        tourHighlight = document.createElement("div");
        tourHighlight.className = "tour-highlight";
        tourHighlight.setAttribute("aria-hidden", "true");
        tourTooltip = document.createElement("div");
        tourTooltip.className = "tour-tooltip";
        tourTooltip.setAttribute("role", "dialog");
        tourTooltip.setAttribute("aria-label", "ClickPrompt tour");
        document.body.appendChild(tourHighlight);
        document.body.appendChild(tourTooltip);
        window.addEventListener("resize", tourReposition);
        window.addEventListener("scroll", tourReposition, true);
        document.addEventListener("keydown", tourKeyHandler);
        tourIndex = 0;
        tourAdvance(0);
      }

      var replayTourButton = document.getElementById("replayTour");
      if (replayTourButton) {
        replayTourButton.addEventListener("click", startTour);
      }

      // Platform overlay wiring (brief §6): card grid, Other autocomplete,
      // dismissible, shown once.
      (function wirePlatformOverlay() {
        var dialog = document.getElementById("platformDialog");
        if (!dialog) return;
        var grid = document.getElementById("platformGrid");
        if (grid) {
          grid.addEventListener("click", function (e) {
            var btn = e.target.closest ? e.target.closest(".platform-card") : null;
            if (!btn) return;
            var key = btn.getAttribute("data-platform");
            var def = PLATFORM_DEFAULTS[key];
            choosePlatform(key, def ? def.label : key);
          });
        }
        var other = document.getElementById("platformOther");
        if (other) {
          other.addEventListener("keydown", function (e) {
            if (e.key !== "Enter") return;
            e.preventDefault();
            var label = other.value.trim();
            if (!label) return;
            // Match a known platform by label (case-insensitive).
            var matched = null;
            Object.keys(PLATFORM_DEFAULTS).forEach(function (k) {
              if (PLATFORM_DEFAULTS[k].label.toLowerCase() === label.toLowerCase()) matched = k;
            });
            if (matched) choosePlatform(matched, PLATFORM_DEFAULTS[matched].label);
            else choosePlatform("custom", label);
          });
        }
        var skip = document.getElementById("platformSkip");
        if (skip) {
          skip.addEventListener("click", function () {
            savePlatformChoice("skipped", "skipped", "", 0, "");
            if (typeof dialog.close === "function") dialog.close();
          });
        }
        // Clicking the backdrop dismisses without choosing.
        dialog.addEventListener("click", function (e) {
          if (e.target === dialog) {
            savePlatformChoice("skipped", "skipped", "", 0, "");
            dialog.close();
          }
        });
      })();

      // Set the visitor cookie on first load so the free cap has an
      // identity even before the first generation.
      visitorId();
      // Auto-show once for first-time visitors. Delayed so the layout
      // settles; skipped entirely for returning users.
      try {
        if (!localStorage.getItem(TOUR_SEEN_KEY)) {
          setTimeout(function () {
            try {
              if (!localStorage.getItem(TOUR_SEEN_KEY)) startTour();
            } catch (e) {}
          }, 800);
        }
      } catch (e) {}
    }());
