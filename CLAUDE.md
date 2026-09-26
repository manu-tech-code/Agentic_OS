This folder is for building an agentic OS, right, and should have everything that is on focussed on building this product.

## Project map (Nova)
- `packages/core` - DecisionEngine (System 1: Jev via Vercel AI Gateway, LLM-schema fallback, offline heuristic), NovaBrain orchestrator, skills, guardian (risk tiers), wire protocol.
- `apps/daemon` - local WebSocket service (127.0.0.1:7878), macOS app control, `jev:ping` latency spike.
- `apps/desktop` - React/Vite glass UI; `src-tauri/` is the native shell.
- `doc/` - design docs, always as PDF.
- Rules: never call Jev directly outside `DecisionEngine`; risk tier is declared in code, never inferred from untrusted content; arithmetic/dates/parsing stay in code.
- Verify with `npm test` and `npm run typecheck`.