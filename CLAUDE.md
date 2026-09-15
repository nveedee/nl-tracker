# nl-tracker

Private tracker for Swiss National League 2026/27 (ELO, standings, player stats).

## Stack
- React 18 + Vite (client), Express (server), plain JS (no TypeScript).
- Client: `src/` — `src/pages/*.jsx` (routed pages), `src/components/*.jsx` (UI + charts), plain `.js` modules for logic (elo, stats, sim, playoff wheel geometry, scoreline matrix, market value, etc.).
- Server: `server/index.js` (Express entry), `server/sync.js`, `server/scripts/backtesting/`.
- Data lives under `server/data/`.

## Commands
- `npm run dev` — run client+server together (only start when actually needed to visually verify UI; don't start for logic-only changes).
- `npm run build` — Vite build; use as the smallest relevant verification for build-breaking changes.
- Tests are per-module, run only the one relevant to your change:
  - `npm run test:sim` (`src/playoffSim.test.js`)
  - `npm run test:wheel` (`src/wheelGeometry.test.js`)
  - `npm run test:scoreline` (`src/scorelineMatrix.test.js`)
  - `npm run test:backtest` (`server/scripts/backtesting/run.test.js`)
- No global test runner — don't run all four unless the change plausibly touches all of them.

## Working conventions (token discipline)
- Locate files with Grep/Glob before reading; don't read files already read this session.
- Edit only the files required for the task. No unrelated refactors/cleanup.
- No subagents for simple tasks. Only use one when it clearly keeps large/irrelevant output out of the main context (e.g. broad multi-file investigation).
- No full-project scans — target the specific `.jsx`/`.js` file(s) implicated by the task.
- After a change, run only the matching test script above (or `npm run build` for build-affecting changes) — not the full suite.
- Responses: concise. No summary/explanation unless asked. No preamble before tool calls beyond one short sentence.
- Don't add dependencies unless the task genuinely requires one.
- German UI/commit messages are the norm in this repo (see recent commit log) — match existing language per file when editing UI text.
