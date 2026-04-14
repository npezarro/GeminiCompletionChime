import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  STATE,
  DEFAULT_CONFIG,
  urlLooksRelevant,
  canAttachToRequest,
  makeChimeWavDataURL,
  createFSM,
} from "./fsm.js";

/* ============================================================
 * urlLooksRelevant
 * ============================================================ */
describe("urlLooksRelevant", () => {
  it("matches batchexecute URLs", () => {
    expect(urlLooksRelevant("https://gemini.google.com/_/data/batchexecute?foo=1")).toBe(true);
  });

  it("matches BardChatUi URLs", () => {
    expect(urlLooksRelevant("https://gemini.google.com/u/0/BardChatUi")).toBe(true);
  });

  it("matches gemini URLs", () => {
    expect(urlLooksRelevant("https://api.gemini.google.com/generate")).toBe(true);
  });

  it("matches stream URLs", () => {
    expect(urlLooksRelevant("https://example.com/api/stream?id=123")).toBe(true);
  });

  it("matches rpc URLs", () => {
    expect(urlLooksRelevant("https://example.com/rpc/method")).toBe(true);
  });

  it("rejects unrelated URLs", () => {
    expect(urlLooksRelevant("https://fonts.googleapis.com/css?family=Roboto")).toBe(false);
  });

  it("rejects empty strings", () => {
    expect(urlLooksRelevant("")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(urlLooksRelevant("https://example.com/data/BATCHEXECUTE")).toBe(true);
    expect(urlLooksRelevant("https://example.com/GEMINI/query")).toBe(true);
  });

  it("works with custom hints", () => {
    expect(urlLooksRelevant("https://example.com/custom", [/custom/])).toBe(true);
    expect(urlLooksRelevant("https://example.com/other", [/custom/])).toBe(false);
  });
});

/* ============================================================
 * canAttachToRequest
 * ============================================================ */
describe("canAttachToRequest", () => {
  it("allows requests starting just after arm", () => {
    expect(canAttachToRequest(1000, 1000)).toBe(true);
  });

  it("allows requests within the default 10s window", () => {
    expect(canAttachToRequest(5000, 1000)).toBe(true);
  });

  it("allows requests up to 250ms before arm (race tolerance)", () => {
    expect(canAttachToRequest(750, 1000)).toBe(true);
  });

  it("rejects requests too far before arm", () => {
    expect(canAttachToRequest(500, 1000)).toBe(false);
  });

  it("rejects requests after the attach window", () => {
    expect(canAttachToRequest(12000, 1000, 10000)).toBe(false);
  });

  it("works with custom window", () => {
    expect(canAttachToRequest(3000, 1000, 1000)).toBe(false);
    expect(canAttachToRequest(1500, 1000, 1000)).toBe(true);
  });
});

/* ============================================================
 * makeChimeWavDataURL
 * ============================================================ */
describe("makeChimeWavDataURL", () => {
  it("returns a data URL with WAV MIME type", () => {
    const url = makeChimeWavDataURL();
    expect(url.startsWith("data:audio/wav;base64,")).toBe(true);
  });

  it("returns a valid base64 payload", () => {
    const url = makeChimeWavDataURL();
    const b64 = url.replace("data:audio/wav;base64,", "");
    expect(() => atob(b64)).not.toThrow();
  });

  it("contains RIFF header", () => {
    const url = makeChimeWavDataURL();
    const b64 = url.replace("data:audio/wav;base64,", "");
    const raw = atob(b64);
    expect(raw.substring(0, 4)).toBe("RIFF");
    expect(raw.substring(8, 12)).toBe("WAVE");
  });

  it("produces deterministic output", () => {
    expect(makeChimeWavDataURL()).toBe(makeChimeWavDataURL());
  });

  it("has correct PCM format header", () => {
    const url = makeChimeWavDataURL();
    const b64 = url.replace("data:audio/wav;base64,", "");
    const raw = atob(b64);
    // "fmt " chunk at byte 12
    expect(raw.substring(12, 16)).toBe("fmt ");
    // PCM format = 1 (little-endian at byte 20)
    expect(raw.charCodeAt(20)).toBe(1);
    expect(raw.charCodeAt(21)).toBe(0);
    // 1 channel (byte 22)
    expect(raw.charCodeAt(22)).toBe(1);
    expect(raw.charCodeAt(23)).toBe(0);
  });

  it("has correct sample rate (44100 Hz)", () => {
    const url = makeChimeWavDataURL();
    const b64 = url.replace("data:audio/wav;base64,", "");
    const raw = atob(b64);
    // Sample rate at byte 24, little-endian uint32
    const sr =
      raw.charCodeAt(24) |
      (raw.charCodeAt(25) << 8) |
      (raw.charCodeAt(26) << 16) |
      (raw.charCodeAt(27) << 24);
    expect(sr).toBe(44100);
  });
});

/* ============================================================
 * FSM — createFSM
 * ============================================================ */
describe("createFSM", () => {
  let deps;
  let clock;
  let fsm;

  beforeEach(() => {
    clock = 1000;
    deps = {
      isStopVisible: vi.fn(() => false),
      playChime: vi.fn(),
      sendNotification: vi.fn(),
      updateTitleGenerating: vi.fn(),
      updateTitleDone: vi.fn(),
      now: () => clock,
    };
    fsm = createFSM(deps, { POLL_MS: 100, STOP_GONE_DEBOUNCE_MS: 250 });
  });

  describe("initial state", () => {
    it("starts with null state (no session)", () => {
      expect(fsm.getState()).toBeNull();
    });

    it("has no session", () => {
      expect(fsm.getSession()).toBeNull();
    });
  });

  describe("arm", () => {
    it("transitions to ARMED", () => {
      fsm.arm("test");
      expect(fsm.getState()).toBe(STATE.ARMED);
    });

    it("creates a session with incrementing ID", () => {
      fsm.arm("first");
      const s1 = fsm.getSession();
      expect(s1.id).toBe(1);

      // Complete current session to allow re-arm
      deps.isStopVisible.mockReturnValue(true);
      fsm.tick();
      deps.isStopVisible.mockReturnValue(false);
      clock += 300;
      fsm.tick();

      fsm.arm("second");
      const s2 = fsm.getSession();
      expect(s2.id).toBe(2);
    });

    it("records armedAt timestamp", () => {
      clock = 5000;
      fsm.arm("test");
      expect(fsm.getSession().armedAt).toBe(5000);
    });
  });

  describe("ARMED → STREAMING", () => {
    it("transitions when stop button becomes visible", () => {
      fsm.arm("test");
      deps.isStopVisible.mockReturnValue(true);
      fsm.tick();
      expect(fsm.getState()).toBe(STATE.STREAMING);
    });

    it("calls updateTitleGenerating", () => {
      fsm.arm("test");
      deps.isStopVisible.mockReturnValue(true);
      fsm.tick();
      expect(deps.updateTitleGenerating).toHaveBeenCalledOnce();
    });

    it("stays ARMED when stop not visible", () => {
      fsm.arm("test");
      deps.isStopVisible.mockReturnValue(false);
      fsm.tick();
      expect(fsm.getState()).toBe(STATE.ARMED);
    });
  });

  describe("STREAMING → DONE (UI path)", () => {
    beforeEach(() => {
      fsm.arm("test");
      deps.isStopVisible.mockReturnValue(true);
      fsm.tick(); // → STREAMING
    });

    it("does not complete immediately when stop disappears", () => {
      deps.isStopVisible.mockReturnValue(false);
      fsm.tick();
      expect(fsm.getState()).toBe(STATE.STREAMING);
    });

    it("completes after debounce period", () => {
      deps.isStopVisible.mockReturnValue(false);
      fsm.tick(); // records lastStopGoneAt
      clock += 300;
      fsm.tick(); // exceeds 250ms debounce
      expect(fsm.getState()).toBeNull(); // session cleared
    });

    it("calls playChime and sendNotification on completion", () => {
      deps.isStopVisible.mockReturnValue(false);
      fsm.tick();
      clock += 300;
      fsm.tick();
      expect(deps.playChime).toHaveBeenCalledOnce();
      expect(deps.sendNotification).toHaveBeenCalledOnce();
      expect(deps.updateTitleDone).toHaveBeenCalledOnce();
    });

    it("resets debounce if stop reappears", () => {
      deps.isStopVisible.mockReturnValue(false);
      fsm.tick(); // records lastStopGoneAt
      clock += 100;

      // Stop reappears (flicker)
      deps.isStopVisible.mockReturnValue(true);
      fsm.tick();

      // Stop disappears again
      deps.isStopVisible.mockReturnValue(false);
      fsm.tick(); // new lastStopGoneAt
      clock += 100;
      fsm.tick(); // only 100ms since last gone, not enough
      expect(fsm.getState()).toBe(STATE.STREAMING);

      clock += 200;
      fsm.tick(); // now 300ms, exceeds debounce
      expect(fsm.getState()).toBeNull();
    });
  });

  describe("network completion path", () => {
    it("netStreamStarted transitions ARMED → STREAMING", () => {
      clock = 1000;
      fsm.arm("test");
      const attached = fsm.netStreamStarted("https://example.com/gemini/chat", 1100);
      expect(attached).toBe(true);
      expect(fsm.getState()).toBe(STATE.STREAMING);
      expect(deps.updateTitleGenerating).toHaveBeenCalledOnce();
    });

    it("netStreamDone completes the session", () => {
      clock = 1000;
      fsm.arm("test");
      fsm.netStreamStarted("https://example.com/gemini/chat", 1100);
      fsm.netStreamDone(5000);
      expect(fsm.getState()).toBeNull();
      expect(deps.playChime).toHaveBeenCalledWith("NET(stream closed)");
    });

    it("rejects irrelevant URLs", () => {
      clock = 1000;
      fsm.arm("test");
      const attached = fsm.netStreamStarted("https://fonts.googleapis.com/css", 1100);
      expect(attached).toBe(false);
      expect(fsm.getState()).toBe(STATE.ARMED);
    });

    it("rejects requests outside attach window", () => {
      clock = 1000;
      fsm.arm("test");
      const attached = fsm.netStreamStarted("https://example.com/gemini/chat", 20000);
      expect(attached).toBe(false);
    });

    it("rejects second net stream if already watching", () => {
      clock = 1000;
      fsm.arm("test");
      fsm.netStreamStarted("https://example.com/gemini/chat", 1100);
      const second = fsm.netStreamStarted("https://example.com/gemini/stream", 1200);
      expect(second).toBe(false);
    });

    it("does nothing if no session", () => {
      const attached = fsm.netStreamStarted("https://example.com/gemini/chat", 1000);
      expect(attached).toBe(false);
    });
  });

  describe("session management", () => {
    it("re-arm after completion creates fresh session", () => {
      fsm.arm("first");
      deps.isStopVisible.mockReturnValue(true);
      fsm.tick();
      deps.isStopVisible.mockReturnValue(false);
      clock += 300;
      fsm.tick(); // complete

      fsm.arm("second");
      expect(fsm.getState()).toBe(STATE.ARMED);
      expect(fsm.getSession().id).toBe(2);
    });

    it("complete is idempotent", () => {
      fsm.arm("test");
      deps.isStopVisible.mockReturnValue(true);
      fsm.tick();
      deps.isStopVisible.mockReturnValue(false);
      clock += 300;
      fsm.tick();

      // Manually call complete again — should be no-op
      fsm.complete("extra");
      expect(deps.playChime).toHaveBeenCalledOnce();
    });

    it("tick is no-op without session", () => {
      fsm.tick();
      expect(deps.isStopVisible).not.toHaveBeenCalled();
    });
  });

  describe("mixed UI + network", () => {
    it("network completion wins even when UI is still streaming", () => {
      clock = 1000;
      fsm.arm("test");
      deps.isStopVisible.mockReturnValue(true);
      fsm.tick(); // → STREAMING via UI

      fsm.netStreamStarted("https://example.com/gemini/chat", 1100);
      fsm.netStreamDone(3000);

      // Should be complete even though stop is still visible
      expect(fsm.getState()).toBeNull();
      expect(deps.playChime).toHaveBeenCalledOnce();
    });

    it("network transitions ARMED → STREAMING before UI sees stop", () => {
      clock = 1000;
      fsm.arm("test");
      deps.isStopVisible.mockReturnValue(false);

      fsm.netStreamStarted("https://example.com/gemini/chat", 1100);
      expect(fsm.getState()).toBe(STATE.STREAMING);
      expect(deps.updateTitleGenerating).toHaveBeenCalledOnce();
    });
  });
});

/* ============================================================
 * DEFAULT_CONFIG
 * ============================================================ */
describe("DEFAULT_CONFIG", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
  });

  it("has expected defaults", () => {
    expect(DEFAULT_CONFIG.POLL_MS).toBe(750);
    expect(DEFAULT_CONFIG.NET_ATTACH_WINDOW_MS).toBe(10_000);
    expect(DEFAULT_CONFIG.STOP_GONE_DEBOUNCE_MS).toBe(250);
    expect(DEFAULT_CONFIG.NET_DETECT).toBe(true);
    expect(DEFAULT_CONFIG.NET_URL_HINTS.length).toBeGreaterThan(0);
  });
});

/* ============================================================
 * STATE enum
 * ============================================================ */
describe("STATE", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(STATE)).toBe(true);
  });

  it("has three states", () => {
    expect(Object.keys(STATE)).toHaveLength(3);
    expect(STATE.ARMED).toBe("ARMED");
    expect(STATE.STREAMING).toBe("STREAMING");
    expect(STATE.DONE).toBe("DONE");
  });
});
