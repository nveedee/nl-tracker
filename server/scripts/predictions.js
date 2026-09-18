// ---------------------------------------------------------------------------
// Pre-Game Prediction Snapshots: friert die aktuelle Modellprognose für ein
// zukünftiges Spiel EINMALIG ein, damit sie nach Spielbeginn nicht mehr
// rückwirkend verändert werden kann (z.B. durch spätere ELO-Updates).
//
// Verwendet AUSSCHLIESSLICH die bereits vorhandenen, unveränderten
// produktiven Prognosefunktionen:
//   - computeElo() / ELO_CONFIG           (src/elo.js)
//   - computePowerRankings()              (src/powerRankings.js)
//   - computeFixtures() / simulateGameResult() / SeededRandom (src/playoffSim.js)
// Keine neue Prognoseformel, kein neues Feature, keine H2H-/Form-Anpassung.
// elo.js/powerRankings.js/playoffSim.js werden von dieser Datei nur
// IMPORTIERT, nicht verändert.
//
// Läuft als eigenständiges ESM-Modul (package.json: "type":"module"), damit
// es direkt aus `src/*.js` importieren kann. server/scripts/sync-sihf.cjs
// (CommonJS) bindet es per dynamischem import() ein - siehe dort.
//
// Speicherort: `db.predictions[]`, eine eigene Collection in derselben
// server/data/db.json (wie teams/players/games), aber strikt getrennt von
// `db.games` - kein Spielfeld wird durch Predictions ergänzt oder verändert.
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { computeElo, ELO_CONFIG } from '../../src/elo.js'
import { computePowerRankings } from '../../src/powerRankings.js'
import { computeFixtures, simulateGameResult, SeededRandom } from '../../src/playoffSim.js'
import { computeMarketValuePrior, DEFAULT_PRIOR_SPREAD } from '../../src/marketValuePrior.js'
import { applyRestAdjustment, computeRestAdjustment, DEFAULT_BACK_TO_BACK_PENALTY } from '../../src/restDays.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PRESEASON_PATH = path.join(__dirname, '..', '..', 'public', 'preseason-elo.json')

// Bezeichnet exakt die Kombination der oben verwendeten, unveränderten
// Bausteine - dient nur der Nachvollziehbarkeit im gespeicherten Snapshot,
// beeinflusst die Berechnung selbst nicht. Zwei Suffixe hängen vom
// tatsächlich verwendeten ELO-Start-Prior UND von der Ruhetage/Back-to-back-
// Anpassung DIESES konkreten Snapshots ab (beide in den Einstellungen
// unabhängig um-/abschaltbar, siehe src/marketValuePrior.js, src/restDays.js) -
// so bleiben Snapshots verschiedener Modell-Varianten in ModelPerformance.jsx
// unterscheidbar, statt sich unter derselben Versions-Zeichenkette zu vermischen.
const BASE_MODEL_VERSION = 'preseason-elo-25pct+sog-mc10k-v1'
function buildModelVersion(priorSource, restDaysApplied) {
  const priorSuffix = priorSource === 'marketValue' ? '+mvprior' : ''
  const restSuffix = restDaysApplied ? '+b2b' : ''
  return BASE_MODEL_VERSION + priorSuffix + restSuffix
}

const SIMULATION_RUNS = 10000

// Jeder Snapshot bekommt einen eigenen, zufälligen Seed (Node `crypto`,
// analog zur zufälligen Seed-Erzeugung beim manuellen "Simulation
// aktualisieren" auf der Season-Projections-Seite) - kein gemeinsamer
// hardcodierter Seed mehr für alle Snapshots. Reproduzierbarkeit bleibt
// erhalten, da der erzeugte Seed IM Snapshot gespeichert wird.
function generateSeed() {
  return crypto.randomInt(1, 2 ** 31 - 1)
}

function readPreseasonSeasonEnd() {
  try {
    return JSON.parse(fs.readFileSync(PRESEASON_PATH, 'utf-8'))
  } catch {
    return null // kein Export vorhanden -> Fallback auf regulären eloStart (unverändertes Verhalten)
  }
}

// Identische Formel wie src/preseasonElo.js::computePreseasonRatings. Dort
// als React-Hook-Modul (import 'react') nicht ohne Weiteres aus einem
// eigenständigen Node-Skript importierbar - bewusst dupliziert, exakt wie an
// anderer Stelle im Projekt bereits üblich (z.B. computeShotsAllowedPerGame
// in src/headToHead.js), um preseasonElo.js nicht anfassen zu müssen.
function computePreseasonRatings(seasonEndRatings, eloStart) {
  if (!seasonEndRatings) return null
  const regression = ELO_CONFIG.seasonEndRegression
  const out = {}
  for (const [teamId, rating] of Object.entries(seasonEndRatings)) {
    out[teamId] = eloStart + (rating - eloStart) * (1 - regression)
  }
  return out
}

function round(v, decimals) {
  if (v == null || !Number.isFinite(v)) return null
  const f = 10 ** decimals
  return Math.round(v * f) / f
}

// Simuliert EIN Fixture 10'000x (identische Poisson-/OT-SO-Logik wie die
// produktive Monte-Carlo-Simulation, hier nur pro einzelnem Spiel statt für
// eine ganze Saison aggregiert - reine Aggregation derselben, unveränderten
// simulateGameResult()-Bausteine).
function simulateFixture(fixture, seed, runs = SIMULATION_RUNS) {
  const rng = new SeededRandom(seed)
  let homeWins = 0, ot = 0, so = 0, sumHome = 0, sumAway = 0
  for (let i = 0; i < runs; i++) {
    const r = simulateGameResult(rng, fixture)
    sumHome += r.homeGoals
    sumAway += r.awayGoals
    if (r.homeGoals > r.awayGoals) homeWins++
    if (r.decision === 'OT') ot++
    else if (r.decision === 'SO') so++
  }
  return {
    pHomeWin: homeWins / runs,
    pAwayWin: (runs - homeWins) / runs,
    pOT: ot / runs,
    pSO: so / runs,
    avgHomeGoals: sumHome / runs,
    avgAwayGoals: sumAway / runs,
  }
}

// Erstellt fehlende Prediction-Snapshots für alle noch nicht gestarteten
// ("status: scheduled") Spiele in `db.games`, die noch keinen Eintrag in
// `db.predictions` haben. Mutiert `db` in place (Aufrufer entscheidet, ob per
// writeDb() persistiert wird - z.B. nicht im --dry-run). Bereits gespielte
// Spiele werden NIE nachträglich versehen (Aufrufer muss `runSync()` den
// Games-Update-Schritt VOR diesem Aufruf ausführen, damit frisch final
// gewordene Spiele hier bereits korrekt ausgeschlossen sind).
//
// Idempotent: ein `gameId` bekommt nie einen zweiten Eintrag, ein
// bestehender Eintrag wird nie verändert (kein Update-Pfad vorhanden).
export function ensurePredictionSnapshots(db, { now = new Date(), log } = {}) {
  if (!Array.isArray(db.predictions)) db.predictions = []
  const existingIds = new Set(db.predictions.map((p) => p.gameId))

  const teams = db.teams || []
  const players = db.players || []
  const games = db.games || []
  const settings = db.settings || {}
  const eloStart = settings.eloStart ?? ELO_CONFIG.eloStart

  const pending = games.filter((g) => g.status === 'scheduled' && !existingIds.has(g.id))
  if (pending.length === 0) return { created: 0, total: db.predictions.length }

  // ELO-Start-Prior: Marktwert-Prior (src/marketValuePrior.js), wenn aktiviert
  // und Daten vorhanden, sonst der bestehende historische Pre-Season-ELO -
  // identische Priorität wie in DataContext.jsx (derived.eloPriorSource).
  const useMarketValue = settings.marketValuePriorEnabled !== false
  const marketPrior = useMarketValue
    ? computeMarketValuePrior(teams, players, eloStart, settings.priorSpread ?? DEFAULT_PRIOR_SPREAD)
    : null
  const preseasonSeasonEnd = readPreseasonSeasonEnd()
  const historicalRatings = computePreseasonRatings(preseasonSeasonEnd, eloStart)
  const initialRatings = marketPrior || historicalRatings
  const priorSource = marketPrior ? 'marketValue' : (historicalRatings ? 'historicalArchive' : 'flat')

  // Ruhetage/Back-to-back (src/restDays.js) - nur für die Einzelspiel-
  // Prognose, wirkt sich NICHT auf eloRatings/die Simulation selbst aus.
  const restDaysEnabled = settings.restDaysEnabled !== false
  const backToBackPenalty = settings.backToBackPenalty ?? DEFAULT_BACK_TO_BACK_PENALTY

  // Einmal für den gesamten Batch berechnet (identischer Stand "jetzt" für
  // alle in diesem Lauf neu erzeugten Snapshots) - exakt dieselben,
  // unveränderten Funktionen wie in MatchupDetail.jsx/PlayoffOdds.jsx.
  const { fixtures, eloRatings } = computeFixtures(teams, games, settings, players, initialRatings)
  const power = computePowerRankings(teams, games, eloRatings, players)
  const powerByTeam = Object.fromEntries(power.map((p) => [p.team.id, p]))
  const fixtureByPair = new Map(fixtures.map((f) => [`${f.home}:${f.away}`, f]))

  let created = 0
  for (const g of pending) {
    const fixture = fixtureByPair.get(`${g.homeTeamId}:${g.awayTeamId}`)
    if (!fixture) continue // sollte nicht vorkommen (jedes 'scheduled'-Spiel hat ein Fixture), defensiv übersprungen

    const seed = generateSeed()
    const mc = simulateFixture(fixture, seed)

    const restAdjustment = restDaysEnabled ? computeRestAdjustment(g, games, backToBackPenalty) : 0
    const pHomeWin = restAdjustment !== 0 ? applyRestAdjustment(mc.pHomeWin, g, games, backToBackPenalty) : mc.pHomeWin

    db.predictions.push({
      gameId: g.id,
      createdAt: now.toISOString(),
      seed,
      date: g.date,
      time: g.time || null,
      homeTeamId: g.homeTeamId,
      awayTeamId: g.awayTeamId,
      homeWinProbability: round(pHomeWin, 4),
      awayWinProbability: round(1 - pHomeWin, 4),
      expectedHomeGoals: round(mc.avgHomeGoals, 2),
      expectedAwayGoals: round(mc.avgAwayGoals, 2),
      otProbability: round(mc.pOT, 4),
      soProbability: round(mc.pSO, 4),
      eloHome: Math.round(eloRatings[g.homeTeamId] ?? eloStart),
      eloAway: Math.round(eloRatings[g.awayTeamId] ?? eloStart),
      // Phase 1 Player-Rating-Integration (siehe src/playerRatingAdjustment.js) -
      // separat von eloHome/eloAway geführt (Variante B), bei Default-Gewicht 0
      // immer 0 und ohne Effekt auf pHomeWin/expectedGoals.
      playerRatingAdjHome: round(fixture.playerRatingAdjHome, 2),
      playerRatingAdjAway: round(fixture.playerRatingAdjAway, 2),
      powerHome: powerByTeam[g.homeTeamId]?.powerScore ?? null,
      powerAway: powerByTeam[g.awayTeamId]?.powerScore ?? null,
      modelVersion: buildModelVersion(priorSource, restAdjustment !== 0),
    })
    existingIds.add(g.id)
    created++
  }

  if (log && created > 0) log(`  → ${created} Prediction-Snapshot${created === 1 ? '' : 's'} neu erstellt`)
  return { created, total: db.predictions.length }
}
