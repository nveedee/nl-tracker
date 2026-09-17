# NL Tracker – Feature Overview

NL Tracker is a private, single-team analytics application for the Swiss National League ice hockey season 2026/27. It automatically synchronizes game results, standings, and player data from two public sources (nationalleague.ch and SIHF), then derives an in-house ELO rating, a multi-factor Power Ranking, a calibrated Monte-Carlo season/playoff simulation (including a full 14-team playoff bracket), and a large set of analytics pages (standings, player/goalie rankings, head-to-head, market value trends, match previews, and model-performance/backtesting tools). The stack is React 18 + Vite on the frontend and a small Express server persisting everything to a single JSON file (`server/data/db.json`); there is no authentication and the app is designed to run as a single local/private instance.

All statements below were verified against the actual source in this repository (paths given for every feature). Where the shipped `README.md` describes something no longer true (e.g. manual game entry), this is called out explicitly in "Known Gaps".

## Feature Status

| Feature | Status |
|---|---|
| Standings (Tabelle) with official NL tiebreakers | ✅ Implemented |
| Custom ELO rating engine (dynamic K, OT/SO weighting, goal-diff, home advantage) | ✅ Implemented |
| Pre-season ELO carry-over from historical archive | ✅ Implemented |
| Market-value-based ELO start prior | ✅ Implemented |
| Power Ranking (4-component blended score incl. shots-allowed adjustment) | ✅ Implemented |
| Monte-Carlo season projection (10k runs) incl. full playoff bracket, play-in, play-out, ligaqualification | ✅ Implemented |
| Playoff Probability Wheel (radial visualization) | ✅ Implemented |
| Postseason Paths / Most Likely Matchups (opponent/path/bracket analytics from the same 10k-run simulation) | ✅ Implemented |
| Bracket probability cards (champion/top6/playoffs/play-in/play-out/ligaqual) | ✅ Implemented |
| Position/Rank distribution matrix | ✅ Implemented |
| What-If simulator (fix outcomes of open games) | ✅ Implemented |
| Lock Final Standings (condition on rank/bracket outcome, no re-simulation) | ✅ Implemented |
| Points Targets ("X points = safe") | ✅ Implemented |
| Swing Analysis ("what's at stake" per game) | ✅ Implemented |
| Season Evolution chart (daily baseline history) | ✅ Implemented |
| Match Forecast list (closed-form win probabilities for upcoming games) | ✅ Implemented |
| Match Detail page (scoreline matrix, expected goals, goal probabilities, H2H) | ✅ Implemented |
| Scoreline probability matrix + goal distributions + Expected Goals | ✅ Implemented |
| Head-to-Head page (current season + historical archive) | ✅ Implemented |
| Player rankings incl. trend/breakout classification, impact score, market movers | ✅ Implemented |
| Player detail page (career history, rolling form, home/away split, opponent breakdown, team stints) | ✅ Implemented |
| Goalie rankings | ✅ Implemented |
| Team detail page (roster, form, home/away splits, schedule strength, roster/depth analytics) | ✅ Implemented |
| Player Impact Score (position-relative composite z-score) | ✅ Implemented |
| Market value tracking + history + league movers | ✅ Implemented |
| Rest-days / back-to-back adjustment for single-game forecasts | ✅ Implemented |
| Prediction snapshot freezing + Model Performance evaluation page | ✅ Implemented |
| Historical walk-forward Backtesting page/tooling | ✅ Implemented |
| NL-API sync (games, standings, players, market values) — automatic + manual | ✅ Implemented |
| SIHF sync (live boxscores, player stats, final results) — automatic + manual | ✅ Implemented |
| Settings page (season/ELO params, prediction toggles, backup/import/reset) | ✅ Implemented |
| JSON export/import & reset (backup) | ✅ Implemented |
| Team & player CRUD (manual roster management) | ✅ Implemented |
| Manual game entry/editing | ❌ Not implemented (explicitly removed, see `server/index.js` comment; README still describes it) |
| Notifications (push/email/etc.) | ❌ Not implemented |
| Authentication / multi-user support | ❌ Not implemented |
| Mobile-specific native app | ❌ Not implemented (responsive web only) |
| Automated tests covering UI/pages/components | ❌ Not implemented (only 4 pure-logic `node --test` suites exist) |

## Frontend Pages

Routing is defined in `src/App.jsx` (React Router `Routes`/`Route`), with a single-row primary nav and a "Verwalten" (manage) dropdown for secondary pages. `App.jsx` also renders a global `SyncStatus` widget in the header and a `ToastHost`.

1. **Dashboard** (`/`, `src/pages/Dashboard.jsx`) — Landing page: top scorers (top 5 by points), recent results or upcoming games (falls back to upcoming if no games played yet), scheduled-game counter, and the `PlayoffWheel` fed from the shared live/baseline simulation store (`src/simResultsContext.jsx`). Limitation: does not run its own simulation (would block initial load), so it shows stale data until a projection has been run at least once (baseline) or PlayoffOdds has run one this session.
2. **Standings/Tabelle** (`/standings`, `src/pages/Standings.jsx`) — Classic league table via `computeStandings()`, with visual zone breaks after rank 6 (direct top 6) and rank 10 (end of play-in), derived from `PLAYOFF_FORMAT`.
3. **ELO Ranking** (`/elo`, `src/pages/EloRanking.jsx`) — Current ELO ranking and rating history chart; shows whether the market-value prior is active.
4. **Power Ranking** (`/power`, `src/pages/PowerRankings.jsx`) — Renders `computePowerRankings()` output with per-component bars (strength/offense/defense/form).
5. **Playoff Odds / Season Projections** (`/playoff-odds`, `src/pages/PlayoffOdds.jsx`) — Full season-projection UI: run-count selector (1000/2500/5000/10000), tabs for Matrix/Brackets/What-if/Swing/Locks/Targets/Verlauf (progressive disclosure on mobile). Route path stays `/playoff-odds` for historical reasons even though the page now covers full season projections, not just playoff odds.
6. **Goalies/Torhüter** (`/goalies`, `src/pages/Goalies.jsx`) — Sortable/filterable (by team) goalie stat table sourced from `computePlayerStats()`.
7. **Head-to-Head** (`/head-to-head`, `src/pages/HeadToHead.jsx`) — Pairwise team comparison: full record, home/away splits, recent form, shots-allowed, and a lazy-loaded historical archive (`public/historical-h2h.json`).
8. **Model Performance** (`/model-performance`, `src/pages/ModelPerformance.jsx`) — Evaluates real, frozen prediction snapshots (`db.predictions`) against actual results: accuracy, Brier score, log loss, calibration bins/ECE, checkpoints, rolling series, segments, biggest misses, drift, plus a static historical backtest reference block.
9. **Backtesting** (`/backtesting`, `src/pages/Backtesting.jsx`) — Displays the static walk-forward backtest export `public/backtest-results.json` (model version comparison, calibration, bootstrap significance). Purely a viewer — no computation happens client-side.
10. **Spieler/Player Rankings** (`/players`, `src/pages/PlayerRankings.jsx`) — Skater/Goalie toggle, team filter, name search (accent-insensitive), min-GP filter, player compare modal, trend/breakout badges, market movers panel.
11. **Games/Alle Spiele** (`/games`, `src/pages/Games.jsx`) — List of all completed games.
12. **Schedule/Spielplan** (`/schedule`, `src/pages/Schedule.jsx`) — Upcoming games with closed-form win probability per game (ELO + home advantage + rest-day adjustment), links into Match Detail.
13. **Matchup Detail** (`/matchup/:gameId`, `src/pages/MatchupDetail.jsx`) — Full pre-game analytics for one game: ELO/Power comparison, Monte-Carlo scoreline matrix, expected goals, goal probabilities by team, H2H, home/away splits.
14. **Teams & Kader** (`/teams`, `src/pages/Teams.jsx`) — Team list with roster-size chips, links to Team Detail.
15. **Team Detail** (`/teams/:id`, `src/pages/TeamDetail.jsx`) — Roster CRUD, team form, home/away splits, multi-season history, schedule strength, roster/depth analytics (Player Impact Score aggregation).
16. **Player Detail** (`/players/:id`, `src/pages/PlayerDetail.jsx`) — Career summary, YoY development, trend classification, Impact Score + history, rolling form, home/away split, opponent breakdown, team-stint breakdown, market value trend.
17b. **Postseason Paths** (`/postseason`, `src/pages/Postseason.jsx`) — Selbständiger 10k-Lauf von `simulateSeasonProjections({ trackPaths: true })` (identische Simulation wie Season Projections, keine zweite Engine); aggregiert einmalig über `aggregatePostseasonPaths()` (`src/postseasonPaths.js`) zu Most-Likely-Opponents (Play-in/QF/SF/Final, absolute + conditional %), Most-Likely-Complete-Path je Team (nur tatsächlich beobachtete Pfade, nicht kombiniert), globalen Most-Likely-Matchups je Runde inkl. Play-out, Serienlängen-Verteilung, Play-in-Analytics (1./2. Chance) und einer "Most Likely Bracket"-Ansicht. UI rechnet ausschliesslich auf dem einmal aggregierten Ergebnis, kein Re-Simulieren pro Interaktion.
18. **Settings/Einstellungen** (`/settings`, `src/pages/Settings.jsx`) — Season name/ELO params, prediction-model toggles (market-value prior, rest-days), NL-API sync card, JSON export/import, reset (all or games-only).

## Components / Visualizations

All in `src/components/`.

- **PlayoffWheel** (`PlayoffWheel.jsx` + `src/wheelGeometry.js`) — Radial "MoneyPuck-style" wheel: sector angle proportional to each team's playoff probability (normalized to 360°, minimum 10° per team so 0%-teams stay visible/clickable), four concentric probability rings (QF/SF/Final/Champion) per team. Pure geometry logic is unit-tested in `src/wheelGeometry.test.js`.
- **BracketCards** (`BracketCards.jsx`) — Ranked cards per bracket outcome (champion, direct top 6, playoffs, play-in, play-out 13/14, ligaqualification) with delta vs. the daily baseline.
- **PositionMatrix** (`PositionMatrix.jsx`) — Heatmap of P(final rank) per team, reading a 7-stop CSS heat ramp from `styles.css` so it follows light/dark mode automatically.
- **ScorelineMatrix** (`ScorelineMatrix.jsx` + `src/scorelineMatrix.js`) — Home/away goal scoreline probability heatmap (buckets 0–4, "5+"), built from raw simulated single-game results; unit-tested (`scorelineMatrix.test.js`).
- **ExpectedGoals** (`ExpectedGoals.jsx`) — Simple average simulated-goals display per team (hockey-style xG = mean simulated goals, not shot-quality xG).
- **GoalProbabilities** (`GoalProbabilities.jsx`) — Per-team goal-count probability bars (0–6+, hockey-typical wider bucket range than the scoreline matrix).
- **MatchForecast** (`MatchForecast.jsx`) — List of upcoming games with home/away win % and P(decided in OT/SO), links to Match Detail.
- **WhatIfSimulator** (`WhatIfSimulator.jsx`) — Lets a user fix outcomes (Home reg./OT, Away OT/reg.) for individual open games and re-runs `simulateSeasonProjections()` with those overrides; shows delta vs. the unconditional projection.
- **SwingAnalysis** (`SwingAnalysis.jsx`) — For a chosen matchday, computes per-game "max swing" and "expected swing" in bracket probabilities using common-random-numbers scenario simulation (`computeSwingAnalysisForMatchday`).
- **LockStandings** (`LockStandings.jsx`) — Lets the user pin teams to a final rank or bracket outcome and filters already-simulated Monte-Carlo runs (no re-simulation) to the matching subset.
- **PointsTargets** (`PointsTargets.jsx`) — "X points = safe" table: smallest point total at which a team reaches Top-6/Playoffs/avoid-play-out with 50/75/90/99% confidence, from the raw per-run point distribution.
- **SeasonEvolution** (`SeasonEvolution.jsx`) — Line chart of probability metrics over the stored daily baseline history (`src/baselineStore.js`), one line per (selectable) team.
- **SyncStatus** (`SyncStatus.jsx`) — Compact header widget showing last SIHF sync time + manual "Jetzt aktualisieren" button.

## Backend / API (`server/index.js`)

Express app persisting to `server/data/db.json` (auto-created from `server/data/seed.json` on first run if missing).

| Method & Path | Purpose |
|---|---|
| `GET /api/data` | Returns the entire DB (settings, teams, players, games; predictions live in the same file but aren't part of `emptyDb()`). |
| `PUT /api/settings` | Merge-patch settings. |
| `POST /api/teams`, `PUT /api/teams/:id`, `DELETE /api/teams/:id` | Generic CRUD via `crud()` helper; deleting a team cascades to its players and games. |
| `POST /api/players`, `PUT /api/players/:id`, `DELETE /api/players/:id` | Same CRUD helper; deleting a player also strips its `playerStats` entries from all games. |
| `GET /api/sync-status` / `POST /api/sync` | SIHF sync status / manual trigger (409 if already running); wraps `server/scripts/sync-sihf.cjs`. |
| `GET /api/sync-nl-status` / `POST /api/sync-nl` | NL-API sync status / manual trigger (409 if already running); wraps `server/sync.js`. |
| `GET /api/export` | Downloads the full DB as `nl-backup.json`. |
| `POST /api/import` | Replaces the DB with an uploaded backup (validates `teams` is an array; otherwise merges over a fresh `emptyDb()`). |
| `POST /api/reset` | `{ keepTeams: true }` clears only games; otherwise restores `seed.json` (or an empty DB) entirely. |
| `GET *` (non-`/api`) | SPA fallback serving `dist/index.html`, only registered if `dist/` exists (production/`npm run serve` mode). |

Note: there is intentionally **no** `crud('games', ...)` — manual game creation/editing/deletion was removed; games are populated exclusively by the two sync jobs (comment in `server/index.js` lines 137–139 explicitly documents this).

Server startup (`app.listen` callback) also kicks off both automatic sync loops (see below) and prints where the DB lives.

## Data & Storage

- **`server/data/db.json`** — single source of truth. Top-level keys per `emptyDb()` in `server/index.js`: `settings`, `teams` (14, from `seed.json`), `players`, `games`, `predictions` (populated by `server/scripts/predictions.js`). Verified live: 14 teams, 409 players, 364 games in the current file (the live file's top-level keys were `settings`/`teams`/`players`/`games` only — no predictions yet recorded at inspection time).
  - `settings`: `seasonName`, `eloStart`, `eloK`, `eloHomeAdvantage`, `marketValuePriorEnabled`, `priorSpread`, `restDaysEnabled`, `backToBackPenalty`.
  - `teams[]`: `id`, `name`, `short`, `color`, plus sync-added `externalId` (NL-API team id) and `apiStanding` (rank/gp/wins/points/goals/streak snapshot).
  - `players[]`: manual fields (`name`, `position`, `teamId`, `number`, plus optional `positionDetail`, `shoots`, `nationality`, `heightCm`, `weightKg`, `birthdate`, `injury*`) never touched by sync, plus sync-added `externalId`, `apiStats`, `marketValue`, `marketValueTrend`, `marketValueHistory[]` ({date, marketValue}, capped at 200 entries, deduped per day).
  - `games[]`: `id`, `date`, `time`, `homeTeamId`, `awayTeamId`, `status` (`scheduled`/`final`), `homeGoals`, `awayGoals`, `decision` (`REG`/`OT`/`SO`), `playerStats[]`, plus sync-added `externalId` (NL-API), `sihfGameId`, `sihfPeriods`, `sihfShots`, `sihfTeamStats`.
  - `predictions[]` (`server/scripts/predictions.js`): immutable pre-game snapshots — `gameId`, `seed`, probabilities, expected goals, OT/SO probabilities, ELO/Power values at snapshot time, `modelVersion` string.
- **`server/data/seed.json`** — the 14 NL teams template used to (re)initialize the DB.
- **`server/data/nl-sync-status.json`**, **`server/data/sihf-sync-status.json`** — last-run status for each sync job.
- **`public/*.json`** (static, generated offline by `server/scripts/generate-*.js`, fetched lazily by the frontend, never regenerated at runtime): `preseason-elo.json` (season-end ELO of the last historical season), `team-history.json`, `player-history.json`, `historical-h2h.json`, `backtest-results.json`.

## Algorithms (ELO / Stats / Simulation)

- **ELO** (`src/elo.js`) — Custom ELO with: home advantage (+65 default), differentiated result weights for regulation/OT/SO wins & losses, non-linear (log) goal-diff multiplier, dynamic K-factor tiered by games played, optional season-end regression-to-mean (currently a no-op since games carry no `season` field), and an optional form-decay modifier (disabled by default, `formDecayFactor: 0`). Parameters are stated as calibrated via `server/scripts/backtest-elo.js` over NL seasons 2017/18–2025/26 (Corona seasons excluded).
- **Pre-season ELO carry-over** (`src/preseasonElo.js`) — Regresses the prior season's final ELO 25% toward the configured start value and uses it as each team's initial rating, loaded from the static `public/preseason-elo.json`.
- **Market-value ELO prior** (`src/marketValuePrior.js`) — Alternative initial-rating source: linearly scales each team's summed roster market value (from the NL-API sync) into a ±`priorSpread` ELO offset around `eloStart`. Takes priority over the historical pre-season prior when enabled and data is present (`DataContext.jsx`).
- **Standings** (`src/stats.js::computeStandings`) — NL point system (3/2/1/0) with the official tiebreak order: points → wins (incl. OT/SO) → head-to-head points → goal difference → goals for (`compareTiebreak`).
- **Player/goalie stats** (`src/stats.js::computePlayerStats`) — Prefers `player.apiStats` (NL-API season totals) per player, falling back to boxscore aggregation from `games[].playerStats[]`; SOG/TOI and goalie win/loss/shutout always come from the boxscore aggregation since the API doesn't provide them.
- **Power Ranking** (`src/powerRankings.js`) — Weighted blend: Strength 40% (ELO 50% + PPG 35% + win% 15%, ELO adjusted by a backtest-validated "shots-allowed" z-score factor), Offense 25% (GPG 60% + relative offense 40%), Defense 25% (GAG 60% + relative defense 40%, inverted), Form 10% (last-5/last-10 weighted). All components min-max normalized to 0–100.
- **Monte-Carlo season projection** (`src/playoffSim.js`) — 10,000-run (configurable) simulation using a seeded Mulberry32 PRNG for full reproducibility: Poisson-distributed regulation goals calibrated to historical league home/away GPG, calibrated OT-vs-SO share among ties, a full playoff bracket simulation (play-in two-leg ties + sudden death, best-of-7 QF/SF/Final with reseeding and a 2-2-1-1-1 home pattern, best-of-7 play-out for ranks 13/14, and ligaqualification tracking). Includes derived tools: `filterLockedRuns` (post-hoc conditioning without re-simulating), `computePointsTargets`, `computeSwingForGame`/`computeSwingAnalysisForMatchday` (common-random-number scenario analysis), and closed-form `computeMatchForecasts`/`computeDecisionProbability` for single-game win probabilities without simulation. Fully unit-tested (`src/playoffSim.test.js`).
- **Scoreline/goal-distribution/xG** (`src/scorelineMatrix.js`) — Pure aggregation over raw simulated `{homeGoals, awayGoals}` results (no own randomness): scoreline probability matrix (0–4, "5+"), per-team goal distribution (0–6+), and Expected Goals as the mean simulated goals per side. Unit-tested (`src/scorelineMatrix.test.js`).
- **Rest-days/back-to-back adjustment** (`src/restDays.js`) — Shifts a single game's home-win probability by a configurable penalty only when exactly one side played the day before; used only for individual-game forecasts (Schedule, Matchup Detail, prediction snapshots), never inside the season simulation.
- **Player Impact Score** (`src/playerHistory.js`) — Position-relative (forwards vs. defensemen) composite z-score over P/GP, TOI/GP, +/-/GP, SOG/GP, each z-normalized against a league-wide baseline built from `public/player-history.json`, averaged and mapped through the normal CDF to a 0–100 percentile. Selected after comparing 4 variants for year-to-year stability and positional fairness (documented in comments, validated in `server/scripts/analyze-player-impact-score.js`).
- **Trend classification / breakout / declining** (`src/playerHistory.js::classifyTrend`) — Ratio of latest-season PPG to career PPG excluding that season, thresholded (≥1.30 strong-up, ≥1.10 up, ≤0.80 down), requiring ≥3 played seasons and ≥10 GP in the latest one.
- **Prediction Metrics** (`src/predictionMetrics.js`) — Accuracy, Brier score, log loss, MAE, calibration (favorite-folded 7 buckets and raw 10 bins with ECE), rolling/cumulative series, checkpoints, segment analysis (home/away favorite, close/light/clear/very-clear favorites), per-team home/away stats, biggest misses (by log-loss penalty), and first-vs-last-window drift.

## Synchronization / External Integrations

Two independent, additive sync jobs, both auto-started from `server/index.js` on boot and re-triggerable manually from the UI.

1. **NL-API Sync** (`server/sync.js`, endpoints `/api/sync-nl-status`, `/api/sync-nl`) — Fetches `GET https://www.nationalleague.ch/api/games|teams|player?lang=de-CH`. Fetches all three endpoints first; only mutates/writes `db.json` if all three succeed and team-mapping is fully unambiguous (throws otherwise — "nothing is guessed"). Populates team standings snapshot (`apiStanding`), player season totals + market value (+ history snapshots, deduped per Zurich calendar day, capped at 200 entries), and games (skips exhibition/non-NL games; a game already `final` is never reverted to `scheduled`). Runs once immediately at server start, then every 30 min by default (`NL_SYNC_INTERVAL_MIN`, disable via `NL_AUTO_SYNC=0`).
2. **SIHF Sync** (`server/scripts/sync-sihf.cjs`, endpoints `/api/sync-status`, `/api/sync`) — Fetches `GET https://data.sihf.ch/statistic/api/cms/gameoverview?alias=gameDetail&searchQuery={gameId}&language=de` for games with a known `sihfGameId` inside a rolling window (2 days past, 3 days future). Never marks a game final based on a live in-progress score. Writes boxscore player stats (goals/assists/+-/PIM/SOG/TOI for skaters; GA/saves/decision/shutout for goalies), periods, shots, and team stats. Idempotent (only writes on real field changes) and rate-limit aware (reads `x-ratelimit-*` headers, backs off). Has a one-off `--discover` CLI mode to map local games to SIHF's numeric game-id scheme. Auto-polls every 5 minutes by default (`SIHF_SYNC_INTERVAL_MIN`, disable via `SIHF_AUTO_SYNC=0`). After each sync it also calls `ensurePredictionSnapshots()` (see Backtesting/predictions below) to freeze forecasts for any newly-scheduled games.

No other external APIs are called; there is no SIHF/NL authentication (both are public/unauthenticated endpoints).

## Backtesting

- **Prediction snapshots** (`server/scripts/predictions.js`) — Every SIHF sync run calls `ensurePredictionSnapshots()`, which freezes a full pre-game forecast (10k-run Monte-Carlo per fixture, ELO/Power values, market-value/pre-season prior selection, rest-day adjustment) into `db.predictions[]` for every currently-`scheduled` game without an existing snapshot. Snapshots are immutable — a game is never given a second or updated snapshot.
- **Model Performance page** (`/model-performance`) — Evaluates only these frozen snapshots against actual results (`src/predictionMetrics.js`), so it is leak-free by construction (never recomputed against today's live ELO). Also displays a static reference block from the historical walk-forward backtest for comparison.
- **Historical walk-forward backtest tooling** (`server/scripts/backtesting/`) — `run.js` orchestrates a predictor registry (`predictors.js`) over historical archive seasons (`loadHistorical.js`), computes metrics/calibration/bootstrap significance (`stats.js`), and writes a static export `public/backtest-results.json` consumed by `src/pages/Backtesting.jsx`. Model versions (v0 naive baseline through the current production model) are declared in `modelVersions.js` with a hand-set `status` (`candidate`/`production`/`not_validatable`). Also many one-off calibration scripts exist in `server/scripts/` (`backtest-elo.js`, `backtest-montecarlo.js`, `backtest-power-ranking*.js`, `backtest-preseason-h2h.js`, `backtest-h2h.js`, `backtest-goalie-integration.js`, `backtest-player-features.js`, `backtest-absence-features.js`, `analyze-player-impact-score.js`, `diagnose-seed-sensitivity.js`) used historically to calibrate the production algorithms; these are standalone CLI tools, not wired into the running app. Unit-tested via `server/scripts/backtesting/run.test.js`.

## Settings / Configuration

`src/pages/Settings.jsx`:
- Season name, ELO start/K/home-advantage (saved via `PUT /api/settings`).
- **Prediction extensions card**: toggle + tune the market-value ELO prior (spread) and the rest-days/back-to-back penalty, with a live preview table of each team's resulting start ELO and league average (should always equal `eloStart`).
- **NL-API sync card**: manual "Jetzt synchronisieren" button + last-sync status.
- **Backup**: JSON export (client-side `Blob` download) and import (file picker + confirm dialog, `POST /api/import`).
- **Reset**: "reset games only" (`keepTeams: true`) and full reset to the 14 seeded teams, each behind a confirm dialog.

## Responsive / Mobile Support

No dedicated mobile framework; responsiveness is handled via `styles.css` (not read in full for this report, but referenced extensively) and per-page/per-component adaptations, e.g.: `App.jsx` measures the actual header height (incl. iOS safe-area padding) via `ResizeObserver` and exposes it as a CSS variable (`--header-actual-h`) so sticky sub-tabs dock correctly; `PlayoffOdds.jsx` hides its many analysis sections behind mobile-friendly tabs instead of a long scroll; `MatchForecast.jsx` renders a card list instead of a table specifically to avoid horizontal scrolling on phones; several tables use a `pin-first`/scroll-fade pattern (`useScrollFade` in `components/ui.jsx`) for horizontally-scrollable tables on narrow screens.

## Error Handling Patterns

- `App.jsx` shows a top-level "Verbindung zum Server fehlgeschlagen" card with the raw error message if `useData()` fails to fetch `/api/data`.
- Both sync jobs are fetch-all-then-write-once: they abort without touching `db.json` if any of their upstream fetches or the team-mapping step fails (`server/sync.js::runNlSync`, `buildTeamIdMap` throws on ambiguous/incomplete mapping).
- SIHF sync (`sync-sihf.cjs`) treats HTTP 404 as "not yet available" (not an error), retries transient failures with exponential backoff, and respects `x-ratelimit-*` headers by sleeping.
- `server/index.js` guards concurrent sync triggers with a `syncRunning`/`nlSyncRunning` boolean, returning HTTP 409 if a sync is already in progress.
- Many derived-data functions (`stats.js`, `playoffSim.js`, `scorelineMatrix.js`, `playerHistory.js`) explicitly return `null`/empty structures instead of `NaN`/crashing when there isn't enough data (e.g. `gp === 0`, insufficient sample size for confidence thresholds), and comment this as a deliberate "don't invent data" principle throughout the codebase.
- `server/index.js::readDb()` catches a corrupt/unreadable `db.json` and falls back to `emptyDb()` (logs the error to console) rather than crashing the server.

## Technical Overview

- **Frontend**: React 18 + Vite, plain JS (`.jsx`/`.js`, no TypeScript), React Router v6 for routing (`src/App.jsx`), a single global `DataContext` (`src/DataContext.jsx`) fetching `/api/data` once and memoizing all derived computations (standings, player stats, ELO incl. prior selection), plus a secondary `SimResultsContext` (`src/simResultsContext.jsx`) sharing the latest Monte-Carlo run between the Dashboard and PlayoffOdds pages without recomputation. Client-side `localStorage` is used only for the daily probability baseline history (`src/baselineStore.js`), capped at 90 entries.
- **Backend**: Single Express process (`server/index.js`) with no ORM — the entire DB is one JSON file read/written wholesale on every request. Two independent sync scripts (`server/sync.js`, `server/scripts/sync-sihf.cjs`) run as background intervals from the same process. No authentication/authorization anywhere.
- **Data storage**: `server/data/db.json` (live data), `seed.json` (template), two sync-status files, plus five statically pre-generated files under `public/` (historical H2H, team/player multi-season history, pre-season ELO, backtest results) built offline by one-off scripts in `server/scripts/` and fetched lazily by the frontend.
- **External APIs**: `nationalleague.ch` public REST API (games/teams/players, no auth) and the official SIHF `data.sihf.ch` statistics API (per-game boxscore/overview, no auth). Both are unauthenticated, unversioned, and undocumented beyond what the code infers from observed responses.
- **Synchronization**: NL-API sync every 30 min (+ once at boot), SIHF sync every 5 min, both toggleable/tunable via environment variables, both idempotent and additive.
- **Major algorithms**: custom ELO (`src/elo.js`), Power Ranking (`src/powerRankings.js`), 10k-run seeded Monte-Carlo season/playoff simulation (`src/playoffSim.js`), scoreline/goal-distribution/xG aggregation (`src/scorelineMatrix.js`), player Impact Score (`src/playerHistory.js`), prediction-quality metrics (`src/predictionMetrics.js`).
- **Testing/build**: No TypeScript, no test framework beyond Node's built-in `node --test`; four targeted suites (`src/playoffSim.test.js`, `src/wheelGeometry.test.js`, `src/scorelineMatrix.test.js`, `server/scripts/backtesting/run.test.js`) covering only pure-logic modules — none of the React pages/components have automated tests. Build via `vite build` (`npm run build`) into `dist/`, served by the same Express process in production (`npm run serve`) or by the Vite dev server with an API proxy in development (`npm run dev`, `vite.config.js`). Deployment config exists for Render.com (`render.yaml`, free web-service plan, Node 20).

## Known Gaps / Potential Improvements

- **README is stale**: `README.md` still documents a `GameEntry.jsx` "Spiel erfassen" manual game-entry page and a `crud('games', ...)` API — both were explicitly removed (see the comment block in `server/index.js` lines 137–139 and the absence of `src/pages/GameEntry.jsx` on disk). The current game data flow is 100% sync-driven (NL-API + SIHF); the README's "So benutzt du die App" walkthrough is outdated for that step.
- **No authentication or access control** anywhere in the API or frontend — anyone who can reach the server (or open the SPA against it) has full read/write access, including data reset/import. Acceptable for a private single-user tool, but worth flagging.
- **No automated tests for UI code**: all four `node --test` suites cover only pure computation modules (`playoffSim.js`, `wheelGeometry.js`, `scorelineMatrix.js`, backtest `run.js`). None of the 17 pages or 13 components have any test coverage; regressions in rendering/interaction logic would only be caught manually.
- **Whole-file JSON persistence**: `server/index.js` reads and rewrites the entire `db.json` on every mutating request (`writeDb`); with 409+ players/364+ games this is already a non-trivial file and will not scale gracefully as data grows across future seasons — there is no incremental/streaming write path, transactionality, or backup rotation beyond the manual export button.
- **`season` field unused**: `computeElo()`'s season-end regression-to-mean logic (`ELO_CONFIG.seasonEndRegression`) only fires "if games carry a `season` field and it changes" — the comment in `src/elo.js` states games currently never carry this field, so the regression path is dead code for the live season (it is only exercised via the separate pre-season-ELO carry-over mechanism, `src/preseasonElo.js`).
- **Manual player/team edits vs. sync**: player edits made through the (still-present) `POST/PUT/DELETE /api/players` CRUD endpoints could, in principle, be overwritten by the next NL-API sync for any field the sync considers its own (`externalId`, `number`, `teamId`, `position`, `apiStats`, `marketValue*`) — the code carefully avoids touching genuinely manual fields (name, positionDetail, shoots, nationality, heightCm, weightKg, birthdate, injury*), but there is no UI warning that some fields are sync-owned.
- **Play-out opponent (Ligaqualifikation) not modeled**: `simulateSeasonProjections()` explicitly tracks only the *probability* of reaching the Ligaqualifikation (play-out loser vs. the Swiss League champion); the Swiss League side of that tie is outside the data model and is not simulated (documented directly in `src/playoffSim.js` comments).
- **Small, undocumented deployment gap**: `render.yaml` builds and starts the app as a single free-tier web service, but there's no persistent-disk configuration visible for `server/data/db.json` — on most free-tier PaaS setups without an attached persistent volume, the JSON database would not survive a redeploy/restart. Not verifiable further without the actual Render dashboard config, so flagged rather than asserted as broken.
- **No rate limiting / request validation on the Express API** beyond the two sync-mutex booleans and a basic `Array.isArray(incoming.teams)` check on import — arbitrary JSON payloads to `PUT /api/settings` or `POST /api/teams|players` are merged in without schema validation.
