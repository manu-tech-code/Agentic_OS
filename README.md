# Nova

A voice-first, model-agnostic agentic OS layer. You talk; it acts.

- **System 1 - fast decisions.** Every utterance gets one typed decision call (intent, target app, "was that meant for me?") through a swappable `DecisionEngine`. Default: **Jev** via Vercel AI Gateway. Fallbacks: any LLM with a schema, or an offline heuristic.
- **System 2 - reasoning.** Open questions go to any model you plug in (Claude, GPT, Gemini, local).
- **Glass UI.** macOS-inspired shell: the Orb, Live Pill, frosted cards, magnifying dock, Decision Inspector.

Design docs and decisions are in `doc/` as PDFs.

## Layout

```
packages/core     brain: DecisionEngine (Jev / LLM / heuristic), NovaBrain orchestrator, skills, guardian, protocol
apps/daemon       local service: WebSocket API on 127.0.0.1:7878, macOS app control, jev:ping latency spike
apps/desktop      React + Vite glass UI (runs in a browser or inside the Tauri 2 shell in src-tauri/)
```

One core, many shells: the desktop app, a web app and future IDE extensions are all thin clients of the daemon.

## Run it

Requires Node 22+. Tauri also needs Rust (`curl https://sh.rustup.rs -sSf | sh`).

```bash
npm install
cp .env.example .env          # optional - runs offline without keys
npm run dev                   # daemon + UI
```

Open **http://localhost:5173 in Chrome** (voice recognition uses the Web Speech API), tap **Wake Nova**, allow the mic, then say:

- "Hey Nova, open Slack"
- "Nova, what time is it?"
- "Nova, set a timer for 5 minutes"
- "Nova, quit Spotify" → "yes"  (tier-2 action: spoken confirmation)
- "Hey Nova" … pause … "open Figma"  (follow-up window, no wake word needed)

Press **⌘K** to type instead, **⌘I** for the Decision Inspector, **⌘J** for Activity, **Esc** to stop.
`http://localhost:5173/#demo` plays a scripted session with no daemon, for design work.

Native window: `npm run dev:tauri` (run `npm run dev:daemon` alongside it). Voice recognition inside
the macOS WebView is not guaranteed yet - if it's unavailable the UI says so; use Chrome for now.

## Turning on Jev (no waitlist needed)

1. Vercel dashboard → AI Gateway → create an API key.
2. Put it in `.env` as `AI_GATEWAY_API_KEY=...`
3. `npm run jev:ping` - measures real Jev latency from your location (do this first).
4. Restart `npm run dev`. The menu bar shows `System 1: jev`.

If Jev errors or exceeds `NOVA_DECISION_TIMEOUT_MS`, Nova falls back automatically (`NOVA_DECISION_FALLBACK`).
Set `NOVA_BRAIN_MODEL` (e.g. `anthropic/claude-sonnet-5`) for open questions. When the TypeSafe waitlist
clears, a direct TypeSafe engine is one more `EngineSlot`.

## Tests

```bash
npm test          # core: wake word, skills, confirmation flow, Jev thresholds (mocked), fallback
npm run typecheck
```

## Adding a skill

Add an entry to `packages/core/src/skills/builtin.ts`: an `id`, example phrasings (they become Jev's
choice criteria), a risk `tier` (0 just do it · 1 announce · 2 spoken confirm · 3 on-screen tap only),
and `run()`. Keep arithmetic, dates and parsing in code - the decision model only makes judgments.
