// ---------------------------------------------------------------------------
// Player-Rating-Backtest - KERN-MODUL (reine Funktionen, kein Skript-Output).
// Getrennt vom Report-Skript (server/scripts/backtest-player-rating.js),
// damit die Rekonstruktions-/Rating-/Leakage-Logik automatisiert getestet
// werden kann (Auftrag Punkt 15), analog zum bestehenden Muster
// server/scripts/backtest-elo.js (das src/elo.js ebenfalls NICHT importiert,
// sondern die Formel read-only repliziert - hier identisch: src/elo.js und
// src/playerRating.js bleiben UNVERÄNDERT, ihre Gewichte werden aber, wo
// sinnvoll, wiederverwendet statt neu erfunden, siehe unten).
//
// ============================================================================
// DATENLAGE (Auftrag Punkt 1/8) - WICHTIGER, im Vorfeld nicht erwarteter Fund:
// ============================================================================
// server/data/historical/*.json (9 Saisons 2017/18-2025/26) enthält PRO SPIEL
// ein volles Skater-Boxscore (`game.players.home/away[]`): goals, assists,
// points, plusMinus, shotsOnGoal, blockings, faceoffsWon/Lost, timeOnIce,
// timeOnIcePp, timeOnIcePk - für ALLE 9 Saisons zu 100% (Spielanzahl-Check),
// NICHT nur für neuere Jahre. Torhüter analog (`game.goalies.home/away[]`):
// goalsAgainst, saves, shotsAgainst, secondsPlayed.
//
// NICHT historisch vorhanden: xG (existiert nachweislich erst seit dem
// NL-Detail-Sync dieser Saison, siehe src/playerRating.js). Das bestätigt
// Auftrag Punkt 8 NUR für xG, nicht für Faceoffs/PP-PK-TOI (die sind entgegen
// der Erwartung im Auftrag bereits historisch vorhanden).
//
// Spieler-Identität: `game.roster[]` liefert (id=SIHF-Lizenznummer,
// fullName, jerseyNumber, teamId) - Join zu `players.home/away[].playerNumber`
// über (teamId, jerseyNumber) ist 1:1 (Stichprobenprüfung: 20/20 gematcht,
// siehe Bericht). `playerPosition` je Boxscore-Zeile liefert "Stürmer"/
// "Verteidiger" - JE SPIEL, nicht aus einem separaten, ggf. nicht mehr
// aktuellen Kaderfeld übernommen.
//
// Die AKTUELLE Saison (db.json) hat bislang nur 7 abgeschlossene Spiele,
// ALLE am selben Kalendertag (Saisonstart) - es existiert also noch KEIN
// einziger leak-freier "Spiel N -> Spiel N+1"-Übergang für einen Spieler
// dieser Saison. Sie wird daher NICHT in den Outcome-/Korrelations-Backtest
// einbezogen (siehe Bericht) - das ist keine Vereinfachung, sondern eine
// Konsequenz der Datenlage: mit nur einem Zeitpunkt lässt sich per
// Definition keine "spätere Leistung" leak-frei prüfen.
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const HISTORICAL_DIR = path.join(__dirname, 'data', 'historical')

export const SEASON_FILES = [
  '2017-18', '2018-19', '2019-20', '2020-21', '2021-22',
  '2022-23', '2023-24', '2024-25', '2025-26',
]
export const CORONA_SEASONS = new Set(['2019/20', '2020/21'])

// ============================================================================
// PARSING-HILFSFUNKTIONEN
// ============================================================================

export function num(v) {
  if (v == null || v === '' || v === '-') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// "mm:ss" (auch > 60 Min. bei mehrfacher OT möglich) -> Sekunden. null bei
// fehlendem/leerem Wert (KEIN künstlicher 0 - ein Spieler ohne erfasste
// TOI ist etwas anderes als ein Spieler mit 0 Sekunden Eiszeit).
export function parseTimeToSeconds(v) {
  if (v == null || v === '' || v === '-') return null
  const m = /^(\d+):(\d{2})$/.exec(String(v).trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

// ============================================================================
// 1. ROHDATEN LADEN + VEREINHEITLICHEN
// ============================================================================
// Ergebnis: chronologisches Array von "unified games" - jedes mit
// { date, season, corona, homeTeamId, awayTeamId, homeGoals, awayGoals,
//   decision, skaters: [...], goalies: [...] }
// `teamId` = SIHF-Team-ID (stabil über alle 9 Saisons, siehe backtest-elo.js -
// dieselbe Konvention, KEIN Versuch, auf die aktuellen lokalen db.json-
// Team-IDs zu mappen, da diese Analyse eigenständig auf dem Archiv arbeitet).
// ============================================================================

export function loadHistoricalGames({ dir = HISTORICAL_DIR, seasonFiles = SEASON_FILES } = {}) {
  const games = []
  for (const f of seasonFiles) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f + '.json'), 'utf8'))
    for (const g of raw.games) {
      if (!g.players || !g.roster) continue // defensiv - sollte laut Stichprobe nie zutreffen
      const rosterById = new Map(g.roster.map((r) => [`${r.teamId}#${r.jerseyNumber}`, r]))
      const skaters = []
      for (const side of ['home', 'away']) {
        const teamId = side === 'home' ? g.homeTeam.sihfId : g.awayTeam.sihfId
        for (const p of g.players[side] || []) {
          const rosterEntry = rosterById.get(`${teamId}#${p.playerNumber}`)
          if (!rosterEntry) continue // kein sicherer Identitäts-Join möglich -> auslassen, nicht raten
          skaters.push({
            playerId: rosterEntry.id,
            name: rosterEntry.fullName,
            teamId,
            isHome: side === 'home',
            position: p.playerPosition === 'Stürmer' ? 'F' : p.playerPosition === 'Verteidiger' ? 'D' : null,
            goals: num(p.goals) ?? 0,
            assists: num(p.assists) ?? 0,
            points: num(p.points) ?? ((num(p.goals) ?? 0) + (num(p.assists) ?? 0)),
            plusMinus: num(p.plusMinus) ?? 0,
            sog: num(p.shotsOnGoal),
            blockedShots: num(p.blockings),
            faceoffsWon: num(p.faceoffsWon),
            faceoffsLost: num(p.faceoffsLost),
            toiSec: parseTimeToSeconds(p.timeOnIce),
            ppToiSec: parseTimeToSeconds(p.timeOnIcePp),
            pkToiSec: parseTimeToSeconds(p.timeOnIcePk),
          })
        }
      }
      const goalies = []
      for (const side of ['home', 'away']) {
        const teamId = side === 'home' ? g.homeTeam.sihfId : g.awayTeam.sihfId
        for (const p of g.goalies?.[side] || []) {
          const rosterEntry = rosterById.get(`${teamId}#${p.playerNumber}`)
          if (!rosterEntry) continue
          const toiSec = parseTimeToSeconds(p.secondsPlayed)
          if (!toiSec) continue // 0/unbekannte TOI = nicht eingesetzt, zählt nicht als Einsatz
          goalies.push({
            playerId: rosterEntry.id,
            name: rosterEntry.fullName,
            teamId,
            isHome: side === 'home',
            goalsAgainst: num(p.goalsAgainst) ?? 0,
            saves: num(p.saves) ?? 0,
            shotsAgainst: num(p.shotsAgainst) ?? 0,
            toiSec,
          })
        }
      }
      games.push({
        gameId: g.gameId,
        date: g.date,
        dt: g.startDateTime || g.date,
        season: g.season,
        corona: CORONA_SEASONS.has(g.season),
        homeTeamId: g.homeTeam.sihfId,
        awayTeamId: g.awayTeam.sihfId,
        homeGoals: g.homeGoals,
        awayGoals: g.awayGoals,
        decision: g.decision,
        skaters,
        goalies,
      })
    }
  }
  games.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0))
  return games
}

// ============================================================================
// 2. LEAK-FREIE, LAUFENDE SPIELER-ZUSTÄNDE (Career + aktuelle Saison + Log
//    für Rolling-Form) - ZENTRALE Stelle für den Data-Leakage-Schutz (Auftrag
//    Punkt 12/15): `snapshotRates()` darf NUR auf state zugreifen, der VOR
//    dem aktuellen Spiel bereits aktualisiert wurde; `updateWithGame()` wird
//    für jedes Spiel IMMER ERST NACH der Prognose/dem Rating-Snapshot
//    aufgerufen (siehe runBacktest() unten - identisches Muster wie
//    server/scripts/backtest-elo.js::simulate()).
// ============================================================================

function emptyAccum() {
  return {
    gp: 0, goals: 0, assists: 0, points: 0, plusMinus: 0,
    sog: 0, hasSog: false, blockedShots: 0, hasBlocks: false,
    toiSec: 0, hasToi: false, ppToiSec: 0, hasPpToi: false, pkToiSec: 0, hasPkToi: false,
    faceoffsWon: 0, faceoffsLost: 0, hasFaceoffs: false,
  }
}

export function createSkaterTracker() {
  return { career: new Map(), season: new Map(), currentSeason: new Map(), log: new Map(), lastPosition: new Map() }
}

function accumRates(a) {
  if (!a || a.gp === 0) return null
  const gp = a.gp
  return {
    gp,
    pointsPerGame: a.points / gp,
    goalsPerGame: a.goals / gp,
    assistsPerGame: a.assists / gp,
    plusMinusPerGame: a.plusMinus / gp,
    sogPerGame: a.hasSog ? a.sog / gp : null,
    blockedShotsPerGame: a.hasBlocks ? a.blockedShots / gp : null,
    toiPerGame: a.hasToi ? a.toiSec / gp : null,
    ppToiPerGame: a.hasPpToi ? a.ppToiSec / gp : null,
    pkToiPerGame: a.hasPkToi ? a.pkToiSec / gp : null,
    faceoffPercentage: a.hasFaceoffs && (a.faceoffsWon + a.faceoffsLost) > 0 ? a.faceoffsWon / (a.faceoffsWon + a.faceoffsLost) : null,
  }
}

// Snapshot der VOR diesem Spiel bekannten Career-/Saison-/Form-Raten eines
// Skaters - reiner Lesezugriff, keine Mutation.
export function snapshotSkaterRates(tracker, playerIdRaw, season) {
  // playerId auf String normalisiert (Map-Lookups sind typsensitiv - ein
  // playerId kann je nach Aufrufer als Number oder als aus einem
  // zusammengesetzten Key gesplitteter String hereinkommen, siehe
  // Regressions-Fund im Backtest-Skript: ohne diese Normalisierung liefert
  // ein String-Aufruf lautlos `position: null`/leere Historie statt eines
  // Fehlers, was die gesamte Baseline unbemerkt leerlaufen liess).
  const playerId = String(playerIdRaw)
  const career = accumRates(tracker.career.get(playerId))
  const seasonAccum = tracker.season.get(`${playerId}#${season}`)
  const seasonRates = accumRates(seasonAccum)
  const log = tracker.log.get(playerId) || []
  const formN = log.length >= 10 ? 10 : log.length >= 5 ? 5 : 0
  let form = null
  if (formN > 0) {
    const windowAccum = emptyAccum()
    for (const entry of log.slice(-formN)) mergeInto(windowAccum, entry)
    form = accumRates(windowAccum)
  }
  return {
    career, season: seasonRates, form,
    position: tracker.lastPosition.get(playerId) || null,
  }
}

function mergeInto(accum, row) {
  accum.gp += 1
  accum.goals += row.goals; accum.assists += row.assists; accum.points += row.points; accum.plusMinus += row.plusMinus
  if (row.sog != null) { accum.sog += row.sog; accum.hasSog = true }
  if (row.blockedShots != null) { accum.blockedShots += row.blockedShots; accum.hasBlocks = true }
  if (row.toiSec != null) { accum.toiSec += row.toiSec; accum.hasToi = true }
  if (row.ppToiSec != null) { accum.ppToiSec += row.ppToiSec; accum.hasPpToi = true }
  if (row.pkToiSec != null) { accum.pkToiSec += row.pkToiSec; accum.hasPkToi = true }
  if (row.faceoffsWon != null && row.faceoffsLost != null) { accum.faceoffsWon += row.faceoffsWon; accum.faceoffsLost += row.faceoffsLost; accum.hasFaceoffs = true }
}

// Aktualisiert den Zustand MIT diesem Spiel - darf erst NACH dem Snapshot für
// dieses Spiel aufgerufen werden (siehe Kommentar oben).
export function updateSkaterTracker(tracker, row, season) {
  const playerId = String(row.playerId) // siehe Normalisierungs-Kommentar in snapshotSkaterRates()
  if (!tracker.career.has(playerId)) tracker.career.set(playerId, emptyAccum())
  mergeInto(tracker.career.get(playerId), row)
  const seasonKey = `${playerId}#${season}`
  if (!tracker.season.has(seasonKey)) tracker.season.set(seasonKey, emptyAccum())
  mergeInto(tracker.season.get(seasonKey), row)
  if (!tracker.log.has(playerId)) tracker.log.set(playerId, [])
  tracker.log.get(playerId).push(row)
  if (row.position) tracker.lastPosition.set(playerId, row.position)
}

// --- Torhüter: analoges, aber eigenständiges Tracking (andere Metriken) ---

function emptyGoalieAccum() { return { gp: 0, saves: 0, goalsAgainst: 0, shotsAgainst: 0, toiSec: 0 } }
function goalieRates(a) {
  if (!a || a.gp === 0 || a.shotsAgainst === 0) return null
  return { gp: a.gp, savePct: a.saves / a.shotsAgainst, gaa: a.goalsAgainst / a.gp, toiPerGame: a.toiSec / a.gp }
}

export function createGoalieTracker() { return { career: new Map(), season: new Map(), log: new Map() } }

export function snapshotGoalieRates(tracker, playerIdRaw, season) {
  const playerId = String(playerIdRaw) // siehe Normalisierungs-Kommentar in snapshotSkaterRates()
  const career = goalieRates(tracker.career.get(playerId))
  const seasonRates = goalieRates(tracker.season.get(`${playerId}#${season}`))
  const log = tracker.log.get(playerId) || []
  const formN = log.length >= 10 ? 10 : log.length >= 5 ? 5 : 0
  let form = null
  if (formN > 0) {
    const w = emptyGoalieAccum()
    for (const row of log.slice(-formN)) { w.gp++; w.saves += row.saves; w.goalsAgainst += row.goalsAgainst; w.shotsAgainst += row.shotsAgainst; w.toiSec += row.toiSec }
    form = goalieRates(w)
  }
  return { career, season: seasonRates, form }
}

export function updateGoalieTracker(tracker, row, season) {
  const playerId = String(row.playerId) // siehe Normalisierungs-Kommentar in snapshotSkaterRates()
  if (!tracker.career.has(playerId)) tracker.career.set(playerId, emptyGoalieAccum())
  const c = tracker.career.get(playerId)
  c.gp++; c.saves += row.saves; c.goalsAgainst += row.goalsAgainst; c.shotsAgainst += row.shotsAgainst; c.toiSec += row.toiSec
  const seasonKey = `${playerId}#${season}`
  if (!tracker.season.has(seasonKey)) tracker.season.set(seasonKey, emptyGoalieAccum())
  const s = tracker.season.get(seasonKey)
  s.gp++; s.saves += row.saves; s.goalsAgainst += row.goalsAgainst; s.shotsAgainst += row.shotsAgainst; s.toiSec += row.toiSec
  if (!tracker.log.has(playerId)) tracker.log.set(playerId, [])
  tracker.log.get(playerId).push(row)
}

// ============================================================================
// 3. POSITIONS-BASELINE (pro eindeutigem Datum neu gebaut, NUR aus Zuständen
//    VOR diesem Datum - siehe runBacktest()). Gleiche Methode/Schwelle wie
//    src/playerRating.js (z-Score ggü. Mittel/Std, MIN_N-Schwelle) - hier
//    lokal repliziert (andere Datenform: state-Snapshots statt game.playerStats).
// ============================================================================

export const SKATER_MIN_N = 20
export const GOALIE_MIN_N = 6
const SKATER_RATE_KEYS = ['pointsPerGame', 'goalsPerGame', 'assistsPerGame', 'plusMinusPerGame', 'sogPerGame', 'blockedShotsPerGame', 'toiPerGame', 'ppToiPerGame', 'pkToiPerGame', 'faceoffPercentage']
const GOALIE_RATE_KEYS = ['savePct', 'gaa', 'toiPerGame']

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null }
function stdDev(a, m) { return a.length ? Math.sqrt(mean(a.map((v) => (v - m) ** 2))) || 1 : 1 }

export function buildSkaterBaselineFromRates(ratesByPosition) {
  const out = {}
  for (const pos of ['F', 'D']) {
    const rows = ratesByPosition[pos] || []
    out[pos] = { n: rows.length }
    for (const key of SKATER_RATE_KEYS) {
      const vals = rows.map((r) => r[key]).filter((v) => v != null)
      const m = mean(vals)
      out[pos][key] = { mean: m ?? 0, std: stdDev(vals, m ?? 0), n: vals.length }
    }
  }
  return out
}

export function buildGoalieBaselineFromRates(rows) {
  const out = { n: rows.length }
  for (const key of GOALIE_RATE_KEYS) {
    const vals = rows.map((r) => r[key]).filter((v) => v != null)
    const m = mean(vals)
    out[key] = { mean: m ?? 0, std: stdDev(vals, m ?? 0), n: vals.length }
  }
  return out
}

// ============================================================================
// 4. RATING-FORMEL (repliziert src/playerRating.js - hier auf die Archiv-
//    Datenform angewendet, KEIN xG/PP-Tore/SH-Punkte, da im Archiv nicht auf
//    Situations-Ebene vorliegend, siehe Bericht). Gewichte werden 1:1 aus
//    src/playerRating.js importiert (RATING_BLEND_WEIGHTS/SKATER_TOP_WEIGHTS),
//    NICHT neu erfunden - dieselbe heuristische Initialgewichtung wie im
//    produktiven Modul.
// ============================================================================

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
function zOf(value, baselineEntry, minN, clampAbs = 3) {
  if (value == null || !baselineEntry || baselineEntry.n < minN) return null
  return clamp((value - baselineEntry.mean) / baselineEntry.std, -clampAbs, clampAbs)
}
function weightedZ(rates, baseline, weightedKeys, minN) {
  let wSum = 0, zSum = 0, used = 0
  for (const [key, weight, clampAbs] of weightedKeys) {
    const z = zOf(rates?.[key], baseline?.[key], minN, clampAbs ?? 3)
    if (z == null) continue
    zSum += z * weight; wSum += weight; used++
  }
  return used === 0 ? null : { z: zSum / wSum, used }
}
function weightedAvg(pairs) {
  let wSum = 0, vSum = 0
  for (const [v, w] of pairs) { if (v == null || !(w > 0)) continue; vSum += v * w; wSum += w }
  return wSum > 0 ? vSum / wSum : null
}
export function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp((-z * z) / 2)
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z > 0 ? 1 - p : p
}
function zTo100(z) { return z == null ? null : Math.round(normalCdf(z) * 1000) / 10 }

export const HIST_BLEND_WEIGHTS = [
  { maxGp: 0, career: 1.00, current: 0.00, form: 0.00 },
  { maxGp: 4, career: 0.75, current: 0.25, form: 0.00 },
  { maxGp: 9, career: 0.45, current: 0.35, form: 0.20 },
  { maxGp: Infinity, career: 0.25, current: 0.50, form: 0.25 },
]
export const HIST_TOP_WEIGHTS = {
  F: { offense: 0.40, defense: 0.15, usage: 0.45 }, // kein specialTeams-Bucket separat, siehe unten (nur PP/PK-TOI verfügbar -> in usage)
  D: { offense: 0.20, defense: 0.35, usage: 0.45 },
}
function blendWeightsForGp(gp, table = HIST_BLEND_WEIGHTS) {
  for (const row of table) if (gp <= row.maxGp) return row
  return table[table.length - 1]
}

// Sub-Rating-Schlüssel-Listen - per `overrides` austauschbar (Ablation-Test,
// Auftrag Punkt 10: z.B. ohne 'sogPerGame' aufrufen).
export const DEFAULT_SKATER_KEYS = {
  offense: [['pointsPerGame', 1], ['goalsPerGame', 1], ['assistsPerGame', 1], ['sogPerGame', 1]],
  defense: [['plusMinusPerGame', 1], ['blockedShotsPerGame', 1], ['pkToiPerGame', 1]],
  usage: [['toiPerGame', 1], ['ppToiPerGame', 1], ['pkToiPerGame', 1], ['faceoffPercentage', 0.5]],
  form: [['pointsPerGame', 1], ['sogPerGame', 1], ['toiPerGame', 1]],
}

// `keys`/`topWeights`/`blendTable` optional überschreibbar - Grundlage für
// Ablation-Test (Punkt 10) und Gewichts-Varianten-Vergleich (Punkt 9), ohne
// den Kern zu duplizieren.
export function computeHistSkaterRating(snapshot, baseline, options = {}) {
  const keys = options.keys || DEFAULT_SKATER_KEYS
  const topWeights = options.topWeights || HIST_TOP_WEIGHTS
  const blendTable = options.blendTable || HIST_BLEND_WEIGHTS
  const minN = options.minN ?? SKATER_MIN_N
  const pos = snapshot.position
  if (pos !== 'F' && pos !== 'D') return null
  const posBaseline = baseline[pos]
  const w = topWeights[pos]

  const offense = snapshot.season ? weightedZ(snapshot.season, posBaseline, keys.offense, minN) : null
  const defense = snapshot.season ? weightedZ(snapshot.season, posBaseline, keys.defense, minN) : null
  const usage = snapshot.season ? weightedZ(snapshot.season, posBaseline, keys.usage, minN) : null
  const formZ = snapshot.form ? weightedZ(snapshot.form, posBaseline, keys.form, minN) : null

  const currentZ = weightedAvg([[offense?.z, w.offense], [defense?.z, w.defense], [usage?.z, w.usage]])

  let careerZ = null
  if (snapshot.career && snapshot.career.gp >= 20) {
    const co = weightedZ(snapshot.career, posBaseline, keys.offense, minN)
    const cd = weightedZ(snapshot.career, posBaseline, keys.defense, minN)
    const cu = weightedZ(snapshot.career, posBaseline, keys.usage, minN)
    careerZ = weightedAvg([[co?.z, w.offense], [cd?.z, w.defense], [cu?.z, w.usage]])
  }

  const gp = snapshot.season?.gp ?? 0
  const weights = blendWeightsForGp(gp, blendTable)
  const overallZ = weightedAvg([[careerZ, weights.career], [currentZ, weights.current], [formZ?.z, weights.form]])

  const availableComponents = [offense, defense, usage, formZ].filter((c) => c != null).length
  const currentGp = gp, careerGp = snapshot.career?.gp ?? 0
  const confidence = Math.round(clamp(
    clamp(currentGp / 10, 0, 1) * 0.40 + clamp(careerGp / 60, 0, 1) * 0.35 + (availableComponents / 4) * 0.25,
    0, 1,
  ) * 1000) / 10

  return {
    overall: zTo100(overallZ), overallZ, confidence,
    offense: zTo100(offense?.z), defense: zTo100(defense?.z), usage: zTo100(usage?.z), form: zTo100(formZ?.z),
    careerOnly: zTo100(careerZ), currentOnly: zTo100(currentZ),
    sampleSize: { currentSeasonGp: currentGp, careerGp },
    position: pos,
  }
}

export function computeHistGoalieRating(snapshot, baseline, options = {}) {
  const minN = options.minN ?? GOALIE_MIN_N
  const blendTable = options.blendTable || HIST_BLEND_WEIGHTS
  const composite = (r) => {
    if (!r) return null
    const zSv = zOf(r.savePct, baseline.savePct, minN)
    const zGaa = zOf(r.gaa, baseline.gaa, minN)
    const comps = []
    if (zSv != null) comps.push(zSv)
    if (zGaa != null) comps.push(-zGaa)
    return comps.length ? mean(comps) : null
  }
  const seasonZ = composite(snapshot.season)
  const careerZ = snapshot.career && snapshot.career.gp >= 10 ? composite(snapshot.career) : null
  const formZ = composite(snapshot.form)
  const usageZ = snapshot.season ? zOf(snapshot.season.toiPerGame, baseline.toiPerGame, minN) : null

  const gp = snapshot.season?.gp ?? 0
  const weights = blendWeightsForGp(gp, blendTable)
  const overallZ = weightedAvg([[careerZ, weights.career], [seasonZ, weights.current], [formZ, weights.form]])
  const availableComponents = [seasonZ, usageZ, formZ].filter((v) => v != null).length
  const careerGp = snapshot.career?.gp ?? 0
  const confidence = Math.round(clamp(
    clamp(gp / 10, 0, 1) * 0.40 + clamp(careerGp / 60, 0, 1) * 0.35 + (availableComponents / 3) * 0.25,
    0, 1,
  ) * 1000) / 10

  return {
    overall: zTo100(overallZ), overallZ, confidence,
    defense: zTo100(seasonZ), usage: zTo100(usageZ), form: zTo100(formZ),
    sampleSize: { currentSeasonGp: gp, careerGp }, position: 'G',
  }
}

// ============================================================================
// 5. LEAK-FREIES ELO (repliziert server/scripts/backtest-elo.js BASELINE_PARAMS
//    - identische Formel/Parameter wie das bereits kalibrierte, PRODUKTIVE
//    ELO in src/elo.js, hier nur lokal nachgebaut, da src/elo.js auf dem
//    LIVE-Datenmodell (lokale Team-IDs) arbeitet, dieses Modul aber auf dem
//    Archiv (SIHF-IDs) - NICHT verändert, NICHT neu kalibriert.)
// ============================================================================

export const ELO_BASELINE = { kBase: 24, homeAdv: 50, goalDiffFactor: 0.5, regressionFraction: 0 }
function kTiers(kBase) {
  const s = kBase / 24
  return [{ maxGames: 5, k: 32 * s }, { maxGames: 15, k: 28 * s }, { maxGames: 30, k: 24 * s }, { maxGames: 50, k: 20 * s }, { maxGames: Infinity, k: 16 * s }]
}
function getK(tiers, gp) { for (const t of tiers) if (gp <= t.maxGames) return t.k; return tiers[tiers.length - 1].k }
function goalDiffMult(diff, factor) { if (diff === 0 || factor === 0) return 1; return 1 + factor * (Math.log(diff + 1) - 1) }

// `onGame(game, eloHomeBefore, eloAwayBefore)` wird PRO SPIEL VOR dem
// ELO-Update aufgerufen (Hook für den kombinierten Backtest unten) - so bleibt
// diese Funktion die EINZIGE Stelle, die ELO aktualisiert (kein Leck möglich).
export function runLeakFreeElo(games, params = ELO_BASELINE, onGame) {
  const tiers = kTiers(params.kBase)
  const ratings = new Map(), gamesPlayed = new Map()
  let currentSeason = null
  for (const g of games) {
    if (currentSeason !== null && g.season !== currentSeason) {
      for (const [id, r] of ratings) ratings.set(id, 1500 + (r - 1500) * (1 - params.regressionFraction))
    }
    currentSeason = g.season
    const rh = ratings.get(g.homeTeamId) ?? 1500
    const ra = ratings.get(g.awayTeamId) ?? 1500
    const gpH = gamesPlayed.get(g.homeTeamId) ?? 0
    const gpA = gamesPlayed.get(g.awayTeamId) ?? 0
    const pHome = 1 / (1 + Math.pow(10, (ra - (rh + params.homeAdv)) / 400))
    if (onGame) onGame(g, rh, ra, pHome)
    const homeWon = g.homeGoals > g.awayGoals
    const diff = Math.abs(g.homeGoals - g.awayGoals)
    const goalMult = goalDiffMult(diff, params.goalDiffFactor)
    const scoreH = homeWon ? 1 : 0
    const kH = getK(tiers, gpH), kA = getK(tiers, gpA)
    ratings.set(g.homeTeamId, rh + kH * goalMult * (scoreH - pHome))
    ratings.set(g.awayTeamId, ra + kA * goalMult * ((1 - scoreH) - (1 - pHome)))
    gamesPlayed.set(g.homeTeamId, gpH + 1)
    gamesPlayed.set(g.awayTeamId, gpA + 1)
  }
}

// ============================================================================
// 6. EINFACHE, DEPENDENCY-FREIE LOGISTISCHE REGRESSION (für Model B/C - siehe
//    Bericht Punkt 5/9: bewusst wenige Parameter (Intercept + 1-2 Gewichte),
//    Gradient Descent, NUR auf den TRAIN-Spielen gefittet, NIE auf denselben
//    Daten getestet - kein "brutales Overfitting" möglich bei <=3 Parametern.
// ============================================================================

export function fitLogistic(features, labels, { epochs = 2000, lr = 0.05, l2 = 0.001 } = {}) {
  const nFeat = features[0]?.length ?? 0
  let weights = new Array(nFeat).fill(0)
  let bias = 0
  const n = features.length
  if (n === 0) return { weights, bias }
  for (let e = 0; e < epochs; e++) {
    const gradW = new Array(nFeat).fill(0)
    let gradB = 0
    for (let i = 0; i < n; i++) {
      const x = features[i]
      let z = bias
      for (let j = 0; j < nFeat; j++) z += weights[j] * x[j]
      const p = 1 / (1 + Math.exp(-z))
      const err = p - labels[i]
      for (let j = 0; j < nFeat; j++) gradW[j] += err * x[j]
      gradB += err
    }
    for (let j = 0; j < nFeat; j++) weights[j] -= lr * (gradW[j] / n + l2 * weights[j])
    bias -= lr * (gradB / n)
  }
  return { weights, bias }
}

export function predictLogistic(model, x) {
  let z = model.bias
  for (let j = 0; j < x.length; j++) z += model.weights[j] * x[j]
  return 1 / (1 + Math.exp(-z))
}

// ============================================================================
// 7. METRIKEN (identisches Prinzip wie backtest-elo.js::evalResults)
// ============================================================================

export function evalBinaryPredictions(rows) {
  // rows: [{ p, y }]
  if (rows.length === 0) return null
  const EPS = 1e-10
  let correct = 0, brier = 0, logloss = 0
  for (const { p: pRaw, y } of rows) {
    const p = Math.min(1 - EPS, Math.max(EPS, pRaw))
    if ((p >= 0.5 ? 1 : 0) === y) correct++
    brier += (p - y) ** 2
    logloss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p))
  }
  return { n: rows.length, accuracy: correct / rows.length, brier: brier / rows.length, logloss: logloss / rows.length }
}

export function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x != null && y != null && Number.isFinite(x) && Number.isFinite(y))
  const n = pairs.length
  if (n < 3) return null
  const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]))
  let num2 = 0, dx2 = 0, dy2 = 0
  for (const [x, y] of pairs) { num2 += (x - mx) * (y - my); dx2 += (x - mx) ** 2; dy2 += (y - my) ** 2 }
  const denom = Math.sqrt(dx2 * dy2)
  return denom > 0 ? { r: num2 / denom, n } : { r: 0, n }
}

export function mae(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x != null && y != null)
  if (pairs.length === 0) return null
  return mean(pairs.map(([x, y]) => Math.abs(x - y)))
}
export function rmse(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x != null && y != null)
  if (pairs.length === 0) return null
  return Math.sqrt(mean(pairs.map(([x, y]) => (x - y) ** 2)))
}

export { mean, stdDev }
