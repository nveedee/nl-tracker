// ---------------------------------------------------------------------------
// Verbessertes ELO-Berechnung für Teams mit:
// - Heimvorteil-Faktor
// - Gegnerstärke-Berücksichtigung
// - Nicht-linearer Torunterschied (logarithmisch)
// - Unterschiedliche Gewichtung: Regulation vs. OT vs. SO
// - Dynamischer K-Faktor (abhängig von Spielanzahl)
// - Optionale Form-Gewichtung (aktuell deaktiviert, siehe formDecayFactor)
// - Regression zum Mittelwert bei Saisonwechsel (falls Spiele ein `season`-Feld tragen)
//
// Parameter kalibriert per Walk-Forward-Backtest auf den historischen
// NL-Saisons 2017/18–2025/26 (Corona-Saisons 2019/20 + 2020/21 bei der
// Kalibrierung ausgeklammert, siehe server/scripts/backtest-elo.js).
//
// Das System wird vollständig aus den vorhandenen Spielen berechnet.
// Keine separaten historischen Werte oder externe Daten.
// ---------------------------------------------------------------------------

import { isFinalGame } from './stats.js'

// ============================================================================
// ELO-PARAMETER (per Backtest kalibriert)
// ============================================================================

export const ELO_CONFIG = {
  eloStart: 1500,           // Startwert
  baseK: 16,                // Basis K-Faktor (bei ~30 Spielen Erfahrung)
  homeAdvantage: 65,        // Heimvorteil in ELO-Punkten

  // Gewichtung der Spielergebnisse — OT und SO werden bewusst UNTERSCHIEDLICH
  // behandelt (SO ist näher an einem Münzwurf als eine echte OT-Entscheidung).
  resultWeights: {
    regulationWin: 1.0,     // Sieg in 60 Min
    otWin: 0.70,            // Sieg nach Overtime
    otLoss: 0.30,           // Niederlage nach Overtime
    soWin: 0.55,            // Sieg nach Penaltyschiessen
    soLoss: 0.45,           // Niederlage nach Penaltyschiessen
    regulationLoss: 0.0,    // Niederlage in 60 Min
  },

  // Torunterschied-Multiplikator (nicht-linear)
  // log(goalDiff + 1) um extreme Kantersiege zu dämpfen
  goalDiffFactor: 0.7,      // 0 = ignoriert, 1 = stark berücksichtigt

  // Form-Gewichtung: zusätzliches Gewicht für Teams mit wenig Spielerfahrung
  // (0 = deaktiviert). Per Backtest verschlechterte ein von 0 verschiedener
  // Wert die Prognosequalität leak-frei betrachtet -> Default aus.
  formDecayFactor: 0,

  // Saisonend-Regression: Anteil, um den jedes Team-Rating bei Saisonwechsel
  // zurück zu eloStart gezogen wird (0 = kein Reset, 1 = voller Reset).
  // Greift nur, wenn Spiele ein `season`-Feld tragen und dieses wechselt.
  seasonEndRegression: 0.25,

  // Dynamischer K-Faktor: Junge Teams (wenige Spiele) sollten sich schneller
  // bewegen. Tier-Grenzen relativ zu baseK skaliert (Referenzform bei
  // baseK=24: 32/28/24/20/16 für <=5/<=15/<=30/<=50/>50 Spiele).
  kFactorByGames: [
    { maxGames: 5, kRatio: 32 / 24 },
    { maxGames: 15, kRatio: 28 / 24 },
    { maxGames: 30, kRatio: 24 / 24 },
    { maxGames: 50, kRatio: 20 / 24 },
    { maxGames: Infinity, kRatio: 16 / 24 },
  ],
}

// ============================================================================
// HILFSFUNKTIONEN
// ============================================================================

// Dynamischer K-Faktor basierend auf bisher gespielten Spielen (nur Vergangenheit!)
function getKFactor(gamesPlayed, baseK) {
  for (const { maxGames, kRatio } of ELO_CONFIG.kFactorByGames) {
    if (gamesPlayed <= maxGames) return baseK * kRatio
  }
  const last = ELO_CONFIG.kFactorByGames[ELO_CONFIG.kFactorByGames.length - 1]
  return baseK * last.kRatio
}

// Ergebnis-Score basierend auf Resultat-Typ.
// WICHTIG: SO wird VOR OT geprüft, damit der SO-Zweig tatsächlich erreicht
// wird (früherer Bug: OT-Bedingung schloss SO ein, soWin/soLoss waren toter Code).
function getResultScore(homeWon, decision) {
  if (decision === 'SO') {
    return homeWon
      ? ELO_CONFIG.resultWeights.soWin
      : ELO_CONFIG.resultWeights.soLoss
  }
  if (decision === 'OT') {
    return homeWon
      ? ELO_CONFIG.resultWeights.otWin
      : ELO_CONFIG.resultWeights.otLoss
  }
  return homeWon
    ? ELO_CONFIG.resultWeights.regulationWin
    : ELO_CONFIG.resultWeights.regulationLoss
}

// Nicht-linearer Torunterschied-Multiplikator
// log(|goalDiff| + 1) um Kantersiege zu dämpfen, aber zu berücksichtigen
function getGoalDiffMultiplier(goalDiff) {
  if (goalDiff === 0) return 1.0
  // log(|goalDiff| + 1): 1 Tor → 0.69, 2 Tore → 1.10, 5 Tore → 1.79
  const factor = Math.log(Math.abs(goalDiff) + 1)
  return 1.0 + ELO_CONFIG.goalDiffFactor * (factor - 1)
}

// Form-Modifier: dämpft frühe Spiele eines Teams leicht.
// Verwendet AUSSCHLIESSLICH die Anzahl bereits gespielter Spiele (Stand vor
// dem aktuellen Spiel) — keine Kenntnis künftiger Spiele. Bei
// formDecayFactor = 0 (Default) neutral (= 1).
function getFormModifier(gamesPlayedSoFar) {
  if (ELO_CONFIG.formDecayFactor <= 0) return 1.0
  return 1 - Math.exp(-ELO_CONFIG.formDecayFactor * (gamesPlayedSoFar + 1))
}

// ============================================================================
// HAUPTFUNKTION
// ============================================================================

// `initialRatings` (optional): teamId -> Startrating, ersetzt den einheitlichen
// `start`-Wert pro Team, falls vorhanden (z.B. Pre-Season-ELO aus
// src/preseasonElo.js). Ohne dieses Argument exakt bisheriges Verhalten
// (alle Teams starten bei `start`) - rein additiv, nicht rückwirkend.
export function computeElo(teams, games, settings, initialRatings) {
  // Verwende Config, aber lasse Settings override
  const start = settings?.eloStart ?? ELO_CONFIG.eloStart
  const homeAdv = settings?.eloHomeAdvantage ?? ELO_CONFIG.homeAdvantage
  const baseK = settings?.eloK ?? ELO_CONFIG.baseK
  const seasonRegression =
    settings?.eloSeasonEndRegression ?? ELO_CONFIG.seasonEndRegression

  const ratings = {}
  const history = {}
  const gamesPlayedCount = {} // nur bereits verarbeitete Spiele — leak-frei
  teams.forEach((t) => {
    const teamStart = initialRatings?.[t.id] ?? start
    ratings[t.id] = teamStart
    history[t.id] = [{ index: 0, date: null, rating: teamStart }]
    gamesPlayedCount[t.id] = 0
  })

  const sorted = [...games].sort(sortByDate)

  let step = 0
  let currentSeason = null
  for (const g of sorted) {
    if (ratings[g.homeTeamId] == null || ratings[g.awayTeamId] == null) continue
    if (!isFinalGame(g)) continue

    // === SAISONWECHSEL -> REGRESSION ZUM MITTELWERT ===
    // Greift nur, wenn Spiele ein `season`-Feld tragen und dieses wechselt
    // (aktuell trägt die laufende Saison kein solches Feld -> No-Op).
    if (g.season != null) {
      if (currentSeason !== null && g.season !== currentSeason) {
        teams.forEach((t) => {
          ratings[t.id] = start + (ratings[t.id] - start) * (1 - seasonRegression)
        })
      }
      currentSeason = g.season
    }

    step += 1

    const rh = ratings[g.homeTeamId]
    const ra = ratings[g.awayTeamId]

    // === ERGEBNIS ===
    const homeWon = g.homeGoals > g.awayGoals
    const goalDiff = Math.abs(g.homeGoals - g.awayGoals)

    const scoreH = getResultScore(homeWon, g.decision)
    const scoreA = 1 - scoreH

    // === ERWARTUNGSWERT mit Heimvorteil ===
    const expH = 1 / (1 + Math.pow(10, (ra - (rh + homeAdv)) / 400))
    const expA = 1 - expH

    // === TORUNTERSCHIED-MULTIPLIKATOR ===
    const goalMult = getGoalDiffMultiplier(goalDiff)

    // === DYNAMISCHER K-FAKTOR (nur aus bisher gespielten Spielen) ===
    const gamesPlayedH = gamesPlayedCount[g.homeTeamId]
    const gamesPlayedA = gamesPlayedCount[g.awayTeamId]
    const kH = getKFactor(gamesPlayedH, baseK)
    const kA = getKFactor(gamesPlayedA, baseK)

    // === FORM-MODIFIER (leak-frei, per Default neutral) ===
    const formH = getFormModifier(gamesPlayedH)
    const formA = getFormModifier(gamesPlayedA)

    // === ENDBERECHNUNG ===
    const deltaH = kH * goalMult * formH * (scoreH - expH)
    const deltaA = kA * goalMult * formA * (scoreA - expA)

    const newH = rh + deltaH
    const newA = ra + deltaA

    ratings[g.homeTeamId] = newH
    ratings[g.awayTeamId] = newA
    gamesPlayedCount[g.homeTeamId] = gamesPlayedH + 1
    gamesPlayedCount[g.awayTeamId] = gamesPlayedA + 1

    history[g.homeTeamId].push({
      index: step,
      date: g.date,
      rating: newH,
      gameId: g.id,
      delta: deltaH,
    })
    history[g.awayTeamId].push({
      index: step,
      date: g.date,
      rating: newA,
      gameId: g.id,
      delta: deltaA,
    })
  }

  // === RANKING MIT ZUSÄTZLICHEN STATISTIKEN ===
  const ranking = teams
    .map((t) => {
      const hist = history[t.id]
      const gameCount = hist.length - 1
      const currentRating = ratings[t.id]

      // Δ seit letztem Spiel
      const deltaLast =
        gameCount > 0 ? currentRating - hist[hist.length - 2]?.rating || 0 : 0

      // Δ über letzte 5 Spiele
      const lastN = 5
      const fiveGamesAgo = Math.max(0, gameCount - lastN)
      const ratingFiveGamesAgo =
        fiveGamesAgo > 0 ? hist[fiveGamesAgo]?.rating || currentRating : hist[0].rating
      const deltaLast5 = currentRating - ratingFiveGamesAgo

      return {
        team: t,
        rating: Math.round(currentRating),
        games: gameCount,
        deltaLast: Math.round(deltaLast * 10) / 10,
        deltaLast5: Math.round(deltaLast5 * 10) / 10,
      }
    })
    .sort((a, b) => b.rating - a.rating)

  return { ratings, history, ranking }
}

// Heimsieg-Wahrscheinlichkeit aus zwei ELO-Werten + Heimvorteil (0..1).
export function homeWinProbability(ratingHome, ratingAway, homeAdvantage) {
  return 1 / (1 + Math.pow(10, (ratingAway - (ratingHome + homeAdvantage)) / 400))
}

export function sortByDate(a, b) {
  const da = a.date || ''
  const db = b.date || ''
  if (da < db) return -1
  if (da > db) return 1
  return 0
}
