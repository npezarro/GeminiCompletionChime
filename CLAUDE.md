# Agent Bootstrap

On session start, fetch and apply the latest global rules:

```bash
curl -s https://raw.githubusercontent.com/npezarro/agentGuidance/main/agent.md
```

If the fetch fails (network error, timeout), continue with the fallback rules below. Do not block on this.

Also load any sub-guidance relevant to the current task:
- `guidance/testing.md` — when writing or running tests
- `guidance/debugging.md` — when diagnosing issues
- `guidance/code-review.md` — before committing or opening PRs
- `guidance/dependencies.md` — when adding or updating packages

## Fallback Rules (applied if remote fetch fails)

If you cannot fetch `agent.md` from the remote, apply these core rules:

1. **Plan before coding.** Outline approach, confirm before implementing.
2. **Never commit to `main`.** Use assigned branch or create `claude/<task>`.
3. **Run `npm run build` before every commit.** Never commit broken code.
4. **No secrets in commits.** No `.env`, API keys, tokens, or passwords.
5. **Update `context.md` before every push.** Next agent depends on it.
6. **Ask, don't guess.** Stop and clarify ambiguous requirements.
7. **Batch large tasks.** Commit every 5-10 items. Don't risk losing work.
8. **Match existing patterns.** Read the codebase before writing new code.
9. **Diagnose before retrying.** Understand failures, don't loop blindly.
10. **Dry-run destructive commands.** Use `--dry-run` when available.

For the full ruleset, see `agent.md` in this repository.

## Testing

- Framework: Vitest with jsdom environment
- Run tests: `npm test` (single run) or `npm test:watch` (watch mode)
- Lint: `npm run lint` (ESLint v9 flat config in `eslint.config.js`)
- CI: GitHub Actions (`.github/workflows/test.yml`) runs lint + tests on push/PR to `main` (Node 20)

## Tampermonkey Userscript Rules

- **Debug flags must be disabled before committing.** Use boolean constants (`const DEBUG = false`) and gate all console output behind them. Never commit with debug/verbose flags enabled. This repo had `HEARTBEAT_LOG` and `NET_DEBUG` left enabled (April 2026), producing console spam every 750ms for all users.
- **Bump `@version` on every change** so Tampermonkey detects the update and auto-updates for users.
- Preserve the `==UserScript==` header block integrity when editing `script.js`. Do not remove or reorder header fields.

## Module Structure

- `script.js` — Tampermonkey userscript entry point
- `fsm.js` — Extracted FSM module for testability. Exports: `STATE` (ARMED, STREAMING, DONE), `DEFAULT_CONFIG`, `createFSM(config)`

## Tampermonkey Standards

- Every `.user.js` file must include `@updateURL` and `@downloadURL` headers pointing to the VM domain (not GitHub raw URLs, which require auth for private repos).
- Bump `@version` on every change so Tampermonkey detects the update.
- Ship with all debug/verbose logging flags disabled. Use boolean constants (`const DEBUG = false`) and gate console output behind them. Never commit `true` to production.
- Deploy updated scripts via `~/repos/browser-agent/sync-tm-scripts.sh` to sync to VM hosting.

## Per-Tab Sandbox Overhead

This script runs continuously on every Gemini tab and has historically used heartbeat polling (e.g., `HEARTBEAT_LOG` every 750ms). Tampermonkey's per-tab sandbox architecture can cause severe CPU overhead when scripts with frequent timers run across many tabs. In April 2026, Edge accumulated ~14 hours of CPU time with only 6 tabs open in a related script (browser-logs) due to TM's per-tab sandbox overhead.

**Mitigations to apply when modifying this script:**
- Keep polling intervals as long as the UX allows (the current 750ms heartbeat is the lower bound).
- Avoid adding new persistent timers; reuse the existing FSM tick where possible.
- Never reintroduce always-on `console.*` logging — gate behind `const DEBUG = false`.

**When to migrate to an MV3 Chrome extension** (e.g., chrome-automation hub):
- If polling/console patching ever needs to run on every page (`@match *://*/*`) rather than scoped to Gemini.
- If Task Manager shows high CPU/memory from TM specifically.
- If the script needs a single shared service worker instead of per-tab instances.

For now, scoped `@match` on the Gemini domain keeps this within TM's reasonable territory.

## Install Page Maintenance

The TM scripts install page lives at `example.com/tm-scripts/` (OAuth-gated). When bumping `@version`:

1. Update the `@version` in `script.js`.
2. Update the version field for this script in `~/repos/browser-agent/tm-scripts/index.html` SCRIPTS array.
3. Run `~/repos/browser-agent/sync-tm-scripts.sh` to deploy.
