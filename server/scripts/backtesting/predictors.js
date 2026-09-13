// ---------------------------------------------------------------------------
// PREDICTOR REGISTRY - strikt leak-freie Walk-Forward-Prognosen auf dem
// historischen Archiv (server/data/historical/*.json via loadHistorical.js).
//
// PRODUCTION SAFETY: src/elo.js und src/restDays.js werden UNVERÄNDERT
// IMPORTIERT und wiederverwendet (keine Parallel-Implementierung der
// ELO-/Ruhetage-Formel - 100% identisches Verhalten zur Live-App
// garantiert). src/playoffSim.js wird NICHT importiert/verändert - die dort
// verwendete SOG-Allowed-Formel und die Tore-Kalibrierung sind unten mit
// exakt denselben Konstanten/Formeln DUPLIZIERT (derselbe Ansatz, den das
// Projekt bereits an mehreren Stellen nutzt, z.B. SOG_ADJUSTMENT zwischen
// src/powerRankings.js und src/playoffSim.js selbst, oder
// computePreseasonRatings in server/scripts/predictions.js) - Grund: ein
// Import aus playoffSim.js würde dessen komplette Monte-Carlo-Engine
// mitziehen, obwohl hier nur die Fixture-Stärke-Formel gebraucht wird, und
// playoffSim.js exportiert diese internen Hilfsfunktionen bewusst nicht.
//
// KEINE Kalibrierung/Parameter-Fit (kein g/c-Logit-Scaling wie im älteren
// server/scripts/backtest-preseason-h2h.js): jeder Prädiktor hier bildet
// GENAU die Formel ab, die tatsächlich live in der App läuft (rohe
// ELO-Logistik mit fixem Heimvorteil) - das ist die ehrliche "was ist
// wirklich deployed"-Referenz, keine nachträglich re-optimierte Variante.
// ---------------------------------------------------------------------------

import { computeElo, homeWinProbability, ELO_CONFIG } from '../../../src/elo.js'
import { computeRestAdjustment, applyRestAdjustment, DEFAULT_BACK_TO_BACK_PENALTY } from '../../../src/restDays.js'

// ============================================================================
// Gemeinsame Walk-Forward-ELO-Grundlage (v1 "flach" und v2 "Pre-Season-
// Carryover" unterscheiden sich AUSSCHLIESSLICH darin, ob computeElo() über
// jede Saison isoliert (flacher Reset) oder über die gesamte Saisonkette am
// Stück (natürlicher seasonEndRegression-Übergang, ELO_CONFIG-Default 25%)
// läuft - siehe Bericht, Abschnitt "Season-Init-Policy".
// ============================================================================

// Extrahiert aus dem Rückgabewert von computeElo() (history[teamId] = [{index,
// date, rating, gameId, delta}, ...]) die PRE-GAME-Ratings jedes Spiels: die
// Formel `rating - delta` liefert exakt den Wert, den computeElo() INTERN vor
// dem Update dieses Spiels verwendet hat (siehe src/elo.js: `newH = rh +
// deltaH` -> `rh = newH - deltaH`). Kein zweites Nachrechnen der ELO-Formel
// nötig - 100% identisch zur produktiven Berechnung, weil direkt aus deren
// eigenem Output rekonstruiert.
function extractPreGameRatings(eloResult, games) {
  const byKey = new Map() // `${teamId}|${gameId}` -> historyEntry
  for (const [teamId, hist] of Object.entries(eloResult.history)) {
    for (const h of hist) {
      if (h.gameId == null) continue // Index-0-Startwert-Eintrag, kein echtes Spiel
      byKey.set(`${teamId}|${h.gameId}`, h)
    }
  }
  const out = new Map()
  for (const g of games) {
    const hEntry = byKey.get(`${g.homeTeamId}|${g.id}`)
    const aEntry = byKey.get(`${g.awayTeamId}|${g.id}`)
    if (!hEntry || !aEntry) continue
    out.set(g.id, { ratingHome: hEntry.rating - hEntry.delta, ratingAway: aEntry.rating - aEntry.delta })
  }
  return out
}

// v1: pro Saison EIN eigener, unveränderter computeElo()-Aufruf ohne
// initialRatings -> jedes Team startet flach bei ELO_CONFIG.eloStart (1500).
// Das repliziert das reale Live-Verhalten: server/data/db.json enthält
// IMMER nur eine Saison, computeElo()'s eigene seasonEndRegression greift in
// der Live-App folglich nie (kein Saisonübergang im selben games-Array) -
// ausser die separate Pre-Season-ELO-Komponente (= v2) speist explizit einen
// Startwert ein.
function runFlatEloPerSeason(gamesBySeasonOrdered) {
  const preGame = new Map()
  for (const seasonGames of gamesBySeasonOrdered) {
    const teamIds = [...new Set(seasonGames.flatMap((g) => [g.homeTeamId, g.awayTeamId]))]
    const teams = teamIds.map((id) => ({ id }))
    const eloResult = computeElo(teams, seasonGames, {})
    const seasonPreGame = extractPreGameRatings(eloResult, seasonGames)
    for (const [k, v] of seasonPreGame) preGame.set(k, v)
  }
  return preGame
}

// v2: EIN durchgehender computeElo()-Aufruf über die GESAMTE chronologische
// 9-Saisons-Kette - computeElo()'s eigene, unveränderte
// Saisonübergangs-Regression (ELO_CONFIG.seasonEndRegression, Default 0.25)
// greift dadurch bei JEDEM Saisonwechsel automatisch. Das ist exakt dieselbe
// Methode wie server/scripts/generate-preseason-elo.js für die LIVE
// 2026/27-Saison (dort einmalig auf die ganze Archiv-Kette angewendet, das
// Ergebnis als public/preseason-elo.json exportiert) - hier zusätzlich für
// JEDES historische Spiel die Pre-Game-Ratings mit ausgelesen, nicht nur das
// Saisonend-Ergebnis.
function runChainedEloAllSeasons(allGamesChronological) {
  const teamIds = [...new Set(allGamesChronological.flatMap((g) => [g.homeTeamId, g.awayTeamId]))]
  const teams = teamIds.map((id) => ({ id }))
  const eloResult = computeElo(teams, allGamesChronological, {})
  return extractPreGameRatings(eloResult, allGamesChronological)
}

// ============================================================================
// SOG-Allowed (dupliziert aus src/playoffSim.js::computeSogAllowedStats /
// computeSogAllowedEloAdjustments - identische Konstanten/Formel, siehe
// Dateikopf). Leak-frei: für Spiel N werden AUSSCHLIESSLICH die vorherigen
// Spiele DERSELBEN Saison (Index 0..N-1) einbezogen - bewusst innerhalb der
// Saison zurückgesetzt, weil db.json in der Live-App ohnehin nie mehr als
// eine Saison Spiele gleichzeitig enthält (die Funktion hat dort also nie
// die Gelegenheit, saisonübergreifend zu mitteln).
// ============================================================================

const SOG_ADJUSTMENT = { weight: 0.15, minGamesFullConfidence: 10, maxZScore: 2.5 }
const LOGIT_TO_ELO = 400 / Math.LN10

function computeSogAllowedSnapshotsForSeason(seasonGames) {
  const out = new Map()
  const statByTeam = new Map() // wird laufend fortgeschrieben (leak-frei: vor Zeile N nur Spiele < N)
  for (const g of seasonGames) {
    const withData = [...statByTeam.entries()]
      .filter(([, s]) => s.gp > 0)
      .map(([id, s]) => ({ id, perGame: s.sogAgainst / s.gp, gp: s.gp }))

    let adjHome = 0, adjAway = 0
    if (withData.length >= 2) {
      const mean = withData.reduce((s, x) => s + x.perGame, 0) / withData.length
      const variance = withData.reduce((s, x) => s + (x.perGame - mean) ** 2, 0) / withData.length
      const std = Math.sqrt(variance)
      if (std > 0) {
        const adjFor = (id) => {
          const x = withData.find((w) => w.id === id)
          if (!x) return 0
          const rawZ = (mean - x.perGame) / std
          const z = Math.max(-SOG_ADJUSTMENT.maxZScore, Math.min(SOG_ADJUSTMENT.maxZScore, rawZ))
          const confidence = Math.min(1, x.gp / SOG_ADJUSTMENT.minGamesFullConfidence)
          return SOG_ADJUSTMENT.weight * z * confidence * LOGIT_TO_ELO
        }
        adjHome = adjFor(g.homeTeamId)
        adjAway = adjFor(g.awayTeamId)
      }
    }
    out.set(g.id, { home: adjHome, away: adjAway })

    const hs = statByTeam.get(g.homeTeamId) || { gp: 0, sogAgainst: 0 }
    hs.gp++; hs.sogAgainst += g.sogAllowedHome
    statByTeam.set(g.homeTeamId, hs)
    const as = statByTeam.get(g.awayTeamId) || { gp: 0, sogAgainst: 0 }
    as.gp++; as.sogAgainst += g.sogAllowedAway
    statByTeam.set(g.awayTeamId, as)
  }
  return out
}

function runSogAllowedAllSeasons(gamesBySeasonOrdered) {
  const out = new Map()
  for (const seasonGames of gamesBySeasonOrdered) {
    const snap = computeSogAllowedSnapshotsForSeason(seasonGames)
    for (const [k, v] of snap) out.set(k, v)
  }
  return out
}

// ============================================================================
// Poisson/Skellam-geschlossene Form der Produktions-Monte-Carlo-Simulation
// (dupliziert aus src/playoffSim.js: CALIBRATION-Konstanten + expectedGoals(),
// siehe Dateikopf). Production simuliert 10'000 Poisson-Torzahlen + eine
// OT/SO-Münze; hier wird dieselbe Verteilung stattdessen GESCHLOSSEN
// (Doppelsumme über die Poisson-Wahrscheinlichkeitsmasse) ausgewertet -
// mathematisch identisch zum Erwartungswert der 10'000er-Simulation im
// Grenzwert, aber deterministisch und ohne Simulationsrauschen (siehe
// Bericht). Verwendet für den "Produktions-Referenz"-Prädiktor, der die
// tatsächlich in server/scripts/predictions.js/src/playoffSim.js verwendete
// Umrechnung von ELO-Wahrscheinlichkeit -> finale Siegwahrscheinlichkeit
// nachbildet (inkl. dem OT/SO-Münzwurf mit ebenfalls `pHome`, siehe
// simulateGameResult() dort).
// ============================================================================

const CALIBRATION = { leagueHomeGPG: 3.0496, leagueAwayGPG: 2.5309, supremacySlope: 4 }
const GOAL_TRUNCATION = 30 // Poisson(k>30; λ<=6) ist numerisch vernachlässigbar (<1e-12)

function expectedGoals(pHome) {
  const supremacy = CALIBRATION.supremacySlope * (pHome - 0.5)
  const totalExpected = CALIBRATION.leagueHomeGPG + CALIBRATION.leagueAwayGPG
  return {
    expHome: Math.max(0.2, totalExpected / 2 + supremacy / 2),
    expAway: Math.max(0.2, totalExpected / 2 - supremacy / 2),
  }
}

function poissonPmfTable(lambda, n) {
  const table = new Array(n + 1)
  table[0] = Math.exp(-lambda)
  for (let k = 1; k <= n; k++) table[k] = table[k - 1] * (lambda / k)
  return table
}

function closedFormWinProbability(pHomeRaw) {
  const { expHome, expAway } = expectedGoals(pHomeRaw)
  const pmfHome = poissonPmfTable(expHome, GOAL_TRUNCATION)
  const pmfAway = poissonPmfTable(expAway, GOAL_TRUNCATION)
  let pHomeWinsReg = 0, pTie = 0
  for (let h = 0; h <= GOAL_TRUNCATION; h++) {
    for (let a = 0; a <= GOAL_TRUNCATION; a++) {
      const p = pmfHome[h] * pmfAway[a]
      if (h > a) pHomeWinsReg += p
      else if (h === a) pTie += p
    }
  }
  // Unentschieden nach 60 Minuten -> OT/SO; produktiv entscheidet dieselbe
  // Grösse pHome (raw) den Münzwurf (siehe simulateGameResult(), OT/SO
  // selbst werden nicht unterschiedlich gewichtet - nur GEZÄHLT/gelabelt).
  return pHomeWinsReg + pTie * pHomeRaw
}

// ============================================================================
// v0: naive Basisrate - Heimsieg-Quote AUSSCHLIESSLICH aus VORHERIGEN
// Saisons (Abschnitt 15c) - für die jeweils erste verfügbare Saison
// (2017/18, keine Vorsaison im Archiv) nicht auswertbar (kein erfundener
// Default, siehe Bericht).
// ============================================================================

function runNaiveBaseline(gamesBySeasonOrdered) {
  const preGame = new Map()
  let priorHomeWins = 0, priorTotal = 0
  for (const seasonGames of gamesBySeasonOrdered) {
    if (priorTotal > 0) {
      const rate = priorHomeWins / priorTotal
      for (const g of seasonGames) preGame.set(g.id, { pHome: rate })
    }
    // Update NACH der Prognose dieser Saison, mit den Ergebnissen DIESER Saison.
    for (const g of seasonGames) {
      priorTotal++
      if (g.homeGoals > g.awayGoals) priorHomeWins++
    }
  }
  return preGame
}

// ============================================================================
// ÖFFENTLICHE PREDICTOR-REGISTRY
// ============================================================================

// `run(allGamesChronological)` -> Map(gameId -> { pHome: number|null }).
// null = für dieses Spiel nicht auswertbar (siehe jeweilige Begründung) -
// wird vom Backtest-Runner sauber übersprungen, nicht als 50% o.ä. geraten.
export function buildPredictors() {
  return [
    {
      id: 'v0',
      name: 'v0 - Naive Basisrate',
      description: 'Konstante Heimsieg-Quote aus allen VORHERIGEN Saisons (kein ELO, keine Team-Information). Reine Referenzuntergrenze.',
      features: ['Heimsieg-Basisrate (walk-forward über Saisons)'],
      run(allGames, ctx) {
        return runNaiveBaseline(ctx.gamesBySeason)
      },
    },
    {
      id: 'v1',
      name: 'v1 - ELO Baseline',
      description: 'Produktives ELO (src/elo.js, unverändert) mit flachem Saisonstart (1500) - repliziert das reale Live-Verhalten ohne Pre-Season-ELO-Komponente.',
      features: ['ELO (K-Tiers, Torunterschied, OT/SO-Gewichtung)', 'Heimvorteil (+65)'],
      run(allGames, ctx) {
        const preGame = runFlatEloPerSeason(ctx.gamesBySeason)
        const out = new Map()
        for (const g of allGames) {
          const r = preGame.get(g.id)
          out.set(g.id, { pHome: r ? homeWinProbability(r.ratingHome, r.ratingAway, ELO_CONFIG.homeAdvantage) : null })
        }
        return out
      },
    },
    {
      id: 'v2',
      name: 'v2 - ELO + Pre-Season-ELO',
      description: 'Wie v1, aber Saisonstart-ELO wird aus dem (25% Richtung 1500 regressierten) Saisonend-ELO der Vorsaison abgeleitet (computeElo()s eigene seasonEndRegression, durchgehend über die Archiv-Kette angewendet) - identische Methode wie src/preseasonElo.js für die laufende Saison.',
      features: ['ELO (wie v1)', 'Pre-Season-ELO-Carryover (seasonEndRegression=0.25)'],
      run(allGames, ctx) {
        const preGame = runChainedEloAllSeasons(allGames)
        const out = new Map()
        for (const g of allGames) {
          const r = preGame.get(g.id)
          out.set(g.id, { pHome: r ? homeWinProbability(r.ratingHome, r.ratingAway, ELO_CONFIG.homeAdvantage) : null })
        }
        return out
      },
    },
    {
      id: 'v2_marketvalue',
      name: 'v2b - ELO + Marktwert-Prior',
      description: 'HISTORISCH NICHT VALIDIERBAR: Der Marktwert-Prior (src/marketValuePrior.js) basiert auf den AKTUELLEN, live von nationalleague.ch synchronisierten Kaderwerten (server/sync.js). Es existiert kein saisonbezogenes historisches Marktwert-Archiv - eine rückwirkende Anwendung heutiger Werte auf z.B. die Saison 2019/20 wäre Leakage (der heutige Marktwert spiegelt 7 Jahre spätere Kaderentwicklung). Wird deshalb NICHT berechnet.',
      features: ['Marktwert-Prior'],
      notValidatable: true,
      reason: 'Keine saisonbezogenen historischen Marktwerte verfügbar (nur aktueller Live-Snapshot) - rückwirkende Anwendung wäre Leakage.',
      run() { return new Map() },
    },
    {
      id: 'v3',
      name: 'v3 - v2 + Ruhetage/Back-to-back',
      description: 'Wie v2, zusätzlich Heimsieg-Wahrscheinlichkeit bei einseitigem Back-to-back angepasst (src/restDays.js, unverändert, Default ±4%). Tage seit letztem Spiel aus dem historischen Spielplan rekonstruiert (Datumsfelder), keine externe Information nötig.',
      features: ['ELO (wie v1)', 'Pre-Season-ELO (wie v2)', 'Ruhetage/Back-to-back (±4%)'],
      run(allGames, ctx, opts) {
        const preGame = runChainedEloAllSeasons(allGames)
        const penalty = (opts && opts.backToBackPenalty) ?? DEFAULT_BACK_TO_BACK_PENALTY
        const out = new Map()
        for (const g of allGames) {
          const r = preGame.get(g.id)
          if (!r) { out.set(g.id, { pHome: null }); continue }
          const raw = homeWinProbability(r.ratingHome, r.ratingAway, ELO_CONFIG.homeAdvantage)
          const adjusted = applyRestAdjustment(raw, g, allGames, penalty)
          out.set(g.id, { pHome: adjusted, restAdjustment: computeRestAdjustment(g, allGames, penalty) })
        }
        return out
      },
    },
    {
      id: 'v2_sog',
      name: 'v2c - v2 + SOG-Allowed (Ablation)',
      description: 'Wie v2, zusätzlich ELO-Adjustierung nach "zugelassenen Schüssen/Spiel" (src/powerRankings.js/src/playoffSim.js-Formel dupliziert, innerhalb der Saison leak-frei akkumuliert). Isolierte Ablation OHNE Ruhetage/Poisson-Transformation, um den Zusatznutzen von SOG-Allowed für sich zu prüfen.',
      features: ['ELO (wie v1)', 'Pre-Season-ELO (wie v2)', 'SOG-Allowed-Adjustierung'],
      run(allGames, ctx) {
        const preGame = runChainedEloAllSeasons(allGames)
        const sogAdj = runSogAllowedAllSeasons(ctx.gamesBySeason)
        const out = new Map()
        for (const g of allGames) {
          const r = preGame.get(g.id)
          if (!r) { out.set(g.id, { pHome: null }); continue }
          const adj = sogAdj.get(g.id) || { home: 0, away: 0 }
          const pHome = homeWinProbability(r.ratingHome + adj.home, r.ratingAway + adj.away, ELO_CONFIG.homeAdvantage)
          out.set(g.id, { pHome })
        }
        return out
      },
    },
    {
      id: 'production_reference',
      name: 'Produktions-Referenz (ohne Marktwert-Prior)',
      description: 'Die tatsächlich aktuell live laufende Prognose-Pipeline (server/scripts/predictions.js, src/playoffSim.js::computeFixtures), soweit historisch rekonstruierbar: ELO + Pre-Season-ELO + SOG-Allowed -> Poisson-Toreerwartung -> Sieg-Wahrscheinlichkeit (geschlossene Form statt 10k-Monte-Carlo, siehe Dateikopf) + Ruhetage/Back-to-back. Der Marktwert-Prior fehlt (historisch nicht rekonstruierbar, siehe v2b) - das ist die einzige produktive Komponente, die hier NICHT enthalten ist.',
      features: ['ELO', 'Pre-Season-ELO', 'SOG-Allowed', 'Poisson/Skellam-Toreerwartung (statt roher ELO-Logistik)', 'Ruhetage/Back-to-back'],
      caveat: 'Ohne Marktwert-Prior (historisch nicht rekonstruierbar). Nutzt die geschlossene Poisson/Skellam-Form statt der 10k-Monte-Carlo-Simulation aus src/playoffSim.js - mathematisch äquivalent im Grenzwert, aber ohne deren Simulationsrauschen.',
      run(allGames, ctx, opts) {
        const preGame = runChainedEloAllSeasons(allGames)
        const sogAdj = runSogAllowedAllSeasons(ctx.gamesBySeason)
        const penalty = (opts && opts.backToBackPenalty) ?? DEFAULT_BACK_TO_BACK_PENALTY
        const out = new Map()
        for (const g of allGames) {
          const r = preGame.get(g.id)
          if (!r) { out.set(g.id, { pHome: null }); continue }
          const adj = sogAdj.get(g.id) || { home: 0, away: 0 }
          const rawLogistic = homeWinProbability(r.ratingHome + adj.home, r.ratingAway + adj.away, ELO_CONFIG.homeAdvantage)
          const poissonP = closedFormWinProbability(rawLogistic)
          const final = applyRestAdjustment(poissonP, g, allGames, penalty)
          out.set(g.id, { pHome: final })
        }
        return out
      },
    },
  ]
}

// Gruppiert ein chronologisches Spiele-Array in eine Liste
// season-chronologischer Teil-Arrays (Reihenfolge = erstes Vorkommen der
// Saison) - Hilfsfunktion für run.js/predictors.js gemeinsam.
export function groupBySeasonOrdered(gamesChronological) {
  const order = []
  const bySeason = new Map()
  for (const g of gamesChronological) {
    if (!bySeason.has(g.season)) { bySeason.set(g.season, []); order.push(g.season) }
    bySeason.get(g.season).push(g)
  }
  return order.map((s) => bySeason.get(s))
}
