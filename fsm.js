/**
 * Gemini Completion Ping — extracted logic for testability.
 *
 * The script.js IIFE inlines this logic. This module exposes the same
 * state machine and pure functions so tests can exercise them without
 * a real browser.
 *
 * Usage: const fsm = createFSM({ isStopVisible, playChime, sendNotification, updateTitleGenerating, updateTitleDone });
 */

export const STATE = Object.freeze({
  ARMED: "ARMED",
  STREAMING: "STREAMING",
  DONE: "DONE",
});

export const DEFAULT_CONFIG = Object.freeze({
  POLL_MS: 750,
  NET_DETECT: true,
  NET_URL_HINTS: [
    /\/data\/batchexecute/i,
    /BardChatUi/i,
    /bard/i,
    /gemini/i,
    /assistant/i,
    /chat/i,
    /stream/i,
    /generate/i,
    /rpc/i,
  ],
  NET_ATTACH_WINDOW_MS: 10_000,
  STOP_GONE_DEBOUNCE_MS: 250,
});

/**
 * Check if a URL matches any of the configured hint patterns.
 */
export function urlLooksRelevant(url, hints = DEFAULT_CONFIG.NET_URL_HINTS) {
  return hints.some((re) => re.test(url));
}

/**
 * Check if a network request started within the attach window after arming.
 */
export function canAttachToRequest(startMs, armedAt, windowMs = DEFAULT_CONFIG.NET_ATTACH_WINDOW_MS) {
  const delta = startMs - armedAt;
  return delta >= -250 && delta <= windowMs;
}

/**
 * Generate a WAV data URL for the completion chime.
 * Pure function — deterministic output for a given sample rate.
 */
export function makeChimeWavDataURL() {
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
        i < 0.01 * sr
          ? i / (0.01 * sr)
          : i > len - 0.04 * sr
            ? Math.max(0, (len - i) / (0.04 * sr))
            : 1;

      const s1 = Math.sin(2 * Math.PI * f * x);
      const s2 = Math.sin(2 * Math.PI * (f * 1.003) * x) * 0.55;
      data[start + i] += amp * env * (0.72 * s1 + 0.28 * s2);
    }
    cursor += len + Math.floor(gap * sr);
  }

  const pcm = new DataView(new ArrayBuffer(44 + N * 2));
  let off = 0;
  const wStr = (s) => {
    for (let i = 0; i < s.length; i++) pcm.setUint8(off++, s.charCodeAt(i));
  };
  const w32 = (u) => {
    pcm.setUint32(off, u, true);
    off += 4;
  };
  const w16 = (u) => {
    pcm.setUint16(off, u, true);
    off += 2;
  };

  wStr("RIFF");
  w32(36 + N * 2);
  wStr("WAVE");
  wStr("fmt ");
  w32(16);
  w16(1);
  w16(1);
  w32(sr);
  w32(sr * 2);
  w16(2);
  w16(16);
  wStr("data");
  w32(N * 2);

  for (let i = 0; i < N; i++) {
    const v = Math.max(-1, Math.min(1, data[i]));
    pcm.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    off += 2;
  }

  const u8 = new Uint8Array(pcm.buffer);
  const b64 = btoa(String.fromCharCode(...u8));
  return `data:audio/wav;base64,${b64}`;
}

/**
 * Create a completion detection FSM.
 *
 * @param {Object} deps - Injectable dependencies
 * @param {() => boolean} deps.isStopVisible - Returns true when stop button is visible
 * @param {(reason: string) => void} deps.playChime - Called on completion
 * @param {() => void} deps.sendNotification - Called on completion
 * @param {() => void} deps.updateTitleGenerating - Called when streaming starts
 * @param {() => void} deps.updateTitleDone - Called on completion
 * @param {() => number} [deps.now] - Clock function (defaults to performance.now)
 * @param {Object} [config] - Configuration overrides
 */
export function createFSM(deps, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const _now = deps.now || (() => performance.now());

  let sid = 0;
  let s = null;
  let pollId = 0;

  function getState() {
    return s ? s.state : null;
  }

  function getSession() {
    return s ? { ...s } : null;
  }

  function transition(newState) {
    if (!s) return;
    if (s.state === newState) return;
    s.state = newState;
  }

  function complete(reason) {
    if (!s || s.done) return;
    s.done = true;
    transition(STATE.DONE);

    deps.playChime(reason);
    deps.sendNotification();
    deps.updateTitleDone();

    s = null;
    stopPoll();
  }

  function startPoll() {
    if (pollId) return;
    pollId = setInterval(tick, cfg.POLL_MS);
  }

  function stopPoll() {
    if (!pollId) return;
    clearInterval(pollId);
    pollId = 0;
  }

  function arm(_reason) {
    s = {
      id: ++sid,
      state: STATE.ARMED,
      armedAt: _now(),
      sawStop: false,
      lastStopGoneAt: 0,
      net: {
        watching: false,
        startedAt: 0,
        url: "",
        bytes: 0,
        done: false,
      },
      done: false,
    };
    startPoll();
    tick();
  }

  function tick() {
    if (!s) return;

    const stopNow = deps.isStopVisible();

    // streaming detected via stop button
    if (s.state === STATE.ARMED && stopNow) {
      s.sawStop = true;
      transition(STATE.STREAMING);
      deps.updateTitleGenerating();
    }

    // completion via UI stop gone
    if (s.state === STATE.STREAMING && !stopNow) {
      if (!s.lastStopGoneAt) {
        s.lastStopGoneAt = _now();
      } else {
        const diff = _now() - s.lastStopGoneAt;
        if (diff >= cfg.STOP_GONE_DEBOUNCE_MS) {
          complete(`UI(stop gone ${cfg.STOP_GONE_DEBOUNCE_MS}ms)`);
        }
      }
    } else {
      if (stopNow) s.lastStopGoneAt = 0;
    }
  }

  function netStreamStarted(url, startMs) {
    if (!s || s.net.watching) return false;
    if (!urlLooksRelevant(url, cfg.NET_URL_HINTS)) return false;
    if (!canAttachToRequest(startMs, s.armedAt, cfg.NET_ATTACH_WINDOW_MS)) return false;

    s.net.watching = true;
    s.net.startedAt = startMs;
    s.net.url = url;
    s.net.bytes = 0;
    s.net.done = false;

    if (s.state === STATE.ARMED) {
      transition(STATE.STREAMING);
      deps.updateTitleGenerating();
    }

    return true;
  }

  function netStreamDone(bytes) {
    if (!s) return;
    s.net.bytes = bytes || 0;
    s.net.done = true;
    complete("NET(stream closed)");
  }

  return {
    arm,
    tick,
    complete,
    getState,
    getSession,
    startPoll,
    stopPoll,
    netStreamStarted,
    netStreamDone,
  };
}
