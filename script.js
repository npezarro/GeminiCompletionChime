// ==UserScript==
// @name        Gemini Completion Ping (UI + Network, background-safe)
// @namespace   nicholas.tools
// @version     6.0.0
// @description Chime + Desktop Notification on completion. Detects completion via (1) network request finishing (works even if UI doesn't update in background) + (2) Stop button fallback. Loud logging.
// @match       https://gemini.google.com/*
// @grant       none
// @run-at      document-start
// ==/UserScript==

(() => {
  "use strict";

  /* =========================
   * CONFIG
   * ========================= */
  const CONFIG = {
    // Polling fallback (UI-based)
    POLL_MS: 750,
    HEARTBEAT_LOG: true,

    // Network-based completion (primary)
    NET_DETECT: true,

    // Only attach to network requests whose URL matches at least one of these.
    // Tune this after watching logs for a few sends.
    NET_URL_HINTS: [
      /\/data\/batchexecute/i,
      /BardChatUi/i,
      /bard/i,
      /gemini/i,
      /assistant/i,
      /chat/i,
      /stream/i,
      /generate/i,
      /rpc/i
    ],

    // Avoid attaching to requests that started long before you pressed send
    NET_ATTACH_WINDOW_MS: 10_000, // attach only if request start is within this window after arm()

    // Completion debounce (UI flicker guard)
    STOP_GONE_DEBOUNCE_MS: 250,

    // Notifications
    NOTIFY: true,

    // Audio
    AUDIO: true,

    // Console verbosity for network matching decisions
    NET_DEBUG: true,
  };

  /* =========================
   * LOGGING
   * ========================= */
  const log = (msg, color = "#00ff00") =>
    console.log(`%c[GEMINI-PING] ${msg}`, `color:${color}; font-weight:bold;`);
  const dbg = (...a) => console.log("[GEMINI-PING]", ...a);
  const t = () => new Date().toLocaleTimeString();
  const vis = () => (document.visibilityState || "unknown");

  /* =========================
   * SELECTORS (best-effort)
   * ========================= */
  const SELECTORS = {
    COMPOSER: 'div[contenteditable="true"]',
    SEND: [
      'button[aria-label*="Send"]',
      'button[aria-label*="Send message"]',
      'button[data-testid*="send"]'
    ].join(","),
    STOP: [
      'button[aria-label*="Stop"]',
      'button[aria-label*="Stop generating"]',
      'button[data-testid*="stop"]'
    ].join(",")
  };

  const q = (sel) => document.querySelector(sel);
  const isVisible = (el) => !!(el && el.offsetParent !== null);

  const isStopVisible = () => isVisible(q(SELECTORS.STOP));
  const findSendBtn = (target) => target?.closest?.(SELECTORS.SEND);

  /* =========================
   * NOTIFICATIONS
   * ========================= */
  function requestNotifyPermission() {
    if (!CONFIG.NOTIFY) return;
    if (Notification.permission !== "granted" && Notification.permission !== "denied") {
      Notification.requestPermission().then(p => log(`Notification permission: ${p}`, "#b388ff"));
    }
  }

  function sendNotification() {
    if (!CONFIG.NOTIFY) return;
    if (Notification.permission === "granted") {
      new Notification("Gemini Completed", {
        body: "Your response is ready.",
        icon: "https://www.gstatic.com/images/branding/product/1x/bard_64dp.png",
        requireInteraction: false
      });
    }
  }

  /* =========================
   * AUDIO (HTMLAudio primary + WebAudio fallback)
   * ========================= */
  function makeChimeWavDataURL() {
    // Simple 3-note triad (short, reliable)
    const sr = 44100;
    const notes = [
      { f: 523.25, d: 0.12 }, // C5
      { f: 659.25, d: 0.12 }, // E5
      { f: 783.99, d: 0.36 }, // G5
    ];
    const gap = 0.05;
    const dur = notes.reduce((a, n) => a + n.d, 0) + gap * (notes.length - 1) + 0.15;
    const N = Math.floor(sr * dur);
    const data = new Float32Array(N).fill(0);

    const amp = 0.34;
    let cursor = 0;

    for (const { f, d } of notes) {
      const start = cursor;
      const len = Math.floor(d * sr);
      for (let i = 0; i < len && start + i < N; i++) {
        const x = i / sr;
        const env =
          i < 0.01 * sr ? i / (0.01 * sr) :
          i > len - 0.04 * sr ? Math.max(0, (len - i) / (0.04 * sr)) :
          1;

        const s1 = Math.sin(2 * Math.PI * f * x);
        const s2 = Math.sin(2 * Math.PI * (f * 1.003) * x) * 0.55;
        data[start + i] += amp * env * (0.72 * s1 + 0.28 * s2);
      }
      cursor += len + Math.floor(gap * sr);
    }

    const pcm = new DataView(new ArrayBuffer(44 + N * 2));
    let off = 0;
    const wStr = (s) => { for (let i = 0; i < s.length; i++) pcm.setUint8(off++, s.charCodeAt(i)); };
    const w32 = (u) => { pcm.setUint32(off, u, true); off += 4; };
    const w16 = (u) => { pcm.setUint16(off, u, true); off += 2; };

    wStr("RIFF"); w32(36 + N * 2); wStr("WAVE");
    wStr("fmt "); w32(16); w16(1); w16(1);
    w32(sr); w32(sr * 2); w16(2); w16(16);
    wStr("data"); w32(N * 2);

    for (let i = 0; i < N; i++) {
      const v = Math.max(-1, Math.min(1, data[i]));
      pcm.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
      off += 2;
    }

    const u8 = new Uint8Array(pcm.buffer);
    const b64 = btoa(String.fromCharCode(...u8));
    return `data:audio/wav;base64,${b64}`;
  }

  const CHIME_URL = makeChimeWavDataURL();
  const primeAudioEl = new Audio(CHIME_URL);
  primeAudioEl.preload = "auto";

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let ctx;
  const ensureCtx = () => (ctx ||= (AudioCtx ? new AudioCtx() : null));

  async function playChime(reason) {
    if (!CONFIG.AUDIO) return;
    // HTMLAudio attempt
    try {
      const a = primeAudioEl.cloneNode();
      a.volume = 1.0;
      await a.play();
      log(`🔊 Chime (HTMLAudio) ${reason} @ ${t()} (vis=${vis()})`, "#00e5ff");
      return;
    } catch (e) {
      if (CONFIG.NET_DEBUG) dbg("HTMLAudio play failed:", e?.message || e);
    }

    // WebAudio fallback
    try {
      const c = ensureCtx();
      if (!c) return;
      if (c.state === "suspended") await c.resume();

      const t0 = c.currentTime + 0.03;
      const master = c.createGain();
      master.gain.setValueAtTime(0.28, t0);
      master.connect(c.destination);

      const seq = [
        { f: 523.25, d: 0.10 },
        { f: 659.25, d: 0.10 },
        { f: 783.99, d: 0.34 },
      ];

      let cur = t0;
      for (const { f, d } of seq) {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = "sine";
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, cur);
        g.gain.exponentialRampToValueAtTime(0.30, cur + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, cur + d);
        o.connect(g); g.connect(master);
        o.start(cur); o.stop(cur + d + 0.02);
        cur += d;
      }

      log(`🔊 Chime (WebAudio) ${reason} @ ${t()} (vis=${vis()})`, "#00e5ff");
    } catch (e) {
      if (CONFIG.NET_DEBUG) dbg("WebAudio failed:", e?.message || e);
    }
  }

  // Unlock audio + request notification permission on first interaction
  const unlock = async () => {
    requestNotifyPermission();
    try { await primeAudioEl.play(); primeAudioEl.pause(); primeAudioEl.currentTime = 0; } catch {}
    try {
      const c = ensureCtx();
      if (c && c.state !== "running") await c.resume();
    } catch {}
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
    log("🔓 Audio/Notifications unlocked", "#b388ff");
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);

  /* =========================
   * TITLE
   * ========================= */
  let originalTitle = "";
  function updateTitleGenerating() {
    if (!originalTitle) originalTitle = document.title || "Gemini";
    if (!document.title.includes("⏳")) document.title = `⏳ Generating... | ${originalTitle}`;
  }
  function updateTitleDone() {
    if (!originalTitle) originalTitle = document.title || "Gemini";
    document.title = `✅ DONE! - ${originalTitle}`;
    setTimeout(() => { document.title = originalTitle; }, 5000);
  }

  /* =========================
   * SESSION FSM
   * ========================= */
  let sid = 0;
  let s = null;
  let pollId = 0;

  const STATE = { ARMED: "ARMED", STREAMING: "STREAMING", DONE: "DONE" };

  function startPoll() {
    if (pollId) return;
    pollId = setInterval(tick, CONFIG.POLL_MS);
    log(`⏱️ Polling started (${CONFIG.POLL_MS}ms)`, "#ffff00");
  }

  function stopPoll() {
    if (!pollId) return;
    clearInterval(pollId);
    pollId = 0;
    log("🛑 Polling stopped", "#ffff00");
  }

  function arm(reason) {
    s = {
      id: ++sid,
      state: STATE.ARMED,
      armedAt: performance.now(),
      sawStop: false,
      lastStopGoneAt: 0,
      net: {
        watching: false,
        startedAt: 0,
        url: "",
        bytes: 0,
        done: false,
      },
      done: false
    };
    log(`🛡️ ARMED s#${s.id} (${reason}) vis=${vis()}`, "#ffff00");
    startPoll();
    tick();
  }

  function transition(newState) {
    if (!s) return;
    if (s.state === newState) return;
    s.state = newState;
    log(`👉 State -> ${newState} s#${s.id} vis=${vis()}`, "#ffa500");
  }

  function complete(reason) {
    if (!s || s.done) return;
    s.done = true;
    transition(STATE.DONE);
    log(`✅ COMPLETION s#${s.id} via ${reason} vis=${vis()}`, "#00ff00");

    // Actions
    playChime(reason);
    sendNotification();
    updateTitleDone();

    // Cleanup
    s = null;
    stopPoll();
  }

  function tick() {
    if (!s) return;

    const stopNow = isStopVisible();

    if (CONFIG.HEARTBEAT_LOG) {
      console.log(
        `[Background Check ${t()}] s#${s.id} state=${s.state} stop=${stopNow} netWatching=${s.net.watching} netDone=${s.net.done} vis=${vis()}`
      );
    }

    // streaming detected via stop button
    if (s.state === STATE.ARMED && stopNow) {
      s.sawStop = true;
      transition(STATE.STREAMING);
      updateTitleGenerating();
    }

    // completion via UI stop gone
    if (s.state === STATE.STREAMING && !stopNow) {
      if (!s.lastStopGoneAt) {
        s.lastStopGoneAt = performance.now();
      } else {
        const diff = performance.now() - s.lastStopGoneAt;
        if (diff >= CONFIG.STOP_GONE_DEBOUNCE_MS) {
          complete(`UI(stop gone ${CONFIG.STOP_GONE_DEBOUNCE_MS}ms)`);
        }
      }
    } else {
      if (stopNow) s.lastStopGoneAt = 0;
    }
  }

  /* =========================
   * NETWORK COMPLETION HOOKS (PRIMARY)
   * ========================= */
  function urlLooksRelevant(url) {
    return CONFIG.NET_URL_HINTS.some((re) => re.test(url));
  }

  function canAttachToThisRequest(startMs) {
    if (!s) return false;
    const delta = startMs - s.armedAt;
    return delta >= -250 && delta <= CONFIG.NET_ATTACH_WINDOW_MS;
  }

  async function watchReadableStreamDone(stream, url, startedAt) {
    if (!s) return;

    s.net.watching = true;
    s.net.startedAt = startedAt;
    s.net.url = url;
    s.net.bytes = 0;
    s.net.done = false;

    log(`🧲 NET watch started s#${s.id} url=${url} vis=${vis()}`, "#b388ff");

    // Treat this as streaming started, even if Stop UI never updates in background
    if (s.state === STATE.ARMED) {
      transition(STATE.STREAMING);
      updateTitleGenerating();
    }

    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength) s.net.bytes += value.byteLength;
      }
      s.net.done = true;

      log(`🧲 NET stream closed s#${s.id} bytes=${s.net.bytes} url=${url} vis=${vis()}`, "#b388ff");
      complete("NET(stream closed)");
    } catch (e) {
      dbg("NET watch error:", e?.message || e);
      // Do not complete on error; UI fallback may still work
    }
  }

  function installFetchHook() {
    if (!CONFIG.NET_DETECT || !window.fetch) return;

    const origFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const startMs = performance.now();
      const req = args[0];
      const url = (req instanceof Request) ? req.url : String(req);

      // Fire actual request
      const res = await origFetch(...args);

      try {
        if (!s) return res;

        const relevant = urlLooksRelevant(url);
        const attachOK = canAttachToThisRequest(startMs);
        const hasBody = !!res.body;

        if (CONFIG.NET_DEBUG) {
          const ct = (res.headers?.get?.("content-type") || "");
          dbg("fetch:", { url, relevant, attachOK, hasBody, ct, vis: vis() });
        }

        if (!relevant || !attachOK || !hasBody || s.net.watching) return res;

        // tee stream so Gemini still receives it
        const [a, b] = res.body.tee();
        watchReadableStreamDone(b, url, startMs).catch((e) => dbg("watchReadableStreamDone failed:", e));

        return new Response(a, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers
        });
      } catch (e) {
        dbg("fetch hook error:", e?.message || e);
        return res;
      }
    };

    log("🧲 NET hook installed: fetch()", "#b388ff");
  }

  function installXHRHook() {
    if (!CONFIG.NET_DETECT || !window.XMLHttpRequest) return;

    const XHR = window.XMLHttpRequest;
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url, ...rest) {
      this.__gping_url = String(url || "");
      this.__gping_method = String(method || "GET");
      return origOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function (...sendArgs) {
      const startMs = performance.now();
      const url = this.__gping_url || "";

      try {
        if (s && !s.net.watching && urlLooksRelevant(url) && canAttachToThisRequest(startMs)) {
          log(`🧲 NET watch(XHR) armed s#${s.id} url=${url} vis=${vis()}`, "#b388ff");

          // Mark as streaming started
          if (s.state === STATE.ARMED) {
            transition(STATE.STREAMING);
            updateTitleGenerating();
          }

          s.net.watching = true;
          s.net.startedAt = startMs;
          s.net.url = url;
          s.net.bytes = 0;
          s.net.done = false;

          this.addEventListener("progress", () => {
            // responseText length proxy (not bytes), still helpful for debugging
            try { s && (s.net.bytes = Math.max(s.net.bytes, (this.responseText || "").length)); } catch {}
          });

          this.addEventListener("loadend", () => {
            if (!s) return;
            s.net.done = true;
            log(`🧲 NET loadend(XHR) s#${s.id} approxLen=${s.net.bytes} url=${url} vis=${vis()}`, "#b388ff");
            complete("NET(XHR loadend)");
          });
        } else if (CONFIG.NET_DEBUG) {
          dbg("xhr:", { url, relevant: urlLooksRelevant(url), attachOK: canAttachToThisRequest(startMs), watching: s?.net?.watching, vis: vis() });
        }
      } catch (e) {
        dbg("xhr hook error:", e?.message || e);
      }

      return origSend.apply(this, sendArgs);
    };

    log("🧲 NET hook installed: XMLHttpRequest", "#b388ff");
  }

  installFetchHook();
  installXHRHook();

  /* =========================
   * INPUT TRIGGERS
   * ========================= */
  document.addEventListener("click", (e) => {
    if (findSendBtn(e.target)) arm("Click Send");
  }, true);

  document.addEventListener("keydown", (e) => {
    const inComposer = e.target?.closest?.(SELECTORS.COMPOSER);
    if (!inComposer) return;
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      arm("Press Enter");
    }
  }, true);

  // If page is loaded mid-generation, arm a session so NET or UI can still complete it
  setTimeout(() => {
    if (isStopVisible()) {
      arm("PageLoad Detected Generation");
      transition(STATE.STREAMING);
      updateTitleGenerating();
    }
  }, 1200);

  log("--- v6.0 Ready (NET primary + UI fallback) ---", "#00ff00");
})();
