// ---------------------------------------------------------------------------
// Verbessertes Power Ranking – kombiniert vier Komponenten:
//
// 1. Siegkraft (40%): ELO-Rating (moderat SOG-zugelassen-adjustiert) + Punkte/Spiel + Gewinnquote
// 2. Offensive (25%): Tore/Spiel + relative Offensive Form
// 3. Defensive (25%): Gegentore/Spiel + relative Defensive Form
// 4. Form (10%): Letzte 5 & 10 Spiele mit Trend-Gewichtung
//
// Alle Komponenten werden ligaweit normalisiert (0–100) und kombiniert.
// ELO wird als Bestandteil genutzt, aber nicht 1:1 als Ranking angezeigt.
//
// SOG-ZUGELASSEN-ADJUSTIERUNG (Siegkraft):
// Walk-Forward-Backtest auf 2017/18–2025/26 (server/scripts/backtest-power-ranking-features.js)
// zeigte: von allen getesteten zusätzlichen Kennzahlen (gegnerbereinigte
// Tore/Gegentore, SOG erzielt, PP%, PK%, Heim/Auswärts-Splits) verbesserte
// NUR "zugelassene Schüsse pro Spiel" die Prognose leak-frei zusätzlich zu
// ELO (LogLoss 0.6566 -> 0.6553, Brier 0.2322 -> 0.2316, Accuracy 60.6% -> 61.6%,
// Koeffizient h=0.15 im logistischen Modell). Diese Datei übernimmt NUR diese
// eine Kennzahl, als moderate Verschiebung des ELO-Eingabewerts (siehe
// computeSogAllowedAdjustment) – die ELO-Berechnung selbst (src/elo.js) bleibt
// unverändert, ebenso Offensive/Defensive/Form-Gewichtung.
// ---------------------------------------------------------------------------

import { isFinalGame } from './stats.js'

// ============================================================================
// KONFIGURATION (zentral optimierbar)
// ============================================================================

export const POWER_CONFIG = {
  // Hauptgewichtung der vier Komponenten (Summe = 1.0)
  weights: {
    strength: 0.40,        // Siegkraft (ELO + Punkte + Win%)
    offense: 0.25,         // Offensive (Tore/Spiel + Form)
    defense: 0.25,         // Defensive (GA/Spiel + Form)
    form: 0.10,            // Form (letzte 5 & 10 Spiele)
  },

  // Gewichtung innerhalb Siegkraft
  strengthWeights: {
    elo: 0.50,             // Aktuelles ELO
    pointsPerGame: 0.35,   // Durchschnittliche Punkte/Spiel
    winRate: 0.15,         // Siegesquote
  },

  // Form-Perioden
  formShort: 5,            // Letzte N Spiele (kurzfristig)
  formLong: 10,            // Letzte N Spiele (langfristig)
  formLongWeight: 0.3,     // 0.0 = nur kurzfristig; 1.0 = gleich gewichtet

  // Offensive/Defensive Relative-Performance-Fenster
  // (wie stark weicht das Team vom Durchschnitt ab)
  relativeWindow: 10,      // letzte N Spiele für Relative-Performance

  // ELO-Normalisierungsbereich (für 0–100 Skala)
  eloMin: 1300,            // ELO unter 1300 = sehr schwach (0)
  eloMax: 1700,            // ELO über 1700 = sehr stark (100)

  // SOG-zugelassen-Adjustierung des ELO-Eingabewerts (siehe Kommentar oben).
  // h entspricht exakt dem im Backtest gefundenen Koeffizienten; die
  // Umrechnung von logistischem Koeffizient -> ELO-Punkte-Äquivalent folgt
  // aus derselben Skalierung, die ELOs eigene 400-Punkte-Logistik verwendet
  // (elo.js: 1 / (1 + 10^(-diff/400)) === sigmoid(diff * ln(10)/400)).
  sogAllowed: {
    weight: 0.15,              // h aus dem Backtest
    minGamesFullConfidence: 10, // ab wie vielen Spielen volles Gewicht (rolling-10-Fenster im Backtest)
    maxZScore: 2.5,             // Clipping gegen Ausreisser bei kleinen Stichproben
  },
}

// ============================================================================
// HILFSFUNKTIONEN
// ============================================================================

// Min-Max-Normalisierung auf 0–100
function normalize(values, invert = false) {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return values.map(() => 50)
  const min = Math.min(...finite)
  const max = Math.max(...finite)
  return values.map((v) => {
    if (!Number.isFinite(v) || max === min) return 50
    const n = (v - min) / (max - min)
    return invert ? (1 - n) * 100 : n * 100
  })
}

// Normalisiere ELO auf 0–100 mit fixen Ankerpunkten
function normalizeElo(elo, eloMin, eloMax) {
  if (elo < eloMin) return 0
  if (elo > eloMax) return 100
  return ((elo - eloMin) / (eloMax - eloMin)) * 100
}

// Berechne Gewinnquote (Siege / Spiele)
function getWinRate(gp, w, otw) {
  if (gp === 0) return 0
  return (w + otw) / gp
}

// Extrahiere Spiele der letzten N Tage für ein Team
function getRecentGames(teamId, games, count) {
  return games
    .filter(isFinalGame)
    .filter((g) => g.homeTeamId === teamId || g.awayTeamId === teamId)
    .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0))
    .slice(0, count)
}

// Berechne Offensive/Defensive-Performance über ein Fenster
// Vergleicht Durchschnitt gegen Liga-Durchschnitt
function getRelativeOffense(teamId, games, count, allTeamStats) {
  const recent = getRecentGames(teamId, games, count)
  if (recent.length === 0) return 0

  let gf = 0
  for (const g of recent) {
    const isHome = g.homeTeamId === teamId
    gf += isHome ? g.homeGoals : g.awayGoals
  }
  const teamGPG = gf / recent.length

  // Liga-Durchschnitt berechnen
  const leagueGPG = allTeamStats.reduce((s, t) => s + t.gf, 0) / Math.max(1, allTeamStats.reduce((s, t) => s + t.gp, 0))

  // Relative Performance: wie viel besser/schlechter als Liga
  return (teamGPG - leagueGPG) / Math.max(0.1, leagueGPG)
}

function getRelativeDefense(teamId, games, count, allTeamStats) {
  const recent = getRecentGames(teamId, games, count)
  if (recent.length === 0) return 0

  let ga = 0
  for (const g of recent) {
    const isHome = g.homeTeamId === teamId
    ga += isHome ? g.awayGoals : g.homeGoals
  }
  const teamGAG = ga / recent.length

  // Liga-Durchschnitt
  const leagueGAG = allTeamStats.reduce((s, t) => s + t.ga, 0) / Math.max(1, allTeamStats.reduce((s, t) => s + t.gp, 0))

  // Relative Performance (weniger ist besser → negativ)
  return (leagueGAG - teamGAG) / Math.max(0.1, leagueGAG)
}

// Zugelassene Schüsse/Spiel für ein Team, gespeist aus den Torhüter-Einträgen
// in playerStats (saves + goalsAgainst = Schüsse, die die EIGENEN Torhüter
// dieses Teams gesehen haben = vom Team zugelassene Schüsse). Verwendet nur
// bereits gespielte Spiele aus dem übergebenen `games`-Array (leak-frei: die
// Aufrufer dieser Datei übergeben immer nur den bis "jetzt" bekannten Stand).
function computeSogAllowedStats(teamId, games, players) {
  const goalieIds = new Set(
    players.filter((p) => p.teamId === teamId && p.position === 'G').map((p) => p.id)
  )
  if (goalieIds.size === 0) return { gp: 0, perGame: null }

  let gp = 0
  let shotsAgainst = 0
  for (const g of games) {
    if (!isFinalGame(g)) continue
    if (g.homeTeamId !== teamId && g.awayTeamId !== teamId) continue
    let gameShotsAgainst = 0
    for (const s of g.playerStats || []) {
      if (goalieIds.has(s.playerId)) {
        gameShotsAgainst += (Number(s.saves) || 0) + (Number(s.goalsAgainst) || 0)
      }
    }
    if (gameShotsAgainst > 0) {
      gp++
      shotsAgainst += gameShotsAgainst
    }
  }
  return { gp, perGame: gp > 0 ? shotsAgainst / gp : null }
}

// Moderate ELO-Punkte-Adjustierung je Team aus "zugelassene Schüsse/Spiel",
// ligaweit z-normalisiert (weniger zugelassene Schüsse als Liga-Schnitt =
// positive Adjustierung). Bei wenig Spielen (< minGamesFullConfidence) wird
// die Adjustierung linear gedämpft -> neutral (0) bei 0 Spielen.
// Betrifft NUR den lokalen Eingabewert für die Siegkraft-Komponente dieser
// Datei, NICHT das eigentliche ELO-Rating aus src/elo.js.
function computeSogAllowedEloAdjustments(teams, games, players) {
  const cfg = POWER_CONFIG.sogAllowed
  const adjustments = {}
  teams.forEach((t) => { adjustments[t.id] = 0 })
  if (!players || players.length === 0) return adjustments

  const stats = teams.map((t) => ({ id: t.id, ...computeSogAllowedStats(t.id, games, players) }))
  const withData = stats.filter((s) => s.perGame != null)
  if (withData.length < 2) return adjustments

  const mean = withData.reduce((s, x) => s + x.perGame, 0) / withData.length
  const variance = withData.reduce((s, x) => s + (x.perGame - mean) ** 2, 0) / withData.length
  const std = Math.sqrt(variance)
  if (std === 0) return adjustments

  // Logit-Koeffizient -> ELO-Punkte-Äquivalent (siehe ELO_CONFIG-Kommentar):
  // dieselbe 400/ln(10)-Skalierung wie ELOs eigene Erwartungswert-Formel.
  const logitToElo = 400 / Math.LN10

  for (const s of stats) {
    if (s.perGame == null) continue
    // weniger zugelassene Schüsse als Liga-Schnitt -> positiver z-Score
    const rawZ = (mean - s.perGame) / std
    const z = Math.max(-cfg.maxZScore, Math.min(cfg.maxZScore, rawZ))
    const confidence = Math.min(1, s.gp / cfg.minGamesFullConfidence)
    adjustments[s.id] = cfg.weight * z * confidence * logitToElo
  }
  return adjustments
}

// ============================================================================
// HAUPTFUNKTION
// ============================================================================

export function computePowerRankings(teams, games, eloRatings = {}, players = []) {
  const finalGames = [...games.filter(isFinalGame)].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  )

  // === SAMMLE TEAM-STATISTIKEN ===
  const stats = {}
  teams.forEach((t) => {
    stats[t.id] = {
      team: t,
      gp: 0,
      w: 0,
      otw: 0,
      otl: 0,
      l: 0,
      pts: 0,
      gf: 0,
      ga: 0,
      games: [],
    }
  })

  for (const g of finalGames) {
    const h = stats[g.homeTeamId]
    const a = stats[g.awayTeamId]
    if (!h || !a) continue

    const homeWon = g.homeGoals > g.awayGoals
    const overtime = g.decision === 'OT' || g.decision === 'SO'
    const hp = overtime ? (homeWon ? 2 : 1) : (homeWon ? 3 : 0)
    const ap = overtime ? (homeWon ? 1 : 2) : (homeWon ? 0 : 3)

    h.gp++
    a.gp++
    h.pts += hp
    a.pts += ap
    h.gf += g.homeGoals
    h.ga += g.awayGoals
    a.gf += g.awayGoals
    a.ga += g.homeGoals

    if (overtime) {
      if (homeWon) {
        h.otw++
        a.otl++
      } else {
        h.otl++
        a.otw++
      }
    } else {
      if (homeWon) {
        h.w++
        a.l++
      } else {
        h.l++
        a.w++
      }
    }

    h.games.push(g)
    a.games.push(g)
  }

  const statsList = Object.values(stats)

  // === 1. SIEGKRAFT (Strength) ===
  // Kombiniert: ELO (50%) + Punkte/Spiel (35%) + Gewinnquote (15%)

  const sogAllowedAdjustments = computeSogAllowedEloAdjustments(teams, finalGames, players)
  const eloArray = statsList.map((s) => (eloRatings[s.team.id] ?? 1500) + (sogAllowedAdjustments[s.team.id] ?? 0))
  const eloNorm = eloArray.map((e) =>
    normalizeElo(e, POWER_CONFIG.eloMin, POWER_CONFIG.eloMax)
  )

  const ptsPerGame = statsList.map((s) => (s.gp > 0 ? s.pts / s.gp : 0))
  const ptsPerGameNorm = normalize(ptsPerGame)

  const winRates = statsList.map((s) => getWinRate(s.gp, s.w, s.otw))
  const winRatesNorm = normalize(winRates)

  const strengthScores = eloNorm.map((e, i) =>
    e * POWER_CONFIG.strengthWeights.elo +
    ptsPerGameNorm[i] * POWER_CONFIG.strengthWeights.pointsPerGame +
    winRatesNorm[i] * POWER_CONFIG.strengthWeights.winRate
  )

  // === 2. OFFENSIVE ===
  // Tore/Spiel (60%) + Relative-Offensive über letzten Fenster (40%)

  const gpgArray = statsList.map((s) => (s.gp > 0 ? s.gf / s.gp : 0))
  const gpgNorm = normalize(gpgArray)

  const relOffenseArray = statsList.map((s) =>
    getRelativeOffense(s.team.id, finalGames, POWER_CONFIG.relativeWindow, statsList)
  )
  const relOffenseNorm = normalize(relOffenseArray)

  const offenseScores = gpgNorm.map((g, i) => g * 0.6 + relOffenseNorm[i] * 0.4)

  // === 3. DEFENSIVE ===
  // Gegentore/Spiel (60%) + Relative-Defensive über letzten Fenster (40%)

  const gagArray = statsList.map((s) => (s.gp > 0 ? s.ga / s.gp : 0))
  const gagNorm = normalize(gagArray, true) // invert: weniger ist besser

  const relDefenseArray = statsList.map((s) =>
    getRelativeDefense(s.team.id, finalGames, POWER_CONFIG.relativeWindow, statsList)
  )
  const relDefenseNorm = normalize(relDefenseArray)

  const defenseScores = gagNorm.map((g, i) => g * 0.6 + relDefenseNorm[i] * 0.4)

  // === 4. FORM ===
  // Letzte 5 (Kurzfrist) + Letzte 10 (Langfrist) mit Gewichtung

  const formShortArray = statsList.map((s) => {
    const recent = s.games.slice(-POWER_CONFIG.formShort)
    if (recent.length === 0) return 0
    let pts = 0
    for (const g of recent) {
      const isHome = g.homeTeamId === s.team.id
      const won = isHome ? g.homeGoals > g.awayGoals : g.awayGoals > g.homeGoals
      const overtime = g.decision === 'OT' || g.decision === 'SO'
      pts += overtime ? (won ? 2 : 1) : (won ? 3 : 0)
    }
    return pts / recent.length
  })
  const formShortNorm = normalize(formShortArray)

  const formLongArray = statsList.map((s) => {
    const recent = s.games.slice(-POWER_CONFIG.formLong)
    if (recent.length === 0) return 0
    let pts = 0
    for (const g of recent) {
      const isHome = g.homeTeamId === s.team.id
      const won = isHome ? g.homeGoals > g.awayGoals : g.awayGoals > g.homeGoals
      const overtime = g.decision === 'OT' || g.decision === 'SO'
      pts += overtime ? (won ? 2 : 1) : (won ? 3 : 0)
    }
    return pts / recent.length
  })
  const formLongNorm = normalize(formLongArray)

  const formScores = formShortNorm.map((s, i) =>
    s * (1 - POWER_CONFIG.formLongWeight) + formLongNorm[i] * POWER_CONFIG.formLongWeight
  )

  // === FINALE BERECHNUNG ===
  const powerScores = strengthScores.map((str, i) =>
    str * POWER_CONFIG.weights.strength +
    offenseScores[i] * POWER_CONFIG.weights.offense +
    defenseScores[i] * POWER_CONFIG.weights.defense +
    formScores[i] * POWER_CONFIG.weights.form
  )

  // === BAUE ERGEBNIS ===
  const results = statsList
    .map((s, i) => ({
      team: s.team,
      gp: s.gp,
      pts: s.pts,
      w: s.w,
      otw: s.otw,
      otl: s.otl,
      l: s.l,
      gf: s.gf,
      ga: s.ga,
      ptsPerGame: s.gp > 0 ? s.pts / s.gp : 0,
      gpg: s.gp > 0 ? s.gf / s.gp : 0,
      gag: s.gp > 0 ? s.ga / s.gp : 0,
      elo: eloRatings[s.team.id] ?? 1500,
      sogAllowedEloAdjustment: Math.round((sogAllowedAdjustments[s.team.id] ?? 0) * 10) / 10,
      components: {
        strength: Math.round(strengthScores[i]),
        offense: Math.round(offenseScores[i]),
        defense: Math.round(defenseScores[i]),
        form: Math.round(formScores[i]),
      },
      powerScore: Math.round(powerScores[i]),
      recentForm: s.games.slice(-5).map((g) => {
        const isHome = g.homeTeamId === s.team.id
        const won = isHome ? g.homeGoals > g.awayGoals : g.awayGoals > g.homeGoals
        const ot = g.decision === 'OT' || g.decision === 'SO'
        return won ? (ot ? 'OTW' : 'W') : ot ? 'OTL' : 'L'
      }),
    }))
    .sort((a, b) => b.powerScore - a.powerScore)

  return results
}
