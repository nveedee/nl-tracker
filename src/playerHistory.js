// ---------------------------------------------------------------------------
// Historische Mehrsaison-Spielerdaten (Player Analytics: PlayerDetail.jsx,
// PlayerRankings.jsx). Reine Datenauswertung - kein Prognosemodell, keine
// erfundenen Werte, nichts hiervon fliesst in ELO/Power Ranking/Season
// Projections ein.
//
// Datenquelle: public/player-history.json - ein statischer, einmalig per
// server/scripts/generate-player-history.js generierter Export (siehe dort
// für die Herleitung: Spieler-Identität über die stabile SIHF-Lizenznummer
// innerhalb des Archivs, einmalige Namensverknüpfung zum aktuellen Kader,
// Saison-Totale können Playoff-Spiele enthalten, da regulär Saison/Playoffs
// im Archiv nicht zuverlässig unterscheidbar sind - siehe generatedAt/note
// im Export). Lazy per fetch geladen, nicht im Haupt-Bundle.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react'

let cache = null
export function usePlayerHistory() {
  const [data, setData] = useState(cache)
  useEffect(() => {
    if (cache) { setData(cache); return }
    let cancelled = false
    fetch('/player-history.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => { cache = json; if (!cancelled) setData(json) })
      .catch(() => { if (!cancelled) setData(null) })
    return () => { cancelled = true }
  }, [])
  return data // null = lädt noch (oder nicht verfügbar)
}

// Historie EINES Spielers (Array von Saison-Objekten, chronologisch), oder
// [] falls keine historischen Daten verknüpft werden konnten.
export function getPlayerSeasons(playerHistoryData, playerId) {
  return playerHistoryData?.players?.[playerId]?.seasons || []
}

function ppg(s) { return s.gp > 0 ? s.points / s.gp : null }
function gpg(s) { return s.gp > 0 ? s.goals / s.gp : null }
function apg(s) { return s.gp > 0 ? s.assists / s.gp : null }
function sogpg(s) { return s.gp > 0 ? s.sog / s.gp : null }
function toipg(s) { return s.gp > 0 ? s.toiSec / s.gp : null }
function pmpg(s) { return s.gp > 0 ? s.plusMinus / s.gp : null }

// Abgeleitete Pro-Spiel-Werte für eine einzelne Saison - null statt NaN/Inf
// bei gp=0.
export function seasonRates(s) {
  return { ppg: ppg(s), gpg: gpg(s), apg: apg(s), sogpg: sogpg(s), toipg: toipg(s), pmpg: pmpg(s) }
}

// Karriere-Zusammenfassung über alle verfügbaren historischen Saisons
// (Summe GP/Tore/Assists/Punkte, Karriere-P/GP, Anzahl Saisons, Anzahl
// unterschiedlicher Teams, beste Saison nach Punkten und nach P/GP - jeweils
// nur Saisons mit gp>0 berücksichtigt für die "beste Saison"-Ermittlung).
export function careerSummary(seasons) {
  if (!seasons || seasons.length === 0) return null
  let gp = 0, goals = 0, assists = 0, points = 0
  const teams = new Set()
  let bestByPoints = null, bestByPpg = null
  for (const s of seasons) {
    gp += s.gp; goals += s.goals; assists += s.assists; points += s.points
    if (s.teamId) teams.add(s.teamId)
    if (s.gp > 0) {
      if (!bestByPoints || s.points > bestByPoints.points) bestByPoints = s
      const rate = ppg(s)
      if (rate != null && (!bestByPpg || rate > ppg(bestByPpg))) bestByPpg = s
    }
  }
  return {
    gp, goals, assists, points,
    careerPpg: gp > 0 ? points / gp : null,
    seasonCount: seasons.length,
    teamCount: teams.size,
    bestByPoints, bestByPpg,
  }
}

// Bei einem Vereinswechsel WÄHREND einer Saison enthält der Export zwei
// separate Einträge für dieselbe Saison (ein Team-Stint je Team, siehe
// server/scripts/generate-player-history.js) - für die rohe Saison-Tabelle
// im Profil ist das gewünscht (zeigt den Wechsel transparent), für
// Saison-für-Saison-VERGLEICHE (Trend/YoY/letzte-N-Saisons) würde es sonst
// eine Saison fälschlich in zwei "Saisons" aufspalten. Fasst Einträge mit
// gleichem `season`-Wert zu einem kombinierten Saison-Total zusammen (Team =
// letzter Stint dieser Saison).
export function mergeSeasonSplits(seasons) {
  const bySeason = new Map()
  for (const s of seasons || []) {
    if (!bySeason.has(s.season)) {
      bySeason.set(s.season, { ...s })
    } else {
      const m = bySeason.get(s.season)
      m.gp += s.gp; m.goals += s.goals; m.assists += s.assists; m.points += s.points
      m.sog += s.sog; m.plusMinus += s.plusMinus; m.toiSec += s.toiSec
      m.teamId = s.teamId // letzter Stint der Saison
    }
  }
  return [...bySeason.values()]
}

// Jahr-über-Jahr-Entwicklung der Punkte/Spiel: vergleicht die JÜNGSTE mit
// gp>0 gespielte Saison gegen die davor. null, wenn keine zwei vergleichbaren
// Saisons vorhanden sind (z.B. Rookie, oder Vorjahr mit 0 Spielen).
// `minLatestGp` (optional, Default 0 = bisheriges Verhalten unverändert):
// Mindestspiele für die JÜNGSTE Saison, damit sie als Vergleichsbasis zählt -
// wichtig, sobald `seasons` die laufende Saison per buildCurrentSeasonRecord
// enthalten kann (dort z.B. TREND_MIN_LATEST_GP übergeben, damit ein
// einzelnes frühes Saisonspiel keine irreführend grosse %-Veränderung zeigt).
export function yoyDevelopment(seasons, minLatestGp = 0) {
  const played = mergeSeasonSplits(seasons).filter((s) => s.gp > 0)
  if (played.length < 2) return null
  const latest = played[played.length - 1]
  if (latest.gp < minLatestGp) return null
  const prev = played[played.length - 2]
  const latestPpg = ppg(latest), prevPpg = ppg(prev)
  if (latestPpg == null || prevPpg == null || prevPpg === 0) return null
  const pctChange = ((latestPpg - prevPpg) / prevPpg) * 100
  if (!Number.isFinite(pctChange)) return null
  return { latest, prev, latestPpg, prevPpg, pctChange }
}

// ---------------------------------------------------------------------------
// PLAYER IMPACT SCORE - positions-relative, datenbasierte Kaderstärke-
// Kennzahl. NICHT einfach Punkte gezählt (siehe Formel-Begründung unten).
//
// Herleitung/Validierung: server/scripts/analyze-player-impact-score.js hat
// 4 Varianten anhand von Jahr-zu-Jahr-Stabilität (Spearman-Rangkorrelation
// desselben Spielers zwischen aufeinanderfolgenden Saisons), Ausreisser-
// Abhängigkeit (Stabilität mit/ohne Top-1%-Extremwerte) und Positions-
// Fairness (Median-Differenz Stürmer/Verteidiger) verglichen:
//   V0 rohe P/GP:            Stabilität 0.740, Positions-Differenz 0.148 (unfair)
//   V1 P/60 (TOI-normiert):  Stabilität 0.517 (zu instabil)
//   V2 4er-Komposit (gewählt): Stabilität 0.740, Positions-Differenz 0.037
//   V3 3er-Komposit ohne SOG: Stabilität 0.665 (SOG trägt echtes Signal bei)
// GEWÄHLT: V2 - z(P/GP) + z(TOI/GP) + z(+/-/GP) + z(SOG/GP), je INNERHALB
// der Positionsgruppe (Stürmer/Verteidiger getrennt) z-normalisiert und
// GLEICHGEWICHTET gemittelt (keine geratene Gewichtung), Ergebnis über die
// Standardnormalverteilung in ein 0-100-Perzentil transformiert. Fehlende
// Komponenten (z.B. keine SOG-Daten für eine Saison) werden übersprungen,
// nicht mit 0 aufgefüllt.
// ---------------------------------------------------------------------------

const IMPACT_MIN_CAREER_GP = 20 // unter dieser Schwelle kein Score (zu kleine Stichprobe)
const RATE_KEYS = ['ppg', 'gpg', 'apg', 'toipg', 'sogpg', 'pmpg']

// Exportiert (statt rein lokal), damit src/advancedStats.js dieselbe
// Statistik-Basis (Mittel/Std/Normalverteilungs-CDF) für die NEUEN,
// spielbasierten Perzentile wiederverwenden kann, ohne die Formel zu
// duplizieren - reine Sichtbarkeitsänderung, kein Verhalten geändert.
export function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null }
export function stdDev(a, m) { return a.length ? Math.sqrt(mean(a.map((v) => (v - m) ** 2))) || 1 : 1 }

// Standardnormalverteilung CDF (Abramowitz-Stegun-Näherung) - wandelt einen
// z-Wert in ein Perzentil (0-1) um, für eine intuitiv lesbare 0-100-Skala.
export function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp((-z * z) / 2)
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z > 0 ? 1 - p : p
}

// Lazy-Load + einmalige Memoization der Positions-Baseline über den Import
// hinweg (module-level cache wie usePlayerHistory oben) - wird nicht bei
// jedem Seitenwechsel neu über alle 1'851 Spieler-Saisons berechnet.
let baselinesCache = null
export function usePositionBaselines() {
  const playerHistoryData = usePlayerHistory()
  return useMemo(() => {
    if (!playerHistoryData) return null
    if (baselinesCache && baselinesCache.src === playerHistoryData) return baselinesCache.value
    const value = buildPositionBaselines(playerHistoryData)
    baselinesCache = { src: playerHistoryData, value }
    return value
  }, [playerHistoryData])
}

// Positions-Baseline (Mittelwert/Std je Rate-Stat) über ALLE Saisons/Spieler
// im Export - einmal berechnen und memoizen (siehe usePositionBaselines
// oben), nicht bei jedem Render neu.
export function buildPositionBaselines(playerHistoryData) {
  const groups = { Stürmer: [], Verteidiger: [] }
  for (const rec of Object.values(playerHistoryData?.players || {})) {
    for (const s of rec.seasons) {
      if (s.gp <= 0 || !groups[s.position]) continue
      groups[s.position].push(seasonRates(s))
    }
  }
  const out = {}
  for (const pos of Object.keys(groups)) {
    const rows = groups[pos]
    out[pos] = { n: rows.length }
    for (const key of RATE_KEYS) {
      const vals = rows.map((r) => r[key]).filter((v) => v != null)
      const m = mean(vals)
      out[pos][key] = { mean: m ?? 0, std: stdDev(vals, m ?? 0), n: vals.length }
    }
  }
  return out
}

function careerRates(seasons) {
  const played = (seasons || []).filter((s) => s.gp > 0)
  const gp = played.reduce((s, x) => s + x.gp, 0)
  if (gp === 0) return null
  const sum = (k) => played.reduce((s, x) => s + (x[k] || 0), 0)
  const hasSog = played.some((s) => s.sog > 0)
  const hasToi = played.some((s) => s.toiSec > 0)
  return {
    gp,
    ppg: sum('points') / gp, gpg: sum('goals') / gp, apg: sum('assists') / gp,
    toipg: hasToi ? sum('toiSec') / gp : null,
    sogpg: hasSog ? sum('sog') / gp : null,
    pmpg: sum('plusMinus') / gp,
  }
}

// Gemeinsamer Kern für Karriere- UND Einzelsaison-Impact-Score (siehe
// computeImpactScore/computeSeasonImpactScore unten) - exakt dieselbe
// 4-Komponenten-Formel (z(P/GP)+z(TOI/GP)+z(+/-/GP)+z(SOG/GP), positions-
// relativ, gleichgewichtet), nur mit unterschiedlicher Rate-Quelle
// (Karriere-Summe vs. eine einzelne Saison) und Mindest-GP-Schwelle.
function scoreFromRates(rates, gpForThreshold, minGp, position, baselines) {
  if (!baselines?.[position] || !rates || gpForThreshold < minGp) return null
  const b = baselines[position]
  const components = []
  if (rates.ppg != null && b.ppg.n >= 20) components.push((rates.ppg - b.ppg.mean) / b.ppg.std)
  if (rates.toipg != null && b.toipg.n >= 20) components.push((rates.toipg - b.toipg.mean) / b.toipg.std)
  if (rates.pmpg != null && b.pmpg.n >= 20) components.push((rates.pmpg - b.pmpg.mean) / b.pmpg.std)
  if (rates.sogpg != null && b.sogpg.n >= 20) components.push((rates.sogpg - b.sogpg.mean) / b.sogpg.std)
  if (components.length === 0) return null
  const zComposite = mean(components)
  return { score: Math.round(normalCdf(zComposite) * 1000) / 10, zComposite, componentsUsed: components.length }
}

// Impact Score (0-100) für EINEN Spieler, über die KARRIERE. `position` =
// "Stürmer"|"Verteidiger" (Torhüter werden hier bewusst nicht bewertet -
// andere Leistungsdimension, siehe eigene Torhüter-Kennzahlen im Profil).
// null bei zu wenig Datenbasis.
export function computeImpactScore(seasons, position, baselines) {
  const c = careerRates(seasons)
  const r = scoreFromRates(c, c?.gp ?? 0, IMPACT_MIN_CAREER_GP, position, baselines)
  return r ? { ...r, careerGp: c.gp } : null
}

// Impact Score (0-100) für EINE EINZELNE Saison (inkl. laufender Saison,
// sofern als Saison-Objekt übergeben - siehe buildCurrentSeasonRecord unten)
// - identische Formel wie computeImpactScore, aber auf Saison- statt
// Karrierewerte angewendet. Mindest-GP = TREND_MIN_LATEST_GP (dieselbe
// bereits etablierte, dokumentierte Schwelle wie bei der Trend-Klassifikation
// unten - "ist eine einzelne Saison überhaupt aussagekräftig", keine neue
// Zahl erfunden).
export function computeSeasonImpactScore(season, position, baselines) {
  if (!season) return null
  return scoreFromRates(seasonRates(season), season.gp, TREND_MIN_LATEST_GP, position, baselines)
}

// Impact-Score-Verlauf über alle verfügbaren (historische + optional
// laufende) Saisons, für den Saisonverlauf-Chart/die Vergleichsdarstellung
// im Spielerprofil. Saisons ohne ausreichende Datenbasis werden übersprungen
// (kein erfundener Punkt), nicht als 0 dargestellt.
export function computeImpactScoreHistory(seasons, position, baselines) {
  return mergeSeasonSplits(seasons)
    .filter((s) => s.gp > 0)
    .map((s) => ({ season: s.season, impact: computeSeasonImpactScore(s, position, baselines) }))
    .filter((r) => r.impact != null)
}

// Baut aus der LAUFENDEN Saison (derived.playerStats-Eintrag aus
// src/stats.js, NICHT aus player-history.json) ein Saison-Objekt im selben
// Format wie die historischen Einträge, damit dieselben
// Vergleichs-/Trend-/Impact-Funktionen (die generisch über "Saison-förmige"
// Objekte arbeiten) unverändert auch die laufende Saison 2026/27
// mitverarbeiten können. KEIN Leakage: `stat` kommt ausschliesslich aus
// bereits abgeschlossenen (`status:'final'`) Spielen des aktuellen Kaders
// (siehe computePlayerStats in stats.js) - nie aus zukünftigen Spielen oder
// Prediction-Snapshots. null, wenn der Spieler diese Saison noch nicht
// gespielt hat (kein künstlicher 0-Punkt).
export function buildCurrentSeasonRecord(stat, player, seasonLabel) {
  if (!stat || stat.gp === 0 || !seasonLabel) return null
  return {
    season: seasonLabel,
    teamId: player?.teamId ?? null,
    position: POSITION_LABEL[player?.position] || null,
    gp: stat.gp, goals: stat.goals, assists: stat.assists, points: stat.points,
    sog: stat.sog || 0, plusMinus: stat.plusMinus || 0, toiSec: stat.toiSec || 0,
  }
}

// Rollierende Form aus dem Spielprotokoll der LAUFENDEN Saison. `log` =
// bereits nach diesem Spieler gefilterte, nach Datum ABSTEIGEND sortierte
// Spiele (Form `[{ s: playerStatsEintrag }, ...]`, siehe PlayerDetail.jsx -
// dort ohnehin schon für das Spielprotokoll aufgebaut, hier nur
// wiederverwendet statt erneut aus data.games abgeleitet). null, wenn
// weniger als `n` Spiele vorhanden sind - keine Berechnung auf zu wenig
// Datenbasis. `sog`/`toiSec` sind optional (nur vom SIHF-Sync befüllt) -
// werden nur summiert, wenn mindestens ein Eintrag im Fenster einen Wert > 0
// hat, sonst `null` statt eines irreführenden 0.
export function computeRollingForm(log, n) {
  if (!log || log.length < n) return null
  let goals = 0, assists = 0, sog = 0, toiSec = 0, hasSog = false, hasToi = false
  for (const { s } of log.slice(0, n)) {
    goals += Number(s.goals) || 0
    assists += Number(s.assists) || 0
    if (s.sog != null) { sog += Number(s.sog) || 0; hasSog = true }
    if (s.toiSec != null) { toiSec += Number(s.toiSec) || 0; hasToi = true }
  }
  const points = goals + assists
  return {
    gp: n, points, goals, assists, ppg: points / n, gpg: goals / n, apg: assists / n,
    sog: hasSog ? sog : null, sogpg: hasSog ? sog / n : null,
    toipg: hasToi ? toiSec / n : null,
  }
}

// ---------------------------------------------------------------------------
// GAME LOG (Player Tracker, Abschnitte 1-8): Auswertungen auf Spiel-Ebene für
// die laufende Saison, ausschliesslich aus dem bereits im Profil aufgebauten
// `log` (gefiltertes `data.games`, siehe PlayerDetail.jsx) - kein erneuter
// Scan aller Spiele, keine neue Datenquelle.
// ---------------------------------------------------------------------------

// Datenmodell-Grenze (ehrlich dokumentiert, keine Umgehung): `db.games[].
// playerStats[]` speichert pro Spiel nur { playerId, goals, assists, ... } -
// OHNE eigenes Team-Feld. Welches Team ein Spieler in einem bestimmten Spiel
// hatte, wird deshalb bislang implizit über den AKTUELLEN `player.teamId`
// gegen `game.homeTeamId`/`awayTeamId` abgeglichen. Das ist korrekt, SOLANGE
// sich `player.teamId` seit diesem Spiel nicht geändert hat. Bei einem
// unterjährigen Vereinswechsel matcht das aktuelle Team keines der beiden
// Spiel-Teams mehr für die ALTEN Spiele - in diesem Fall wird das Spiel als
// `teamCertain:false` markiert (Team "damals" unbekannt) statt es dem
// falschen/aktuellen Team zuzuordnen. Eine rückwirkend korrekte Zuordnung ist
// mit dem aktuellen Datenmodell nicht möglich (anders als im historischen
// Archiv, das pro Spiel ein echtes Team-Feld je Spieler hat) - hier bewusst
// NICHT geraten, siehe Bericht.
export function resolveGameTeam(game, player) {
  if (game.homeTeamId === player.teamId) return { teamId: player.teamId, isHome: true, certain: true }
  if (game.awayTeamId === player.teamId) return { teamId: player.teamId, isHome: false, certain: true }
  return { teamId: null, isHome: null, certain: false }
}

const SMALL_SAMPLE_GP = 5

// Heim-/Auswärts-Split (Abschnitt 5) aus dem Spielprotokoll. `log`-Einträge
// wie in PlayerDetail.jsx (`{ game, s, opp, isHome }`). Nur Zeitpunkte mit
// bekanntem `isHome` (siehe resolveGameTeam) fliessen ein.
export function computeHomeAwaySplit(log) {
  const sums = { home: { gp: 0, goals: 0, assists: 0, sog: 0, hasSog: false }, away: { gp: 0, goals: 0, assists: 0, sog: 0, hasSog: false } }
  for (const { s, isHome } of log || []) {
    if (isHome == null) continue
    const side = isHome ? sums.home : sums.away
    side.gp++
    side.goals += Number(s.goals) || 0
    side.assists += Number(s.assists) || 0
    if (s.sog != null) { side.sog += Number(s.sog) || 0; side.hasSog = true }
  }
  const finalize = (side) => {
    if (side.gp === 0) return null
    const points = side.goals + side.assists
    return {
      gp: side.gp, points, goals: side.goals, assists: side.assists,
      ppg: points / side.gp, gpg: side.goals / side.gp, apg: side.assists / side.gp,
      sogpg: side.hasSog ? side.sog / side.gp : null,
      smallSample: side.gp < SMALL_SAMPLE_GP,
    }
  }
  const home = finalize(sums.home), away = finalize(sums.away)
  if (!home && !away) return null
  return { home, away }
}

// "Gegen welche Teams produziert der Spieler am meisten?" (Abschnitt 6).
// Mindestens `minGames` Spiele gegen einen Gegner, bevor er in die Tabelle
// aufgenommen wird (keine Rangfolge aus 1 Einzelspiel).
export function computeOpponentBreakdown(log, minGames = 2) {
  const byOpp = new Map()
  for (const { s, opp } of log || []) {
    if (!opp) continue
    if (!byOpp.has(opp.id)) byOpp.set(opp.id, { opp, gp: 0, goals: 0, assists: 0 })
    const e = byOpp.get(opp.id)
    e.gp++
    e.goals += Number(s.goals) || 0
    e.assists += Number(s.assists) || 0
  }
  return [...byOpp.values()]
    .filter((e) => e.gp >= minGames)
    .map((e) => ({ ...e, points: e.goals + e.assists, ppg: (e.goals + e.assists) / e.gp }))
    .sort((a, b) => b.ppg - a.ppg || b.points - a.points)
}

// Team-Stint-Trennung innerhalb der laufenden Saison (Abschnitt 7) - siehe
// Datenmodell-Grenze oben. Liefert Gesamtwerte + (falls die aufgelösten
// Spiele mehr als ein sicheres Team zeigen) eine Aufschlüsselung je Team,
// plus die Anzahl Spiele mit unsicherer Team-Zuordnung (wird NIE einem Team
// zugeschlagen, sondern separat ausgewiesen).
export function computeTeamStints(log, player, teams) {
  const byTeam = new Map()
  let uncertain = 0
  for (const { s, game } of log || []) {
    const r = resolveGameTeam(game, player)
    if (!r.certain) { uncertain++; continue }
    if (!byTeam.has(r.teamId)) byTeam.set(r.teamId, { teamId: r.teamId, gp: 0, goals: 0, assists: 0 })
    const e = byTeam.get(r.teamId)
    e.gp++
    e.goals += Number(s.goals) || 0
    e.assists += Number(s.assists) || 0
  }
  const stints = [...byTeam.values()].map((e) => ({
    ...e,
    team: teams?.find((t) => t.id === e.teamId) || null,
    points: e.goals + e.assists,
    ppg: e.gp > 0 ? (e.goals + e.assists) / e.gp : null,
  }))
  return { stints, hasMultipleTeams: stints.length > 1, uncertainGames: uncertain }
}

// Positions-relatives Perzentil (0-100) für eine einzelne Rate-Kennzahl
// (z.B. "wie steht diese Saison-P/GP im Vergleich zu allen Stürmern da").
export function computePercentile(value, position, key, baselines) {
  if (value == null || !baselines?.[position]?.[key] || baselines[position][key].n < 20) return null
  const b = baselines[position][key]
  const z = (value - b.mean) / b.std
  return Math.round(normalCdf(z) * 1000) / 10
}

// ---------------------------------------------------------------------------
// TREND-KLASSIFIKATION - vergleicht die jüngste gespielte Saison mit dem
// Karriere-Niveau OHNE diese jüngste Saison (verhindert, dass ein
// Ausreisser-Jahr seine eigene Referenz verwässert). Nur ab
// TREND_MIN_SEASONS gespielten Saisons klassifiziert (sonst zu wenig
// Historie, z.B. ein Rookie würde sonst fälschlich als "stark steigend" von
// 0 auf X markiert).
// Schwellenwerte (dokumentiert, nicht geraten - Verhältnis jüngste P/GP zu
// Karriere-P/GP ohne die jüngste Saison):
//   >= 1.30  stark steigend
//   >= 1.10  steigend
//   <= 0.80  fallend
//   sonst    stabil
// Mindestens TREND_MIN_LATEST_GP Spiele in der jüngsten Saison nötig (sonst
// kann ein einzelnes gutes/schlechtes Spiel eine irreführend grosse
// Prozent-Veränderung erzeugen - "nicht durch wenige Spiele getragen").
// ---------------------------------------------------------------------------
const TREND_MIN_SEASONS = 3
export const TREND_MIN_LATEST_GP = 10
const TREND_THRESHOLDS = { strongUp: 1.30, up: 1.10, down: 0.80 }

export function classifyTrend(seasons) {
  const played = mergeSeasonSplits(seasons).filter((s) => s.gp > 0)
  if (played.length < TREND_MIN_SEASONS) return null
  const latest = played[played.length - 1]
  if (latest.gp < TREND_MIN_LATEST_GP) return null
  const priorSeasons = played.slice(0, -1)
  const priorGp = priorSeasons.reduce((s, x) => s + x.gp, 0)
  if (priorGp === 0) return null
  const careerPpgExclLatest = priorSeasons.reduce((s, x) => s + x.points, 0) / priorGp
  const latestPpg = ppg(latest)
  if (latestPpg == null || careerPpgExclLatest === 0) return null
  const ratio = latestPpg / careerPpgExclLatest
  let label = 'stabil'
  if (ratio >= TREND_THRESHOLDS.strongUp) label = 'stark steigend'
  else if (ratio >= TREND_THRESHOLDS.up) label = 'steigend'
  else if (ratio <= TREND_THRESHOLDS.down) label = 'fallend'
  // 2-Jahres-Niveau: Ø P/GP der letzten (bis zu) 2 gespielten Saisons.
  const last2 = played.slice(-2)
  const last2Gp = last2.reduce((s, x) => s + x.gp, 0)
  const last2Ppg = last2Gp > 0 ? last2.reduce((s, x) => s + x.points, 0) / last2Gp : null
  return { label, ratio, latestPpg, careerPpgExclLatest, last2Ppg, latestSeason: latest.season }
}

// Ø P/GP der letzten (bis zu) N gespielten Saisons (Spiel-gewichtet:
// Summe Punkte / Summe Spiele, nicht einfacher Mittelwert der Saison-Raten).
export function recentPpg(seasons, n) {
  const played = mergeSeasonSplits(seasons).filter((s) => s.gp > 0).slice(-n)
  const gp = played.reduce((s, x) => s + x.gp, 0)
  if (gp === 0) return null
  return played.reduce((s, x) => s + x.points, 0) / gp
}

export function isBreakout(trend) { return trend?.label === 'stark steigend' }
export function isDeclining(trend) { return trend?.label === 'fallend' }

// Aktuelle Kader-Positionscodes ('F'/'D'/'G') -> Positions-Label wie im
// historischen Export ("Stürmer"/"Verteidiger") - identische Zuordnung wie
// posLabel in PlayerDetail.jsx/TeamDetail.jsx.
export const POSITION_LABEL = { F: 'Stürmer', D: 'Verteidiger', G: 'Torhüter' }

// Kaderanalyse für EIN Team (TeamDetail.jsx "Kaderanalyse"). `rosterPlayers`
// = aktuelle Spieler dieses Teams (data.players gefiltert nach teamId).
// Liefert nur Kennzahlen, für die genug Datenbasis vorhanden ist - keine
// künstliche Präzision (z.B. kein Ø-Geburtsjahr, wenn <50% des Kaders ein
// ageGroup-Jahr hat).
export function computeTeamRosterProfile(rosterPlayers, playerHistoryData, baselines) {
  const skaters = rosterPlayers.filter((p) => p.position !== 'G')
  const scored = []
  const birthYears = []
  for (const p of skaters) {
    const rec = playerHistoryData?.players?.[p.id]
    const posLabel = POSITION_LABEL[p.position]
    const impact = rec && posLabel ? computeImpactScore(rec.seasons, posLabel, baselines) : null
    if (impact) scored.push({ player: p, position: posLabel, ...impact })
    if (rec?.ageGroup) birthYears.push(rec.ageGroup)
  }
  if (scored.length === 0) {
    return { playerCount: skaters.length, scoredCount: 0, avgScore: null, medianScore: null, top5: [], scored: [], avgBirthYear: null, offense: null, defense: null }
  }
  const avgScore = mean(scored.map((s) => s.score))
  const medianScore = median(scored.map((s) => s.score))
  const top5 = [...scored].sort((a, b) => b.score - a.score).slice(0, 5)
  const forwards = scored.filter((s) => s.position === 'Stürmer')
  const defense = scored.filter((s) => s.position === 'Verteidiger')
  // Ø-Geburtsjahr nur anzeigen, wenn für mindestens die Hälfte des
  // Feldspieler-Kaders ein Jahr bekannt ist - sonst irreführend.
  const avgBirthYear = birthYears.length >= skaters.length * 0.5 && birthYears.length > 0 ? Math.round(mean(birthYears)) : null
  return {
    playerCount: skaters.length,
    scoredCount: scored.length,
    avgScore,
    medianScore,
    top5,
    scored, // vollständige Liste (für alternative Top-5-Sortierungen in TeamDetail.jsx wiederverwendet, keine erneute Berechnung)
    avgBirthYear,
    birthYearCoverage: skaters.length > 0 ? birthYears.length / skaters.length : 0,
    offense: forwards.length > 0 ? mean(forwards.map((s) => s.score)) : null,
    defense: defense.length > 0 ? mean(defense.map((s) => s.score)) : null,
  }
}

function median(arr) {
  if (!arr.length) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const GOALIE_MIN_CAREER_GP = 10 // eigene, niedrigere Schwelle als Skater (weniger Torhüter/Team verfügbar)

// Karriere-SV% für EINEN Torhüter aus den historischen Goalie-Saisons
// (player-history.json enthält für Torhüter {season, teamId, gp, saves,
// goalsAgainst, shotsAgainst, toiSec} statt der Skater-Felder - siehe
// generate-player-history.js). EIGENE Kennzahl, NICHT der Skater-Impact-Score
// (andere Leistungsdimension, siehe Aufgabenstellung). null bei zu wenig
// Career-Sample.
export function computeGoalieCareerStats(seasons) {
  const played = (seasons || []).filter((s) => s.gp > 0 && s.shotsAgainst > 0)
  const gp = played.reduce((s, x) => s + x.gp, 0)
  if (gp < GOALIE_MIN_CAREER_GP) return null
  const saves = played.reduce((s, x) => s + x.saves, 0)
  const shotsAgainst = played.reduce((s, x) => s + x.shotsAgainst, 0)
  const goalsAgainst = played.reduce((s, x) => s + x.goalsAgainst, 0)
  return {
    gp, savePct: shotsAgainst > 0 ? saves / shotsAgainst : null,
    gaa: gp > 0 ? goalsAgainst / gp : null,
  }
}

// Kaderstruktur nach Position (Abschnitt "Team Depth"): Stürmer/Verteidiger
// über den bereits validierten Impact Score (Anzahl/Ø/Median, plus Ø P/GP -
// Karriere, aus careerRates via computeImpactScore-Rückgabe NICHT verfügbar,
// daher hier separat aus den Saisons berechnet), Torhüter über die EIGENE
// Karriere-SV%-Kennzahl (kein Skater-Score auf Torhüter erzwungen). Keine
// künstliche Bewertung ("guter Kader" o.ä.) - nur Zahlen.
export function computeTeamDepth(rosterPlayers, playerHistoryData, baselines) {
  const groups = { Stürmer: [], Verteidiger: [] }
  const goalieScores = []
  for (const p of rosterPlayers) {
    const rec = playerHistoryData?.players?.[p.id]
    if (p.position === 'G') {
      const g = rec ? computeGoalieCareerStats(rec.seasons) : null
      goalieScores.push({ player: p, stats: g })
      continue
    }
    const posLabel = POSITION_LABEL[p.position]
    if (!posLabel || !groups[posLabel]) continue
    const impact = rec ? computeImpactScore(rec.seasons, posLabel, baselines) : null
    const rates = rec ? careerRates(rec.seasons) : null
    groups[posLabel].push({ player: p, impact, ppg: rates?.ppg ?? null })
  }
  const summarize = (rows) => {
    const withImpact = rows.filter((r) => r.impact != null)
    const withPpg = rows.filter((r) => r.ppg != null)
    return {
      count: rows.length,
      scoredCount: withImpact.length,
      avgImpact: withImpact.length ? mean(withImpact.map((r) => r.impact.score)) : null,
      medianImpact: withImpact.length ? median(withImpact.map((r) => r.impact.score)) : null,
      avgPpg: withPpg.length ? mean(withPpg.map((r) => r.ppg)) : null,
    }
  }
  const withGoalieStats = goalieScores.filter((g) => g.stats != null)
  return {
    forwards: summarize(groups['Stürmer']),
    defense: summarize(groups['Verteidiger']),
    goalies: {
      count: goalieScores.length,
      scoredCount: withGoalieStats.length,
      avgSavePct: withGoalieStats.length ? mean(withGoalieStats.map((g) => g.stats.savePct)) : null,
      medianSavePct: withGoalieStats.length ? median(withGoalieStats.map((g) => g.stats.savePct)) : null,
    },
  }
}
