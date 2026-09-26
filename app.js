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
      var downloadLink = document.getElementById("downloadLink");
      var downloadStatus = document.getElementById("downloadStatus");
      var newTake = document.getElementById("newTake");
      var openPrompter = document.getElementById("openPrompter");
      var changeScript = document.getElementById("changeScript");

      // ---- Paywall: script saving ($0.95/mo or access code) ----
      // Everything else (interview, generation, prompter) stays free.
      var API_BASE = "https://teleprompter-script-api.synaptiqs.workers.dev";
      var TOKEN_KEY = "clickprompt_token";
      var saveScriptButton = document.getElementById("saveScript");
      var saveStatus = document.getElementById("saveStatus");
      var library = document.getElementById("library");
      var libraryList = document.getElementById("libraryList");
      var paywallDialog = document.getElementById("paywallDialog");
      var subscribeButton = document.getElementById("subscribeButton");
      var paywallStatus = document.getElementById("paywallStatus");
      var codeInput = document.getElementById("codeInput");
      var redeemButton = document.getElementById("redeemButton");
      var paywallClose = document.getElementById("paywallClose");
      var unlockState = { unlocked: false, via: null };

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
          saveStatus.textContent = unlockState.via === "code"
            ? "Saving unlocked with your access code."
            : "Saving unlocked — subscription active.";
          loadLibrary();
        } else {
          library.hidden = true;
          libraryList.innerHTML = "";
          saveStatus.textContent = "";
        }
      }

      function openPaywall() {
        paywallStatus.textContent = "";
        codeInput.value = "";
        if (typeof paywallDialog.showModal === "function") paywallDialog.showModal();
      }

      function closePaywall() {
        if (paywallDialog.open) paywallDialog.close();
      }

      async function startCheckout() {
        subscribeButton.disabled = true;
        paywallStatus.textContent = "Opening secure checkout…";
        try {
          var data = await apiPost("/api/checkout", { origin: window.location.origin });
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
          var response = await fetch(SCRIPT_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(answers)
          });
          if (!response.ok) throw new Error("request failed");
          var data = await response.json();
          if (!data || !data.script) throw new Error("empty script");
          scriptInput.value = data.script;
          setPromptOffset(0);
          setScrollState(false);
          updateScript();
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
        if (!stream) await startCamera();
        else syncRecordingFrame();
      }

      async function showSetup() {
        if (startingRecording || (recorder && recorder.state !== "inactive")) return;
        setScrollState(false);
        await stopStream();
        camera.srcObject = null;
        cameraEmpty.style.display = "grid";
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

      function runCountdown() {
        return new Promise(function (resolve) {
          if (countdownToggle.getAttribute("aria-pressed") !== "true") { resolve(); return; }
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
        changeScript.disabled = true;
        portraitFrame.disabled = true;
        landscapeFrame.disabled = true;
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
        clearInterval(timerInterval);
        timerInterval = 0;
        pausedAt = 0;
        totalPausedMs = 0;
        startedAt = 0;
      }

      function finishRecording() {
        var actualType = (recorder && recorder.mimeType) || (chunks[0] && chunks[0].type) || "video/webm";
        releaseRecordingStream();
        if (!chunks.length) {
          showError("No video data was captured. Keep the page open and try another take.");
          return;
        }
        if (recordingUrl) URL.revokeObjectURL(recordingUrl);
        recordingBlob = new Blob(chunks, { type: actualType });
        recordingUrl = URL.createObjectURL(recordingBlob);
        reviewVideo.pause();
        reviewVideo.defaultMuted = false;
        reviewVideo.muted = false;
        reviewVideo.volume = 1;
        reviewVideo.src = recordingUrl;
        reviewVideo.load();
        var extension = actualType.indexOf("mp4") !== -1 ? "mp4" : "webm";
        var stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        recordingFilename = "teleprompter-take-" + stamp + "." + extension;
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
        downloadLink.disabled = true;
        downloadStatus.textContent = "Preparing your file…";
        var extension = recordingFilename.endsWith(".mp4") ? ".mp4" : ".webm";
        var mime = recordingBlob.type || (extension === ".mp4" ? "video/mp4" : "video/webm");
        try {
          if (typeof window.showSaveFilePicker === "function") {
            try {
              var handle = await window.showSaveFilePicker({
                suggestedName: recordingFilename,
                types: [{ description: "Video recording", accept: { [mime]: [extension] } }]
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
      subscribeButton.addEventListener("click", startCheckout);
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
      downloadLink.addEventListener("click", downloadTake);
      newTake.addEventListener("click", function () {
        reviewVideo.pause();
        reviewDialog.close();
        downloadStatus.textContent = "";
        setPromptOffset(0);
        timer.textContent = "00:00";
      });
      reviewDialog.addEventListener("close", function () { reviewVideo.pause(); });
      document.addEventListener("visibilitychange", function () {
        if (document.hidden && recorder && recorder.state !== "inactive") stopRecording();
        if (document.hidden) releaseWakeLock();
        else if (scrolling) requestWakeLock();
      });
      window.addEventListener("beforeunload", function () {
        releaseRecordingStream();
        stopStream();
        if (recordingUrl) URL.revokeObjectURL(recordingUrl);
      });

      scriptInput.value = "";
      updateScript();
      updateRangeLabels();
      refreshUnlock();
    }());
