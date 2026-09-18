// ---------------------------------------------------------------------------
// PHASE 3 - RE-BACKTEST DER TATSÄCHLICH IMPLEMENTIERTEN PRODUKTIONSFORMEL.
//
// Unterschied zu server/scripts/backtest-player-rating-integration.js (dem
// EXPLORATIVEN Backtest, der eine eigene Wahrscheinlichkeits-Blend-Formel
// getestet hat): dieses Skript ruft die ECHTEN, jetzt implementierten
// Produktionsfunktionen auf:
//   - src/playerRating.js::calculatePlayerRating / buildSkaterRatingBaselines
//   - src/playerRatingAdjustment.js::computePlayerRatingEloAdjustments
//   - src/elo.js::homeWinProbability
// Read-only Import, KEINE Änderung an diesen Dateien. Ziel: bestätigen (oder
// widerlegen), dass die im explorativen Backtest gefundene "90/10"-Grössen-
// ordnung auch mit dem tatsächlich gebauten ELO-additiven Mechanismus gilt.
//
// METHODIK-ANPASSUNG (siehe Bericht): calculatePlayerRating()/
// buildSkaterRatingBaselines() sind für das LIVE-Datenmodell gebaut (EIN
// laufende Saison, `db.games` enthält nie mehrere Saisons gleichzeitig) und
// kennen selbst keine Saison-Grenzen. Für einen mehrsaisonalen historischen
// Walk-Forward wird deshalb - GENAU WIE ES DIE PRODUKTION TÄTE - der
// "Games-so-far"-Pool bei jedem Saisonwechsel geleert (nur Spiele DERSELBEN
// Saison zählen als "aktuelle Saison"). Das ist keine Vereinfachung des
// Tests, sondern spiegelt exakt wider, wie server/scripts/predictions.js die
// Funktion tatsächlich aufruft (immer nur mit `db.games`, das nie mehr als
// eine Saison enthält).
//
// Da `weight` in computePlayerRatingEloAdjustments() linear in die
// Adjustierung eingeht (adjustments[t] = weight * clampedZ * confidence *
// LOGIT_TO_ELO), wird die teure Rating-Berechnung NUR EINMAL pro Datum mit
// weight=1.0 ausgeführt ("Rohwert") und für alle getesteten Gewichte per
// Skalarmultiplikation abgeleitet - mathematisch exakt (kein Genauigkeits-
// verlust), aber ~6x schneller als 6 volle Durchläufe.
//
// Aufruf: node server/scripts/backtest-player-rating-production-formula.js
// ---------------------------------------------------------------------------

import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { loadHistoricalGames, evalBinaryPredictions, mean } from '../playerRatingBacktestCore.js'
import { calculatePlayerRating, buildSkaterRatingBaselines, RATING_BLEND_WEIGHTS } from '../../src/playerRating.js'
import { computePlayerRatingEloAdjustments } from '../../src/playerRatingAdjustment.js'
import { homeWinProbability } from '../../src/elo.js'
import { POSITION_LABEL, buildPositionBaselines } from '../../src/playerHistory.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const ELO_PARAMS = { kBase: 24, homeAdv: 50, goalDiffFactor: 0.5 } // identisch zu den beiden vorherigen Backtests
const WEIGHTS = [0.00, 0.05, 0.10, 0.15, 0.20, 0.25]
const VALIDATION_SEASONS = ['2022/23', '2023/24', '2024/25', '2025/26']
const TRAIN_SEASONS = new Set(['2017/18', '2018/19', '2021/22'])

function kTiers(kBase) { const s = kBase / 24; return [{ maxGames: 5, k: 32 * s }, { maxGames: 15, k: 28 * s }, { maxGames: 30, k: 24 * s }, { maxGames: 50, k: 20 * s }, { maxGames: Infinity, k: 16 * s }] }
function getK(tiers, gp) { for (const t of tiers) if (gp <= t.maxGames) return t.k; return tiers[tiers.length - 1].k }
function goalDiffMult(diff, factor) { if (diff === 0 || factor === 0) return 1; return 1 + factor * (Math.log(diff + 1) - 1) }

// Historische Skater-Zeile (server/playerRatingBacktestCore.js::loadHistoricalGames)
// -> `game.playerStats[]`-Zeile im LIVE-Format (src/advancedStats.js-Schema),
// exakt wie server/nlGameDetailSync.js sie in db.json ablegt (minus xG - im
// Archiv nicht vorhanden, siehe Bericht - bleibt dadurch korrekt `null`/
// unbesetzt statt erfunden).
function toLivePlayerStatsRow(s) {
  return {
    playerId: String(s.playerId),
    goals: s.goals, assists: s.assists, points: s.points,
    plusMinus: s.plusMinus,
    sog: s.sog,
    blockedShots: s.blockedShots,
    toiSec: s.toiSec,
    toiPpSec: s.ppToiSec,
    toiPkSec: s.pkToiSec,
    faceoffsWon: s.faceoffsWon,
    faceoffsLost: s.faceoffsLost,
    faceoffsTotal: (s.faceoffsWon != null && s.faceoffsLost != null) ? s.faceoffsWon + s.faceoffsLost : null,
  }
}

// Baut aus den bisher abgeschlossenen SAISONS (nicht der laufenden) ein
// player-history.json-förmiges Objekt ({ players: { id: { seasons: [...] } } })
// - GENAU das Format, das src/playerHistory.js::getPlayerSeasons/
// buildPositionBaselines erwarten. Testet die Hypothese aus dem Bericht:
// "fehlt die Karriere-Verankerung (Phase 1 verdrahtet playerHistoryData
// aktuell NICHT), dominieren einzelne frühe Saisonspiele ungedämpft."
function buildCareerArchive(seasonSummaries) {
  const players = {}
  for (const [playerId, seasons] of seasonSummaries) {
    if (seasons.length === 0) continue
    players[playerId] = { seasons }
  }
  return { players }
}

function finalizeSeasonSummary(liveGames, playerMeta, season) {
  const perPlayer = new Map()
  for (const g of liveGames) {
    for (const s of g.playerStats) {
      if (!perPlayer.has(s.playerId)) perPlayer.set(s.playerId, { gp: 0, goals: 0, assists: 0, points: 0, sog: 0, plusMinus: 0, toiSec: 0 })
      const acc = perPlayer.get(s.playerId)
      acc.gp++
      acc.goals += s.goals || 0; acc.assists += s.assists || 0; acc.points += s.points || 0
      acc.sog += s.sog || 0; acc.plusMinus += s.plusMinus || 0; acc.toiSec += s.toiSec || 0
    }
  }
  const out = new Map()
  for (const [playerId, acc] of perPlayer) {
    const meta = playerMeta.get(playerId)
    const posLabel = meta ? POSITION_LABEL[meta.position] : null
    if (!posLabel) continue
    out.set(playerId, { season, teamId: meta.teamId, position: posLabel, ...acc })
  }
  return out
}

// `useCareerData`: testet die Karriere-Anker-Hypothese (siehe Bericht) -
// baut playerHistoryData aus allen VOR der laufenden Saison bereits
// abgeschlossenen Archiv-Saisons (leak-frei: eine Saison wird erst beim
// NÄCHSTEN Saisonwechsel - also nach ihrem letzten Spiel - in die Karriere
// übernommen).
function runProductionFormulaWalk(games, allTeams, options = {}) {
  const { useCareerData = false } = options
  const eloRatings = new Map(), eloGamesPlayed = new Map()
  const tiers = kTiers(ELO_PARAMS.kBase)

  let currentSeason = null
  let liveGames = [] // NUR die aktuelle Saison, live-Format - siehe Methodik-Kommentar oben
  let playerMeta = new Map() // playerId(String) -> {id, teamId, position} - NUR aktuelle Saison

  const careerSeasonsByPlayer = new Map() // playerId -> [ {season,...}, ... ] - NUR abgeschlossene Saisons
  let playerHistoryData = null
  let careerBaselines = null // EINMAL pro Saisonwechsel vorgebaut (Performance, s.u.)

  let cachedDate = null, rawAdjustments = null, rawDiagAdjustments = null // "Rohwert" bei weight=1.0, einmal pro Datum

  const results = []

  for (const g of games) {
    if (currentSeason !== g.season) {
      if (useCareerData && currentSeason !== null) {
        const summary = finalizeSeasonSummary(liveGames, playerMeta, currentSeason)
        for (const [playerId, s] of summary) {
          if (!careerSeasonsByPlayer.has(playerId)) careerSeasonsByPlayer.set(playerId, [])
          careerSeasonsByPlayer.get(playerId).push(s)
        }
        playerHistoryData = buildCareerArchive(careerSeasonsByPlayer)
        careerBaselines = buildPositionBaselines(playerHistoryData) // einmal pro Saison statt einmal pro Spieler
      }
      currentSeason = g.season
      liveGames = []
      playerMeta = new Map()
      cachedDate = null
    }
    if (g.date !== cachedDate) {
      const players = [...playerMeta.values()]
      const skaterBaselines = buildSkaterRatingBaselines(players, liveGames)
      // careerBaselines wird bewusst NICHT vorgebaut - computePlayerRatingEloAdjustments()
      // /calculatePlayerRating() bauen sie bei Bedarf selbst aus playerHistoryData
      // (identisch zum produktiven Fallback-Pfad, siehe src/playerRating.js).
      rawAdjustments = computePlayerRatingEloAdjustments(allTeams, liveGames, players, {
        weight: 1.0, skaterBaselines,
        playerHistoryData: useCareerData ? playerHistoryData : undefined,
        careerBaselines: useCareerData ? careerBaselines : undefined,
      })
      if (options.diagnosticMode === 'fd') {
        rawDiagAdjustments = diagnosticFDSeparatedAdjustments(allTeams, liveGames, players, skaterBaselines)
      } else if (options.diagnosticMode === 'noSpecialTeams') {
        rawDiagAdjustments = diagnosticNoSpecialTeamsAdjustments(allTeams, liveGames, players, skaterBaselines)
      }
      cachedDate = g.date
    }

    const rh = eloRatings.get(g.homeTeamId) ?? 1500
    const ra = eloRatings.get(g.awayTeamId) ?? 1500
    const pEloOnly = homeWinProbability(rh, ra, ELO_PARAMS.homeAdv)

    results.push({
      season: g.season, corona: g.corona, date: g.date,
      homeWon: g.homeGoals > g.awayGoals,
      eloHome: rh, eloAway: ra,
      rawAdjHome: rawAdjustments[g.homeTeamId] ?? 0,
      rawAdjAway: rawAdjustments[g.awayTeamId] ?? 0,
      rawDiagAdjHome: rawDiagAdjustments ? (rawDiagAdjustments[g.homeTeamId] ?? 0) : 0,
      rawDiagAdjAway: rawDiagAdjustments ? (rawDiagAdjustments[g.awayTeamId] ?? 0) : 0,
      pEloOnly,
    })

    // --- ELO-Update (NACH der Prognose) ---
    const homeWon = g.homeGoals > g.awayGoals
    const diff = Math.abs(g.homeGoals - g.awayGoals)
    const goalMult = goalDiffMult(diff, ELO_PARAMS.goalDiffFactor)
    const gpH = eloGamesPlayed.get(g.homeTeamId) ?? 0, gpA = eloGamesPlayed.get(g.awayTeamId) ?? 0
    const kH = getK(tiers, gpH), kA = getK(tiers, gpA)
    eloRatings.set(g.homeTeamId, rh + kH * goalMult * ((homeWon ? 1 : 0) - pEloOnly))
    eloRatings.set(g.awayTeamId, ra + kA * goalMult * ((homeWon ? 0 : 1) - (1 - pEloOnly)))
    eloGamesPlayed.set(g.homeTeamId, gpH + 1)
    eloGamesPlayed.set(g.awayTeamId, gpA + 1)

    // --- Zustand aktualisieren (NACH der Prognose) ---
    for (const s of g.skaters) playerMeta.set(String(s.playerId), { id: String(s.playerId), teamId: s.teamId, position: s.position })
    liveGames.push({
      id: g.gameId, date: g.date, status: 'final', homeTeamId: g.homeTeamId, awayTeamId: g.awayTeamId,
      playerStats: g.skaters.map(toLivePlayerStatsRow),
    })
  }
  return results
}

// ============================================================================
// DIAGNOSE-VARIANTE (NICHT die Produktionsformel!) - testet die Hypothese,
// ob die Ursache des Effekt-Unterschieds ggü. dem explorativen Backtest die
// UNGETRENNTE F+D-Mittelung in src/playerRatingAdjustment.js::
// teamFieldPlayerZ() ist (dort: EIN flacher Durchschnitt über alle F+D-
// Spieler, roster-grössen-abhängig gewichtet) - der explorative Backtest
// bildete stattdessen getrennte F-/D-Mittelwerte und kombinierte sie fix
// 60/40 (unabhängig vom Roster-Verhältnis F:D). Nutzt dieselbe reale
// calculatePlayerRating()-Funktion PRO SPIELER (keine neue Rating-Logik),
// nur die TEAM-AGGREGATION wird hier zu Vergleichszwecken anders gebaut -
// ändert NICHTS an src/playerRatingAdjustment.js.
// ============================================================================
const DIAG_LOGIT_TO_ELO = 400 / Math.LN10
function diagnosticFDSeparatedAdjustments(teams, games, players, skaterBaselines, options = {}) {
  const adjustments = {}
  teams.forEach((t) => { adjustments[t.id] = 0 })
  for (const t of teams) {
    const roster = players.filter((p) => p.teamId === t.id)
    const fZs = [], dZs = []
    for (const p of roster) {
      const rating = calculatePlayerRating(p.id, games, { players, asOfDate: options.asOfDate, skaterBaselines })
      if (rating?.overallZ == null) continue
      if (p.position === 'F') fZs.push(rating.overallZ)
      else if (p.position === 'D') dZs.push(rating.overallZ)
    }
    const meanF = fZs.length ? mean(fZs) : null
    const meanD = dZs.length ? mean(dZs) : null
    let wSum = 0, vSum = 0
    if (meanF != null) { vSum += meanF * 0.6; wSum += 0.6 }
    if (meanD != null) { vSum += meanD * 0.4; wSum += 0.4 }
    if (wSum === 0) continue
    const z = vSum / wSum
    const clampedZ = Math.max(-2.5, Math.min(2.5, z))
    const ratedCount = fZs.length + dZs.length
    const confidence = Math.max(0, Math.min(1, ratedCount / 12))
    adjustments[t.id] = clampedZ * confidence * DIAG_LOGIT_TO_ELO // weight=1.0 "Rohwert", wie beim Hauptlauf
  }
  return adjustments
}

// ============================================================================
// DIAGNOSE-VARIANTE 2 (NICHT die Produktionsformel!) - testet die
// specialTeams-Datenvollständigkeits-Hypothese aus dem Bericht: die reale
// specialTeams-Kategorie (20%/15% Gewicht) wird in diesem Backtest NUR aus
// ppToiPerGame gespeist (powerplayGoals/-Assists/shPoints sind im
// historischen Archiv nicht situationsgetaggt verfügbar, siehe Bericht -
// empirisch verifiziert: 365/365 Spieler-Samples einer Stichprobe hatten
// spezialTeams-Komponenten-Anzahl 1 von 4 möglichen). Hier wird DIESELBE,
// bereits von calculatePlayerRating() berechnete `rates`-Struktur pro
// Spieler wiederverwendet (KEINE neue Rating-Logik), nur die TOP-LEVEL-
// Komposition wird lokal so nachgebaut, dass specialTeams komplett entfällt
// und sein Gewicht in usage aufgeht (F: offense 40/defense 15/usage 45,
// D: offense 20/defense 35/usage 45 - identisch zu HIST_TOP_WEIGHTS im
// explorativen Backtest). Ändert NICHTS an src/playerRating.js.
// ============================================================================
const NO_SPECIAL_TEAMS_WEIGHTS = {
  F: { offense: 0.40, defense: 0.15, usage: 0.45 },
  D: { offense: 0.20, defense: 0.35, usage: 0.45 },
}
const NST_OFFENSE_KEYS = [['pointsPerGame', 1], ['goalsPerGame', 1], ['assistsPerGame', 1], ['sogPerGame', 1], ['xgPerGame', 1], ['goalsMinusXgPerGame', 0.5, 1.5]]
const NST_DEFENSE_KEYS = [['plusMinusPerGame', 1], ['blockedShotsPerGame', 1], ['pkToiPerGame', 1]]
const NST_USAGE_KEYS = [['toiPerGame', 1], ['ppToiPerGame', 1], ['pkToiPerGame', 1], ['faceoffPercentage', 0.5]]
const NST_MIN_N = 20
const NST_CLAMP = 3

function nstClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
function nstZOf(value, baselineEntry, clampAbs) {
  if (value == null || !baselineEntry || baselineEntry.n < NST_MIN_N) return null
  return nstClamp((value - baselineEntry.mean) / baselineEntry.std, -clampAbs, clampAbs)
}
function nstWeightedZ(rates, baseline, keys) {
  let wSum = 0, zSum = 0, used = 0
  for (const [key, weight, clampAbs] of keys) {
    const z = nstZOf(rates?.[key], baseline?.[key], clampAbs ?? NST_CLAMP)
    if (z == null) continue
    zSum += z * weight; wSum += weight; used++
  }
  return used === 0 ? null : zSum / wSum
}
function nstWeightedAvg(pairs) {
  let wSum = 0, vSum = 0
  for (const [v, w] of pairs) { if (v == null || !(w > 0)) continue; vSum += v * w; wSum += w }
  return wSum > 0 ? vSum / wSum : null
}
function nstBlendWeightsForGp(gp) {
  for (const row of RATING_BLEND_WEIGHTS) if (gp <= row.maxGp) return row
  return RATING_BLEND_WEIGHTS[RATING_BLEND_WEIGHTS.length - 1]
}

function diagnosticNoSpecialTeamsAdjustments(teams, games, players, skaterBaselines, options = {}) {
  const adjustments = {}
  teams.forEach((t) => { adjustments[t.id] = 0 })
  for (const t of teams) {
    const roster = players.filter((p) => p.teamId === t.id && (p.position === 'F' || p.position === 'D'))
    const zs = []
    for (const p of roster) {
      const rating = calculatePlayerRating(p.id, games, { players, asOfDate: options.asOfDate, skaterBaselines })
      if (!rating) continue
      const posBaseline = skaterBaselines[p.position]
      const rates = rating.components.rates
      const offenseZ = rates ? nstWeightedZ(rates, posBaseline, NST_OFFENSE_KEYS) : null
      const defenseZ = rates ? nstWeightedZ(rates, posBaseline, NST_DEFENSE_KEYS) : null
      const usageZ = rates ? nstWeightedZ(rates, posBaseline, NST_USAGE_KEYS) : null
      const w = NO_SPECIAL_TEAMS_WEIGHTS[p.position]
      const currentZ = nstWeightedAvg([[offenseZ, w.offense], [defenseZ, w.defense], [usageZ, w.usage]])
      const formZ = rating.components.formZ // Form-Zusammensetzung unverändert (enthielt nie specialTeams-Felder)
      const blend = nstBlendWeightsForGp(rating.sampleSize.currentSeasonGp)
      // Karriere unverändert null (identisch zu Variante 1) - reiner Vergleich der Top-Level-Komposition.
      const overallZ = nstWeightedAvg([[null, blend.career], [currentZ, blend.current], [formZ, blend.form]])
      if (overallZ != null) zs.push(overallZ)
    }
    if (zs.length === 0) continue
    const z = mean(zs)
    const clampedZ = nstClamp(z, -2.5, 2.5)
    const confidence = nstClamp(zs.length / 12, 0, 1)
    adjustments[t.id] = clampedZ * confidence * DIAG_LOGIT_TO_ELO
  }
  return adjustments
}

function predictAtWeight(rows, weight, fields = ['rawAdjHome', 'rawAdjAway']) {
  const [homeField, awayField] = fields
  return rows.map((r) => ({
    season: r.season, corona: r.corona,
    p: homeWinProbability(r.eloHome + weight * r[homeField], r.eloAway + weight * r[awayField], ELO_PARAMS.homeAdv),
    y: r.homeWon ? 1 : 0,
  }))
}

function fmtPct(x) { return x == null ? 'n/a' : (x * 100).toFixed(1) + '%' }
function fmt4(x) { return x == null ? 'n/a' : x.toFixed(4) }

function bootstrap(basePreds, varPreds, iterations = 500, seed = 7) {
  const n = basePreds.length
  let s = seed
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  const EPS = 1e-10
  const ll = (preds, idx) => mean(idx.map((i) => { const p = Math.min(1 - EPS, Math.max(EPS, preds[i].p)); const y = preds[i].y; return -(y * Math.log(p) + (1 - y) * Math.log(1 - p)) }))
  const diffs = []
  for (let it = 0; it < iterations; it++) {
    const idx = Array.from({ length: n }, () => Math.floor(rand() * n))
    diffs.push(ll(basePreds, idx) - ll(varPreds, idx))
  }
  diffs.sort((a, b) => a - b)
  return { mean: mean(diffs), p05: diffs[Math.floor(iterations * 0.05)], p95: diffs[Math.floor(iterations * 0.95)], fracBetter: diffs.filter((d) => d > 0).length / iterations }
}

function reportVariant(label, rows, fields = ['rawAdjHome', 'rawAdjAway']) {
  console.log('\n' + '='.repeat(92))
  console.log(label)
  console.log('='.repeat(92))
  const validationRows = rows.filter((r) => !r.corona && VALIDATION_SEASONS.includes(r.season))
  const withAdj = validationRows.filter((r) => r[fields[0]] !== 0 || r[fields[1]] !== 0)
  console.log(`Validation games: ${validationRows.length}, davon mit Rating-Unterschied != 0: ${withAdj.length} (${(withAdj.length / validationRows.length * 100).toFixed(1)}%)`)

  const header = 'Weight'.padEnd(10) + 'Accuracy'.padEnd(10) + 'Brier'.padEnd(9) + 'LogLoss'.padEnd(9) + '22/23'.padEnd(9) + '23/24'.padEnd(9) + '24/25'.padEnd(9) + '25/26'.padEnd(9) + 'ΔLogLoss vs 0%'
  console.log(header)

  const baselinePreds = predictAtWeight(validationRows, 0, fields)
  const baselineEv = evalBinaryPredictions(baselinePreds)
  const weightResults = []
  for (const w of WEIGHTS) {
    const preds = predictAtWeight(validationRows, w, fields)
    const ev = evalBinaryPredictions(preds)
    const perSeason = VALIDATION_SEASONS.map((s) => evalBinaryPredictions(preds.filter((r) => r.season === s)))
    const delta = ev.logloss - baselineEv.logloss
    weightResults.push({ weight: w, ev, perSeason, delta, preds })
    console.log(
      `${(w * 100).toFixed(0)}%`.padEnd(10) + fmtPct(ev.accuracy).padEnd(10) + fmt4(ev.brier).padEnd(9) + fmt4(ev.logloss).padEnd(9)
      + perSeason.map((m) => fmt4(m?.logloss)).map((s) => s.padEnd(9)).join('')
      + (delta >= 0 ? '+' : '') + delta.toFixed(4),
    )
  }

  console.log('\nRobustheit - paariger Bootstrap (500 Resamples) ggü. weight=0%:')
  for (const w of weightResults) {
    if (w.weight === 0) continue
    const bs = bootstrap(baselinePreds, w.preds)
    console.log(`  weight=${(w.weight * 100).toFixed(0)}%`.padEnd(14) + `meanΔ=${bs.mean.toFixed(4)}  90%-CI=[${bs.p05.toFixed(4)}, ${bs.p95.toFixed(4)}]  Anteil Resamples mit Vorteil=${(bs.fracBetter * 100).toFixed(0)}%`)
  }

  return { validationGames: validationRows.length, gamesWithRatingDiff: withAdj.length, weightResults }
}

function main() {
  console.log('PHASE 3 - RE-BACKTEST DER TATSÄCHLICH IMPLEMENTIERTEN PRODUKTIONSFORMEL')
  console.log('(src/playerRating.js + src/playerRatingAdjustment.js + src/elo.js::homeWinProbability - unverändert importiert)')
  const games = loadHistoricalGames()
  const allTeamIds = [...new Set(games.flatMap((g) => [g.homeTeamId, g.awayTeamId]))]
  const allTeams = allTeamIds.map((id) => ({ id }))
  console.log(`Games: ${games.length} (${games[0].season}-${games[games.length - 1].season}), Teams: ${allTeams.length}`)
  console.log(`Validation seasons: ${VALIDATION_SEASONS.join(', ')}`)

  console.log('\n[1/2] Walk-forward EXAKT wie Phase 1 aktuell verdrahtet ist (KEIN playerHistoryData, siehe src/playoffSim.js)...')
  let t0 = Date.now()
  const rowsNoCareer = runProductionFormulaWalk(games, allTeams, { useCareerData: false })
  console.log(`Done in ${Date.now() - t0}ms`)
  const resultNoCareer = reportVariant('VARIANTE 1: WIE AKTUELL PRODUKTIV VERDRAHTET (kein playerHistoryData)', rowsNoCareer)

  console.log('\n[2/2] Walk-forward MIT Karriere-Anker (playerHistoryData aus den jeweils VORHERIGEN Archiv-Saisons, leak-frei) - testet die Hypothese, ob die fehlende Karriere-Verankerung die Ursache für den Effekt-Unterschied ist...')
  t0 = Date.now()
  const rowsWithCareer = runProductionFormulaWalk(games, allTeams, { useCareerData: true })
  console.log(`Done in ${Date.now() - t0}ms`)
  const resultWithCareer = reportVariant('VARIANTE 2: MIT KARRIERE-ANKER (playerHistoryData verdrahtet, testweise)', rowsWithCareer)

  console.log('\n[3/4] Walk-forward mit DIAGNOSE-Variante (F/D getrennt gemittelt, fix 60/40 kombiniert - NICHT die Produktionsformel, testet die Ursachen-Hypothese)...')
  t0 = Date.now()
  const rowsDiag = runProductionFormulaWalk(games, allTeams, { useCareerData: false, diagnosticMode: 'fd' })
  console.log(`Done in ${Date.now() - t0}ms`)
  const resultDiag = reportVariant('VARIANTE 3 (DIAGNOSE, NICHT Produktionscode): F/D getrennt gemittelt, 60/40 kombiniert', rowsDiag, ['rawDiagAdjHome', 'rawDiagAdjAway'])

  console.log('\n[4/4] Walk-forward OHNE specialTeams-Kategorie (deren Gewicht geht in usage auf, identisch zu HIST_TOP_WEIGHTS im explorativen Backtest - NICHT die Produktionsformel, testet die Datenvollständigkeits-Hypothese)...')
  t0 = Date.now()
  const rowsNoST = runProductionFormulaWalk(games, allTeams, { useCareerData: false, diagnosticMode: 'noSpecialTeams' })
  console.log(`Done in ${Date.now() - t0}ms`)
  const resultNoST = reportVariant('VARIANTE 4 (DIAGNOSE, NICHT Produktionscode): OHNE specialTeams (Gewicht in usage gefaltet)', rowsNoST, ['rawDiagAdjHome', 'rawDiagAdjAway'])

  console.log('\n' + '-'.repeat(92))
  console.log('VERGLEICH ZUM EXPLORATIVEN BACKTEST (backtest-player-rating-integration.js)')
  console.log('-'.repeat(92))
  try {
    const explorative = JSON.parse(fs.readFileSync(path.join(__dirname, 'backtest-player-rating-integration-result.json'), 'utf8'))
    console.log('  weight   explorativ   ohne Karriere   mit Karriere   F/D 60/40   ohne specialTeams')
    for (const w of explorative.weights) {
      const matchLabel = w.label.match(/ELO (\d+)%/)
      const eloPct = matchLabel ? Number(matchLabel[1]) : null
      const ratingWeight = eloPct != null ? (100 - eloPct) / 100 : null
      const noCareer = resultNoCareer.weightResults.find((x) => Math.abs(x.weight - ratingWeight) < 0.001)
      const withCareer = resultWithCareer.weightResults.find((x) => Math.abs(x.weight - ratingWeight) < 0.001)
      const diag = resultDiag.weightResults.find((x) => Math.abs(x.weight - ratingWeight) < 0.001)
      const noST = resultNoST.weightResults.find((x) => Math.abs(x.weight - ratingWeight) < 0.001)
      if (!noCareer || !withCareer || !diag || !noST) continue
      console.log(`  ${(ratingWeight * 100).toFixed(0)}%`.padEnd(9) + `${w.deltaLogloss.toFixed(4)}`.padEnd(13) + `${noCareer.delta.toFixed(4)}`.padEnd(16) + `${withCareer.delta.toFixed(4)}`.padEnd(15) + `${diag.delta.toFixed(4)}`.padEnd(12) + `${noST.delta.toFixed(4)}`)
    }
  } catch (e) {
    console.log('  (kein explorativer Ergebnis-JSON gefunden, Vergleich übersprungen)')
  }

  const outPath = path.join(__dirname, 'backtest-player-rating-production-formula-result.json')
  fs.writeFileSync(outPath, JSON.stringify({
    validationSeasons: VALIDATION_SEASONS,
    withoutCareerData: { validationGames: resultNoCareer.validationGames, gamesWithRatingDiff: resultNoCareer.gamesWithRatingDiff, weights: resultNoCareer.weightResults.map((w) => ({ weight: w.weight, overall: w.ev, deltaLogloss: w.delta })) },
    withCareerData: { validationGames: resultWithCareer.validationGames, gamesWithRatingDiff: resultWithCareer.gamesWithRatingDiff, weights: resultWithCareer.weightResults.map((w) => ({ weight: w.weight, overall: w.ev, deltaLogloss: w.delta })) },
    diagnosticFDSeparated: { validationGames: resultDiag.validationGames, gamesWithRatingDiff: resultDiag.gamesWithRatingDiff, weights: resultDiag.weightResults.map((w) => ({ weight: w.weight, overall: w.ev, deltaLogloss: w.delta })) },
    diagnosticNoSpecialTeams: { validationGames: resultNoST.validationGames, gamesWithRatingDiff: resultNoST.gamesWithRatingDiff, weights: resultNoST.weightResults.map((w) => ({ weight: w.weight, overall: w.ev, deltaLogloss: w.delta })) },
  }, null, 2))
  console.log(`\nDetails gespeichert: ${outPath}`)
}

main()
