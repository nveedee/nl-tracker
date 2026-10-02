// ---------------------------------------------------------------------------
// Game Center / Match Analytics - rein deskriptive Aufbereitung bereits
// gespeicherter Boxscore-/Prediction-Daten für die Matchup-Detailseite
// (src/pages/MatchupDetail.jsx). Keine neue Prognoselogik, keine neuen
// Gewichtungen, keine erfundenen Werte - liest ausschliesslich vorhandene
// Felder aus server/data/db.json (games[], predictions[], players[]) und
// gibt bei fehlenden Daten `null`/"–" zurück statt zu schätzen.
//
// Pre-Game-Korrektheit: `computeShotsForPerGame`/die Form-/Record-Hilfen aus
// src/headToHead.js werden auf der Matchup-Seite bewusst mit einer auf
// `game.date` VOR dem jeweiligen Spiel gefilterten Spieleliste aufgerufen
// (siehe MatchupDetail.jsx), damit für ein historisches Spiel nie der
// heutige Saisonstand zurückgerechnet wird (kein Leakage, siehe Auftrag).
// Diese Datei selbst trifft keine Annahme über den Zeitpunkt - sie bekommt
// die bereits passend gefilterte Spieleliste übergeben.
// ---------------------------------------------------------------------------

import { isFinalGame } from './stats.js'

// Zugelassene Schüsse/Spiel existieren bereits in src/headToHead.js
// (computeShotsAllowedPerGame, aus Torhüter-Einträgen). Das Gegenstück -
// erzielte Schüsse/Spiel - fehlt dort; hier dupliziert nach demselben Muster
// (Summe der Spieler-`sog`-Werte des eigenen Kaders je Spiel), um
// headToHead.js nicht anfassen zu müssen.
export function computeShotsForPerGame(teamId, games, players) {
  const rosterIds = new Set(
    (players || []).filter((p) => p.teamId === teamId).map((p) => p.id)
  )
  if (rosterIds.size === 0) return null

  let gp = 0
  let shotsFor = 0
  for (const g of (games || []).filter(isFinalGame)) {
    if (g.homeTeamId !== teamId && g.awayTeamId !== teamId) continue
    let gameShots = 0
    let hasData = false
    for (const s of g.playerStats || []) {
      if (rosterIds.has(s.playerId) && s.sog != null) {
        gameShots += Number(s.sog) || 0
        hasData = true
      }
    }
    if (hasData) {
      gp++
      shotsFor += gameShots
    }
  }
  return gp > 0 ? shotsFor / gp : null
}

// Tore/Schüsse pro Drittel aus den SIHF-Rohfeldern (sihfPeriods/sihfShots) -
// 1:1 übernommen, nur zu einer gemeinsamen Zeilenstruktur zusammengeführt.
// `null`, wenn keine der beiden Serien vorhanden ist (ältere Syncs ohne
// Drittel-Detail, siehe Auftrag Punkt 11/12).
export function getPeriodBreakdown(game) {
  const periods = game?.sihfPeriods
  const shots = game?.sihfShots
  if ((!periods || periods.length === 0) && (!shots || shots.length === 0)) return null

  const byIndicator = new Map()
  for (const p of periods || []) {
    byIndicator.set(p.indicator, { label: p.name, indicator: p.indicator, homeGoals: p.home, awayGoals: p.away, homeShots: null, awayShots: null })
  }
  for (const s of shots || []) {
    const existing = byIndicator.get(s.indicator)
    if (existing) {
      existing.homeShots = s.home
      existing.awayShots = s.away
    } else {
      byIndicator.set(s.indicator, { label: s.name, indicator: s.indicator, homeGoals: null, awayGoals: null, homeShots: s.home, awayShots: s.away })
    }
  }
  return [...byIndicator.values()]
}

// Nach-Spiel-Teamstatistiken aus den bereits aggregierten NL-Felbbox-Werten
// (nlTeamStatsHome/Away) - nur bereits vorhandene Kennzahlen, keine eigene
// Berechnung (sogPercentage/ppPercentage/pkPercentage/foPercentage kommen
// 1:1 aus dem Sync). `null` wenn für dieses Spiel nicht vorhanden.
export function getPostGameTeamStats(game) {
  const h = game?.nlTeamStatsHome
  const a = game?.nlTeamStatsAway
  if (!h || !a) return null
  return {
    home: h,
    away: a,
    sogDiff: (h.sog ?? null) != null && (a.sog ?? null) != null ? h.sog - a.sog : null,
    goalDiff: (game.homeGoals ?? null) != null && (game.awayGoals ?? null) != null ? game.homeGoals - game.awayGoals : null,
  }
}

function findPlayer(players, playerId) {
  return (players || []).find((p) => p.id === playerId) || null
}

// Pre-Game-Cutoff: nur bereits abgeschlossene Spiele, die VOR dem Anpfiff von
// `game` stattfanden (Datum + Uhrzeit; bei gleichem Tag ohne Uhrzeit wird das
// Spiel konservativ ausgeschlossen). Das Spiel selbst und alles danach
// (inkl. zukünftiger Spiele) ist nie enthalten - kein Look-ahead-Leakage.
export function gamesBefore(games, game) {
  if (!game) return []
  return (games || []).filter((g) => {
    if (g.id === game.id || !isFinalGame(g)) return false
    if (g.date !== game.date) return g.date < game.date
    return !!(g.time && game.time && g.time < game.time)
  })
}

// Plausibilitätscheck der Spieler-Torschützen-Daten: die Summe der Tore aller
// Feldspieler eines Teams muss dem Teamresultat entsprechen (beim SO-Sieger
// zählt das Entscheidungstor nicht in den Spielerstatistiken). Sonst sind die
// Tore/Assists unvollständig (z.B. noch nicht synchronisiert) - dann dürfen
// 0-Werte NICHT als echte 0 angezeigt und kein Top Scorer abgeleitet werden.
export function hasReliableScoring(game, players) {
  if (!game?.playerStats || game.playerStats.length === 0 || !isFinalGame(game)) return false
  const skaterTeam = new Map((players || []).filter((p) => p.position !== 'G').map((p) => [p.id, p.teamId]))
  const sums = { [game.homeTeamId]: 0, [game.awayTeamId]: 0 }
  for (const s of game.playerStats) {
    const t = skaterTeam.get(s.playerId)
    if (t in sums) sums[t] += s.goals ?? 0
  }
  const so = game.decision === 'SO'
  const homeExp = game.homeGoals - (so && game.homeGoals > game.awayGoals ? 1 : 0)
  const awayExp = game.awayGoals - (so && game.awayGoals > game.homeGoals ? 1 : 0)
  return sums[game.homeTeamId] === homeExp && sums[game.awayTeamId] === awayExp
}

// Skater-Boxscore eines Teams für genau dieses Spiel - nur Feldspieler
// (Position F/D) mit mindestens einem erfassten Feld. Sortierung macht die
// UI-Komponente (clientseitig, keine neue Kennzahl).
export function getSkaterBoxscore(game, players, teamId) {
  if (!game?.playerStats) return []
  const rosterIds = new Set(
    (players || []).filter((p) => p.teamId === teamId && p.position !== 'G').map((p) => p.id)
  )
  const reliable = hasReliableScoring(game, players)
  return game.playerStats
    .filter((s) => rosterIds.has(s.playerId))
    .map((s) => {
      const p = findPlayer(players, s.playerId)
      return {
        playerId: s.playerId,
        name: p?.name ?? '?',
        number: p?.number ?? null,
        position: p?.position ?? null,
        goals: reliable ? (s.goals ?? 0) : null,
        assists: reliable ? (s.assists ?? 0) : null,
        points: reliable ? (s.goals ?? 0) + (s.assists ?? 0) : null,
        sog: s.sog ?? s.shotsOnGoalNl ?? null,
        toiSec: s.toiSec ?? null,
        plusMinus: s.plusMinusNl ?? s.plusMinus ?? null,
        pim: s.pim ?? s.penaltyMinutes ?? null,
      }
    })
}

// Torhüter-Boxscore eines Teams für genau dieses Spiel.
export function getGoalieBoxscore(game, players, teamId) {
  if (!game?.playerStats) return []
  const rosterIds = new Set(
    (players || []).filter((p) => p.teamId === teamId && p.position === 'G').map((p) => p.id)
  )
  return game.playerStats
    .filter((s) => rosterIds.has(s.playerId) && (s.saves != null || s.goalsAgainst != null))
    .map((s) => {
      const p = findPlayer(players, s.playerId)
      const saves = Number(s.savesNl ?? s.saves) || 0
      const goalsAgainst = Number(s.goalsAgainstNl ?? s.goalsAgainst) || 0
      const shots = s.shotsAgainst != null ? Number(s.shotsAgainst) : (saves + goalsAgainst > 0 ? saves + goalsAgainst : null)
      return {
        playerId: s.playerId,
        name: p?.name ?? '?',
        number: p?.number ?? null,
        saves,
        goalsAgainst,
        shots,
        savePercentage: shots > 0 ? (saves / shots) * 100 : null,
        decision: s.decision ?? null,
        shutout: !!s.shutout,
      }
    })
    // Spielte dieser Torhüter tatsächlich (mind. 1 Schuss zugelassen oder Einsatz mit Entscheidung)?
    .filter((g) => g.shots > 0 || g.decision != null)
}

// "Wer hat das Spiel geprägt?" - rein deskriptiv aus den bereits vorhandenen
// Boxscore-Werten beider Teams, keine erfundene Gesamtbewertung/MVP.
export function whoDroveTheGame(game, players) {
  if (!game?.playerStats || game.playerStats.length === 0) return null

  const skaterIds = new Set((players || []).filter((p) => p.position !== 'G').map((p) => p.id))
  const goalieIds = new Set((players || []).filter((p) => p.position === 'G').map((p) => p.id))

  const skaters = game.playerStats
    .filter((s) => skaterIds.has(s.playerId))
    .map((s) => ({ s, p: findPlayer(players, s.playerId) }))
    .filter((x) => x.p)

  const goalies = game.playerStats
    .filter((s) => goalieIds.has(s.playerId) && (s.saves > 0 || s.decision != null))
    .map((s) => ({ s, p: findPlayer(players, s.playerId) }))
    .filter((x) => x.p)

  if (skaters.length === 0 && goalies.length === 0) return null

  const pick = (arr, valueFn) => {
    let best = null
    let bestVal = -Infinity
    for (const x of arr) {
      const v = valueFn(x)
      if (v == null) continue
      if (v > bestVal) { bestVal = v; best = x; }
    }
    return best ? { player: best.p, team: best.p.teamId, value: bestVal } : null
  }

  const scoringReliable = hasReliableScoring(game, players)
  const topScorer = scoringReliable ? pick(skaters, (x) => (x.s.goals ?? 0) + (x.s.assists ?? 0)) : null
  const topShooterRaw = pick(skaters, (x) => x.s.sog ?? x.s.shotsOnGoalNl ?? null)
  const topShooter = topShooterRaw && topShooterRaw.value > 0 ? topShooterRaw : null
  const mostTOI = pick(skaters, (x) => x.s.toiSec ?? null)
  const bestPlusMinus = pick(skaters, (x) => x.s.plusMinusNl ?? x.s.plusMinus ?? null)
  const bestGoalie = pick(
    goalies.filter((x) => (x.s.shotsAgainst ?? (x.s.saves + x.s.goalsAgainst)) > 0),
    (x) => {
      const shots = x.s.shotsAgainst ?? ((x.s.saves ?? 0) + (x.s.goalsAgainst ?? 0))
      return shots > 0 ? (x.s.saves ?? 0) / shots : null
    }
  )

  return { topScorer, topShooter, mostTOI, bestPlusMinus, bestGoalie, scoringUnavailable: !scoringReliable }
}

// Brier-/LogLoss-Beitrag GENAU dieses einen Spiels - identische Formel wie
// computeBiggestMisses() in src/predictionMetrics.js (dort nicht
// importierbar als Einzelspiel-Helfer, daher hier dupliziert statt die
// Datei anzufassen). Keine neue Metrik, nur dieselbe Berechnung für ein
// einzelnes Spiel statt für ein Array.
const EPS = 1e-9
export function computeGamePredictionScore(prediction, game) {
  if (!prediction || !game || !isFinalGame(game)) return null
  if (prediction.homeWinProbability == null || prediction.awayWinProbability == null) return null
  const homeWon = game.homeGoals > game.awayGoals
  const p = prediction.homeWinProbability
  const favoriteIsHome = prediction.homeWinProbability >= prediction.awayWinProbability
  const correct = favoriteIsHome === homeWon
  const brierContribution = (p - (homeWon ? 1 : 0)) ** 2
  const pCorrectSide = Math.min(1 - EPS, Math.max(EPS, homeWon ? p : 1 - p))
  const logLossPenalty = -Math.log(pCorrectSide)
  return { correct, brierContribution, logLossPenalty }
}
