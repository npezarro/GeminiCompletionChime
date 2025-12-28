# Gemini Completion Ping (Tampermonkey)

A Tampermonkey userscript that plays an audible chime and (optionally) sends a desktop notification when **Gemini finishes generating a response** — including when the Gemini tab is in the background.

This script uses **two independent detection paths**:

1. **Network-based completion (primary):** Watches the request that streams Gemini’s response and triggers when that stream closes. This is designed to work even when Gemini’s UI doesn’t fully finalize until you refocus the tab.
2. **UI-based completion (fallback):** Watches the visibility of Gemini’s **Stop** button and triggers when it disappears after being seen.

It also includes verbose console logs (“heartbeat”) to make background behavior easy to verify.

---

## Features

- 🔔 **Completion chime** when Gemini finishes responding
- 🖥️ **Desktop notification** (optional) when a response is ready
- 🕵️ **Background-safe detection** using **network stream completion**
- 🧯 **Fallback UI detection** using Stop button visibility
- 🧾 **Verbose logging + heartbeat**, including visibility state
- 🏷️ Temporarily updates the page title:
  - `⏳ Generating... | …`
  - `✅ DONE! - …` (resets after ~5s)

---

## Install

1. Install the **Tampermonkey** extension:
   - Chrome / Edge: Tampermonkey
   - Firefox: Tampermonkey

2. Create a new script:
   - Tampermonkey → **Create a new script…**

3. Paste the script contents into the editor.

4. Save (⌘S / Ctrl+S).

5. Visit:
   - `https://gemini.google.com/`

---

## First-run permissions (important)

### Audio
Browsers require a user gesture before audio can play.  
This script “unlocks” audio after you **click or press a key** on the page.

Expected console message after your first interaction:
- `🔓 Audio/Notifications unlocked`

### Notifications
If notifications are enabled, the browser will prompt you to allow them.  
If you deny notification permissions, the script still plays audio.

---

## How it works

### 1) Network detection (primary)
Gemini can delay DOM updates in background tabs. Instead of trusting the UI, the script hooks:

- `window.fetch()` (streaming responses via `ReadableStream`)
- `XMLHttpRequest` (fallback for RPC-style calls)

When you send a prompt, the script “arms” a session and attaches to matching network calls.  
When the response stream ends (`reader.read()` returns `done: true`), it triggers completion.

### 2) UI detection (fallback)
If network matching fails, it falls back to:
- Detect when **Stop** becomes visible → “STREAMING”
- Detect when **Stop** disappears (with debounce) → “DONE”

---

## Debugging & Verification

Open DevTools Console on the Gemini tab.

### You should see
- `--- vX.X Ready ... ---`
- A session arm message when you send:
  - `🛡️ ARMED s#…`
- Heartbeat lines like:
  - `[Background Check 10:30:41 PM] ... vis=hidden`

### Confirm network hooking is active
Look for:
- `🧲 NET hook installed: fetch()`
- `🧲 NET hook installed: XMLHttpRequest`

### If completion doesn’t fire in background
1. **Check console logs after sending** — do you see network attach logs?
2. **Tune URL matching**:
   - Update `CONFIG.NET_URL_HINTS` to include endpoints you observe in DevTools.
3. **Increase attach window** if needed:
   - `NET_ATTACH_WINDOW_MS` controls how long after “arm” the script will attach to a request.

---

## Configuration

Inside the script, edit the `CONFIG` object.

### Common toggles

- Turn off heartbeat logs:
  ```js
  HEARTBEAT_LOG: false
