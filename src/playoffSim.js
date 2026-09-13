// ---------------------------------------------------------------------------
// Monte-Carlo-Simulation für Playoff-Wahrscheinlichkeiten
//
// Simuliert 10'000 komplette Saisonverläufe. Torgenerierung und OT/SO-Anteile
// sind gegen die historischen NL-Saisons 2017/18–2025/26 kalibriert
// (server/scripts/backtest-montecarlo.js; Corona-Saisons 2019/20 + 2020/21
// bei der Kalibrierung ausgeklammert). Validierte Parameter, siehe dort:
//   - supremacySlope = 4
//   - Pace-Faktor (Offense/Defense-Ratio) deaktiviert – brachte im Backtest
//     keine Verbesserung (konsistent mit dem Power-Ranking-Backtest: reine
//     Tor-Statistiken liefern über ELO hinaus keinen Prognosewert)
//   - Regulationstore ~ Poisson (Varianz ≈ Mittelwert in den historischen
//     Nicht-Corona-Daten, exzellenter Poisson-Fit)
//   - otShareOfTies = 60.56% / SO-Anteil 39.44% (Anteil an Spielen, die nach
//     60 Minuten UNENTSCHIEDEN sind – nicht an allen Spielen!)
//   - Teamstärke = produktives ELO (src/elo.js, UNVERÄNDERT) + validierter
//     SOG-zugelassen-Faktor (identische Formel wie src/powerRankings.js,
//     hier dupliziert, da Power Ranking nicht verändert werden soll)
//
// Behobene Fehler der vorherigen Version:
//   1. Torerwartung wurde als LIGA-GESAMTTORE/SPIEL an JEDES Team einzeln
//      übergeben (~2x zu hohe Torzahlen). Jetzt: Liga-Heim-/Auswärts-Tore
//      getrennt kalibriert, Summe ergibt die reale Gesamttor-Erwartung.
//   2. Heimvorteil wirkte nur auf die OT/SO-Auslosung, nicht auf die
//      Torzahlen selbst. Jetzt: Heimvorteil (über die ELO-Wahrscheinlichkeit)
//      bestimmt die Tor-Supremacy und damit direkt die Torerwartung.
//   3. otProb wurde mit der GESAMT-OT+SO-Quote aller Spiele belegt, aber als
//      Anteil "OT vs. SO UNTER DEN UNENTSCHIEDEN" verwendet. Jetzt korrekt:
//      otShareOfTies bezieht sich nur auf die nach 60 Minuten unentschiedenen
//      Spiele; wie oft es überhaupt zu einem Unentschieden kommt, ergibt sich
//      aus der (jetzt realistisch kalibrierten) Poisson-Torverteilung selbst.
// ---------------------------------------------------------------------------

import { isFinalGame, computeStandings, buildHeadToHeadPointsMap, compareTiebreak } from './stats.js'
import { computeElo, homeWinProbability, ELO_CONFIG } from './elo.js'

export const SIMULATION_RUNS = 10000

// Aktueller NL-Modus (14 Teams, Saison 2026/27):
//   Rang 1-6:   direkt Viertelfinal
//   Rang 7-10:  Play-in um die letzten 2 VF-Plätze (siehe simulateSeasonProjections)
//   Rang 11-12: Saisonende
//   Rang 13-14: Play-out-Final -> Verlierer in die Ligaqualifikation
export const PLAYOFF_FORMAT = {
  directQuarterfinal: [1, 6],
  playIn: [7, 10],
  seasonEnd: [11, 12],
  playout: [13, 14],
}

// ============================================================================
// KALIBRIERTE PARAMETER (Backtest: server/scripts/backtest-montecarlo.js,
// Nicht-Corona-Saisons 2017/18–2025/26)
// ============================================================================

const CALIBRATION = {
  leagueHomeGPG: 3.0496,     // Ø Heimtore/Spiel (historisch, ohne Corona-Saisons)
  leagueAwayGPG: 2.5309,     // Ø Auswärtstore/Spiel (historisch, ohne Corona-Saisons)
  supremacySlope: 4,         // erwartete Tordifferenz-Verschiebung pro Wahrscheinlichkeitspunkt
  otShareOfTies: 0.6056,     // Anteil OT an (OT+SO) unter den nach 60 Min. unentschiedenen Spielen
  // SO-Anteil ergibt sich als 1 - otShareOfTies = 0.3944
  historicalTieRate: 0.2061, // Ø OT+SO-Quote über alle Spiele (historisch, ohne Corona) - nur zur Anzeige
}

// SOG-zugelassen-Adjustierung – identische Formel/Werte wie POWER_CONFIG.sogAllowed
// in src/powerRankings.js (bewusst dupliziert statt importiert, siehe Kommentar oben).
const SOG_ADJUSTMENT = {
  weight: 0.15,
  minGamesFullConfidence: 10,
  maxZScore: 2.5,
}
const LOGIT_TO_ELO = 400 / Math.LN10

// ============================================================================
// SEEDED RANDOM NUMBER GENERATOR (für Reproducibility)
//
// Mulberry32 (Tommy Ettinger, Public Domain) - ersetzt den vorherigen
// Turbo-Pascal-LCG (`seed = (seed*9301+49297) % 233280`), dessen Periode von
// nur 233'280 durch die pro 10'000er-Batch verbrauchten ~32,4 Mio.
// Zufallszahlen um das ~139-fache überschritten wurde (siehe
// server/scripts/diagnose-seed-sensitivity.js). Das führte zu stark
// korrelierten statt unabhängigen Läufen und dadurch zu einer unnatürlich
// hohen Seed-zu-Seed-Streuung der Meisterwahrscheinlichkeiten.
//
// Mulberry32: 32-Bit-State, volle Periode 2^32 (≈4,29 Mrd.) - übersteigt den
// tatsächlichen Verbrauch pro Batch um mehr als das 130-fache, besteht
// gängige Zufallszahlen-Testsuiten (PractRand u.a.) für diesen
// Anwendungsfall (Spielsimulation, keine Kryptografie) und ist eine der am
// weitesten verbreiteten, öffentlich dokumentierten PRNGs für genau dieses
// Szenario. Bewusst kein `crypto`/`Math.random()` - die Simulation bleibt
// vollständig deterministisch, nur die interne Mischfunktion ist stärker.
// API (Konstruktor mit Default-Seed, `next()` -> Zahl in [0,1)) unverändert.
class SeededRandom {
  constructor(seed = 12345) {
    this.seed = seed >>> 0
  }

  next() {
    this.seed = (this.seed + 0x6d2b79f5) | 0
    let t = this.seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ============================================================================
// HILFSFUNKTIONEN
// ============================================================================

// Zugelassene Schüsse/Spiel für ein Team aus den Torhüter-Einträgen in
// playerStats (saves + goalsAgainst = vom Team zugelassene Schüsse).
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
// ligaweit z-normalisiert, mit Konfidenz-Rampe bei wenigen Spielen.
function computeSogAllowedEloAdjustments(teams, games, players) {
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

  for (const s of stats) {
    if (s.perGame == null) continue
    const rawZ = (mean - s.perGame) / std
    const z = Math.max(-SOG_ADJUSTMENT.maxZScore, Math.min(SOG_ADJUSTMENT.maxZScore, rawZ))
    const confidence = Math.min(1, s.gp / SOG_ADJUSTMENT.minGamesFullConfidence)
    adjustments[s.id] = SOG_ADJUSTMENT.weight * z * confidence * LOGIT_TO_ELO
  }
  return adjustments
}

// Erwartete Regulationstore aus der ELO-Heimsieg-Wahrscheinlichkeit:
// Tor-Supremacy = supremacySlope * (pHome - 0.5), symmetrisch auf die
// kalibrierte Liga-Heim-/Auswärts-Gesamttorerwartung verteilt.
function expectedGoals(pHome) {
  const supremacy = CALIBRATION.supremacySlope * (pHome - 0.5)
  const totalExpected = CALIBRATION.leagueHomeGPG + CALIBRATION.leagueAwayGPG
  return {
    expHome: Math.max(0.2, totalExpected / 2 + supremacy / 2),
    expAway: Math.max(0.2, totalExpected / 2 - supremacy / 2),
  }
}

// Poisson-Sample über Knuths Algorithmus.
function poissonSample(rng, lambda) {
  const L = Math.exp(-lambda)
  let k = 0
  let p = 1
  do {
    k++
    p *= rng.next()
  } while (p > L)
  return k - 1
}

// ============================================================================
// FIXTURE-VORBEREITUNG (extrahiert, damit ein einzelnes Spiel/eine Teilmenge
// des Spielplans auch ausserhalb der 10'000er-Simulation - z.B. für einen
// Schritt-für-Schritt-Was-wäre-wenn-Modus - dieselbe, unveränderte
// Teamstärke-/Torerwartungs-Logik nutzen kann. Reines Refactoring, keine
// Änderung an Formel oder Kalibrierung.
// ============================================================================

// Baut ein einzelnes Fixture (Heimsieg-Wahrscheinlichkeit + erwartete Tore)
// aus ELO + SOG-zugelassen-Faktor für ein beliebiges Team-Paar. Extrahiert
// aus computeFixtures()'s bisherigem inline .map() (reines Refactoring,
// identische Formel/Werte) - wird jetzt zusätzlich von simulateSeasonProjections()
// wiederverwendet, um Playoff-Bracket-Partien mit EXAKT derselben Team-
// stärke-Logik wie die Regular-Season-Spiele zu bilden (keine neue Formel).
function buildFixture(homeId, awayId, eloRatings, sogAdjustments, eloStart, homeAdvElo) {
  const eloHome = (eloRatings[homeId] ?? eloStart) + (sogAdjustments[homeId] ?? 0)
  const eloAway = (eloRatings[awayId] ?? eloStart) + (sogAdjustments[awayId] ?? 0)
  const pHome = homeWinProbability(eloHome, eloAway, homeAdvElo)
  const { expHome, expAway } = expectedGoals(pHome)
  return { home: homeId, away: awayId, pHome, expHome, expAway }
}

// Bereitet für alle `status: 'scheduled'`-Einträge in `games` die eingefrorene
// (Stand "heute") Teamstärke auf: ELO + SOG-zugelassen-Faktor -> Heimsieg-
// Wahrscheinlichkeit -> erwartete Heim-/Auswärtstore.
// `initialRatings` (optional): Pre-Season-ELO-Startwerte pro Team (siehe
// src/preseasonElo.js) - wird 1:1 an computeElo() durchgereicht, sonst
// unverändertes Verhalten (alle Teams starten bei eloStart).
export function computeFixtures(teams, games, settings, players = [], initialRatings) {
  const finalGames = games.filter(isFinalGame)
  const scheduled = games.filter((g) => g.status === 'scheduled')

  // Tiebreaker-Basis aus der bereits gespielten Saison: Punkte, Anzahl Siege
  // (regulär + OT/SO) und direkter Vergleich (siehe compareTiebreak in
  // src/stats.js) - dieselbe Reihenfolge wie in der echten Tabelle
  // (computeStandings), damit die Monte-Carlo-Ranglisten unten (inkl.
  // Playoff-/Play-in-/Play-out-Seeding) konsistent zur echten Tabelle sind.
  const startStandings = computeStandings(teams, finalGames)
  const startPts = {}
  const startWins = {}
  startStandings.forEach((r) => {
    startPts[r.team.id] = r.pts
    startWins[r.team.id] = r.w + r.otw
  })
  const startH2H = buildHeadToHeadPointsMap(finalGames)

  const eloStart = settings?.eloStart ?? ELO_CONFIG.eloStart
  const homeAdvElo = settings?.eloHomeAdvantage ?? ELO_CONFIG.homeAdvantage
  const { ratings: eloRatings } = computeElo(teams, finalGames, settings, initialRatings)

  const sogAdjustments = computeSogAllowedEloAdjustments(teams, finalGames, players)

  const fixtures = scheduled.map((g) => buildFixture(g.homeTeamId, g.awayTeamId, eloRatings, sogAdjustments, eloStart, homeAdvElo))

  return { fixtures, startPts, startWins, startH2H, eloRatings, eloStart, homeAdvElo, sogAdjustments }
}

// Simuliert genau EIN Spiel (Poisson-Regulationstore + kalibrierte OT/SO-
// Behandlung bei Gleichstand) - exakt dieselbe Logik wie in der 10'000er-
// Schleife unten, nur pro Aufruf statt in einer Schleife. Verbraucht bei
// Gleichstand zwei zusätzliche Zufallszahlen (OT/SO-Auslosung, Gewinner),
// exakt wie zuvor - der Zufallsstrom bei gleichem Seed bleibt unverändert.
export function simulateGameResult(rng, fixture) {
  const homeGoals = poissonSample(rng, fixture.expHome)
  const awayGoals = poissonSample(rng, fixture.expAway)

  if (homeGoals === awayGoals) {
    const isOT = rng.next() < CALIBRATION.otShareOfTies
    const homeWinsExtra = rng.next() < fixture.pHome
    return {
      homeGoals: homeGoals + (homeWinsExtra ? 1 : 0),
      awayGoals: awayGoals + (homeWinsExtra ? 0 : 1),
      decision: isOT ? 'OT' : 'SO',
    }
  }
  return { homeGoals, awayGoals, decision: 'REG' }
}

// ============================================================================
// PLAYOFF-BRACKET (echte Turnier-Simulation statt reiner Rang-Ableitung für
// Meister/Final/Halbfinal)
//
// Verwendet das bestehende, UNVERÄNDERTE PLAYOFF_FORMAT (siehe oben) - kein
// NHL-Format, sondern exakt der aktuelle Schweizer NL-Modus (14 Teams):
//   Rang 1-6:   direkt Viertelfinal ("directQuarterfinal")
//   Rang 7-10:  Play-in, 2 Plätze im Viertelfinal ("playIn")
//   Rang 11-12: Saisonende
//   Rang 13-14: Play-out-Final -> Verlierer Ligaqualifikation ("playout")
//
// PLAY-IN (Rang 7-10, NICHT Best-of-3):
//   - Spiel A: 7 vs. 8 -> Sieger direkt VF, als Bracket-Seed 7.
//   - Spiel B: 9 vs. 10 -> Sieger weiter in die Entscheidung.
//   - Entscheidung: Verlierer(7v8) vs. Sieger(9v10) -> Sieger VF, als
//     Bracket-Seed 8.
//   Jede der drei Paarungen ist Hin-/Rückspiel: der laut Regular-Season-Rang
//   schlechter platzierte Teilnehmer der Paarung ist im Hinspiel zu Hause,
//   der besser platzierte im Rückspiel. Entscheidend ist die Gesamttordifferenz
//   über beide Spiele (120 Minuten); bei Gleichstand fällt die Entscheidung
//   per Sudden-Death-Overtime im Rückspiel (siehe simulateTwoLegSeries()).
//
// PLAYOFFS (8 Teams, Rang 1-6 + die 2 Play-in-Sieger):
//   - Viertelfinal: Best-of-7, Paarung 1-8/2-7/3-6/4-5 nach Rang (Seed 7/8 =
//     Play-in-Sieger, s.o.).
//   - Halbfinal: Best-of-7, die 4 Viertelfinal-Sieger werden nach ihrem
//     ursprünglichen Regular-Season-Rang neu gepaart (bester vs. schlechtester
//     Rest usw. - "Reseeding").
//   - Final: Best-of-7, die beiden Halbfinal-Sieger.
//   In jeder Best-of-7-Serie erhält das ranghöhere Team das Heimrecht-Muster
//   2-2-1-1-1 (mehr Heimspiele) - unabhängig davon, wer die Serie gewinnt.
//
// PLAY-OUT (Rang 13-14): Best-of-7, ranghöheres Team (13) mit Heimrecht-Muster
// 2-2-1-1-1 wie die übrigen Best-of-7-Serien. Verlierer -> Ligaqualifikation
// gegen den Swiss-League-Meister (dieser Gegner ist nicht Teil des
// Datenmodells - hier wird nur die Wahrscheinlichkeit erfasst, in die
// Ligaqualifikation zu müssen, nicht deren Ausgang).
//
// Jede einzelne Partie nutzt EXAKT dieselbe, unveränderte
// simulateGameResult()- bzw. simulateRegulationGoals()-Logik (Poisson-Tore,
// ELO-basierter Heimvorteil über buildFixture()) wie die Regular Season -
// keine neue Tor- oder Wahrscheinlichkeitsformel.
// ============================================================================

const BO7_HOME_PATTERN = [true, true, false, false, true, false, true]
const BO7_WINS_NEEDED = 4

// Simuliert eine Playoff-Serie zwischen zwei Teams, Partie für Partie, mit
// der unveränderten simulateGameResult()-Logik. Gibt die Team-ID des
// Serien-Siegers zurück.
function simulateSeries(rng, betterSeedId, worseSeedId, winsNeeded, homePattern, eloRatings, sogAdjustments, eloStart, homeAdvElo) {
  let betterWins = 0
  let worseWins = 0
  let g = 0
  while (betterWins < winsNeeded && worseWins < winsNeeded) {
    const betterHosts = homePattern[g] ?? true
    const homeId = betterHosts ? betterSeedId : worseSeedId
    const awayId = betterHosts ? worseSeedId : betterSeedId
    const fixture = buildFixture(homeId, awayId, eloRatings, sogAdjustments, eloStart, homeAdvElo)
    const res = simulateGameResult(rng, fixture)
    const homeWon = res.homeGoals > res.awayGoals
    const winnerId = homeWon ? homeId : awayId
    if (winnerId === betterSeedId) betterWins++
    else worseWins++
    g++
  }
  return betterWins > worseWins ? betterSeedId : worseSeedId
}

// Nur die Poisson-Regulationstore eines Fixtures (kein OT/SO) - Baustein für
// die Play-in-/Play-out-Zweikämpfe, deren 120-Minuten-Gesamttordifferenz sich
// NUR aus den beiden Regulationsergebnissen ergibt (siehe simulateTwoLegSeries).
function simulateRegulationGoals(rng, fixture) {
  return {
    homeGoals: poissonSample(rng, fixture.expHome),
    awayGoals: poissonSample(rng, fixture.expAway),
  }
}

// Play-in-Zweikampf (Hin-/Rückspiel): der schlechter platzierte Teilnehmer
// (`worseId`) ist im Hinspiel zu Hause, der besser platzierte (`betterId`) im
// Rückspiel. Entscheidend ist die Gesamttordifferenz über beide Regulations-
// ergebnisse (120 Minuten); bei Gleichstand Sudden-Death-Overtime im
// Rückspiel (Gewinn-Wahrscheinlichkeit wie gehabt aus der ELO-Heimsieg-
// Wahrscheinlichkeit des Rückspiel-Fixtures). Gibt die Team-ID des Siegers
// zurück.
function simulateTwoLegSeries(rng, betterId, worseId, eloRatings, sogAdjustments, eloStart, homeAdvElo) {
  const leg1 = buildFixture(worseId, betterId, eloRatings, sogAdjustments, eloStart, homeAdvElo)
  const leg1Goals = simulateRegulationGoals(rng, leg1) // home=worseId, away=betterId

  const leg2 = buildFixture(betterId, worseId, eloRatings, sogAdjustments, eloStart, homeAdvElo)
  const leg2Goals = simulateRegulationGoals(rng, leg2) // home=betterId, away=worseId

  const betterAgg = leg1Goals.awayGoals + leg2Goals.homeGoals
  const worseAgg = leg1Goals.homeGoals + leg2Goals.awayGoals

  if (betterAgg !== worseAgg) {
    return betterAgg > worseAgg ? betterId : worseId
  }
  const homeWinsExtra = rng.next() < leg2.pHome
  return homeWinsExtra ? betterId : worseId
}

// Wrapper um simulateTwoLegSeries(): bestimmt "besser"/"schlechter platziert"
// aus dem Regular-Season-Rang (rankOf), unabhängig davon, welche der beiden
// Team-IDs als erstes übergeben wird - so lässt sich derselbe Helper für
// beliebige Play-in-Paarungen (auch mit bereits ermittelten Vorrunden-
// Siegern) verwenden.
function twoLegWinner(rng, idA, idB, rankOf, eloRatings, sogAdjustments, eloStart, homeAdvElo) {
  const better = rankOf[idA] <= rankOf[idB] ? idA : idB
  const worse = better === idA ? idB : idA
  return simulateTwoLegSeries(rng, better, worse, eloRatings, sogAdjustments, eloStart, homeAdvElo)
}

// ============================================================================
// HAUPTFUNKTION
//
// Simuliert `runs` komplette Saisons (Regular Season -> Rangliste -> Play-in
// -> Playoff-Bracket -> Meister, plus Play-out/Ligaqualifikation am
// Tabellenende) in EINEM Durchlauf und sammelt dabei pro Team alle
// benötigten Statistiken (Playoffs/Top6/Play-in/Halbfinal/Final/Meister/
// Play-out/Ligaqualifikation, Rangverteilung, Punkte inkl. Median/Best-/
// Worst-Case). Kein separater Simulationslauf pro Tabellenzeile/Team.
// ============================================================================

export function simulateSeasonProjections(
  teams,
  games,
  settings,
  { runs = SIMULATION_RUNS, seed = 12345, players = [], initialRatings } = {}
) {
  const { fixtures, startPts, startWins, startH2H, eloRatings, eloStart, homeAdvElo, sogAdjustments } =
    computeFixtures(teams, games, settings, players, initialRatings)

  if (fixtures.length === 0) {
    return null
  }

  const teamIds = teams.map((t) => t.id)
  const n = teamIds.length
  // Bracket-/Play-in-/Play-out-Simulation setzt exakt das aktuelle 14-Team-
  // Format voraus (siehe Kommentar oben). Bei einer abweichenden Teamanzahl
  // (z.B. in Tests mit wenigen Teams) wird nur die Regular-Season-Ableitung
  // (Playoffs/Top6) berechnet, alles Weitere bleibt dann 0 - kein Absturz.
  const canRunBracket =
    n >= PLAYOFF_FORMAT.playout[1] &&
    PLAYOFF_FORMAT.directQuarterfinal[0] === 1 &&
    PLAYOFF_FORMAT.directQuarterfinal[1] - PLAYOFF_FORMAT.directQuarterfinal[0] + 1 === 6 &&
    PLAYOFF_FORMAT.playIn[1] - PLAYOFF_FORMAT.playIn[0] + 1 === 4 &&
    PLAYOFF_FORMAT.playout[1] - PLAYOFF_FORMAT.playout[0] + 1 === 2

  // === SIMULATIONEN ===

  const results = {}
  teamIds.forEach((id) => {
    results[id] = {
      playoffs: 0,
      top6: 0,
      top4: 0,
      playIn: 0,
      playout1314: 0,
      ligaqualifikation: 0,
      semifinal: 0,
      final: 0,
      champion: 0,
      ranks: {},
      minPts: Infinity,
      maxPts: -Infinity,
      sumPts: 0,
      allPts: [], // für Median - runs bleibt in der Praxis im 4-5-stelligen Bereich, unkritisch
      sumRank: 0,
      minTore: Infinity,
      maxTore: -Infinity,
      sumGF: 0,
      sumGA: 0,
    }
    for (let r = 1; r <= n; r++) {
      results[id].ranks[r] = 0
    }
  })

  const rng = new SeededRandom(seed)

  for (let sim = 0; sim < runs; sim++) {
    const pts = {}
    const wins = {}
    const gf = {}
    const ga = {}
    teamIds.forEach((id) => {
      pts[id] = startPts[id]
      wins[id] = startWins[id] || 0
      gf[id] = 0
      ga[id] = 0
    })
    // Direkter Vergleich (Tiebreaker Stufe 3, siehe compareTiebreak in
    // src/stats.js): startet bei den PUNKTEN aus den bereits gespielten
    // Duellen (startH2H) und wird unten pro simuliertem Fixture fortgeschrieben.
    // Pro Simulationslauf eine frische Kopie (inkl. der inneren Objekte, die
    // gleich mutiert werden) - startH2H selbst bleibt unverändert.
    const h2h = new Map()
    startH2H.forEach((entry, key) => h2h.set(key, { ...entry }))

    // --- Regular Season (unverändert ggü. bisherigem simulatePlayoffOdds,
    //     zusätzlich: Siege + direkter Vergleich für den Tiebreaker) ---
    for (const f of fixtures) {
      const { homeGoals, awayGoals, decision } = simulateGameResult(rng, f)
      const homeWon = homeGoals > awayGoals

      // gf/ga zählen weiterhin die Regulationstore VOR dem OT/SO-Entscheidungstor
      // (identisch zum bisherigen Verhalten) - simulateGameResult liefert für
      // OT/SO das inkl. Entscheidungstor, hier wird es für die Torstatistik
      // wieder herausgerechnet.
      const rawHome = decision === 'REG' ? homeGoals : homeGoals - (homeWon ? 1 : 0)
      const rawAway = decision === 'REG' ? awayGoals : awayGoals - (homeWon ? 0 : 1)
      gf[f.home] += rawHome
      ga[f.home] += rawAway
      gf[f.away] += rawAway
      ga[f.away] += rawHome

      let homePts, awayPts
      if (decision === 'REG') {
        homePts = homeWon ? 3 : 0
        awayPts = homeWon ? 0 : 3
        wins[homeWon ? f.home : f.away]++
      } else {
        // Unentschieden nach 60 Min., per OT/SO entschieden: 2 Punkte für den Sieger, 1 für den Verlierer
        homePts = homeWon ? 2 : 1
        awayPts = homeWon ? 1 : 2
        wins[homeWon ? f.home : f.away]++
      }
      pts[f.home] += homePts
      pts[f.away] += awayPts

      const key = f.home < f.away ? `${f.home}|${f.away}` : `${f.away}|${f.home}`
      let entry = h2h.get(key)
      if (!entry) { entry = {}; h2h.set(key, entry) }
      entry[f.home] = (entry[f.home] || 0) + homePts
      entry[f.away] = (entry[f.away] || 0) + awayPts
    }

    // Erstelle Tabelle dieser Simulation - Tiebreaker exakt wie die echte
    // Tabelle (Punkte -> Siege -> direkter Vergleich -> Tordifferenz -> Tore),
    // siehe compareTiebreak() in src/stats.js.
    const order = teamIds
      .map((id) => ({ id, pts: pts[id], wins: wins[id], gf: gf[id], ga: ga[id] }))
      .sort((a, b) => compareTiebreak(a, b, h2h))

    // Zähle Regular-Season-Statistiken
    order.forEach((row, rankIdx) => {
      const rank = rankIdx + 1
      const r = results[row.id]
      r.sumPts += row.pts
      r.allPts.push(row.pts)
      r.sumRank += rank
      r.sumGF += row.gf
      r.sumGA += row.ga
      r.minPts = Math.min(r.minPts, row.pts)
      r.maxPts = Math.max(r.maxPts, row.pts)
      r.minTore = Math.min(r.minTore, row.gf)
      r.maxTore = Math.max(r.maxTore, row.gf)
      r.ranks[rank]++

      if (rank >= PLAYOFF_FORMAT.directQuarterfinal[0] && rank <= PLAYOFF_FORMAT.directQuarterfinal[1]) {
        r.top6++
      }
      // "Top 4" = die 4 besten Teams innerhalb der direkten Quarterfinal-Gruppe (Rang 1-6),
      // NICHT identisch mit der Playoff-Grenze.
      if (rank >= PLAYOFF_FORMAT.directQuarterfinal[0] && rank <= PLAYOFF_FORMAT.directQuarterfinal[0] + 3) {
        r.top4++
      }
      if (rank >= PLAYOFF_FORMAT.playIn[0] && rank <= PLAYOFF_FORMAT.playIn[1]) {
        r.playIn++
      }
      if (rank >= PLAYOFF_FORMAT.playout[0] && rank <= PLAYOFF_FORMAT.playout[1]) {
        r.playout1314++
      }
      if (!canRunBracket && rank <= PLAYOFF_FORMAT.playIn[1]) {
        // Fallback ohne Bracket-Simulation (siehe canRunBracket oben):
        // Rang 1-10 als Näherung für "Playoffs" ausgeben statt 0.
        r.playoffs++
      }
    })

    // --- Play-in, Playoff-Bracket, Play-out ---
    if (canRunBracket) {
      const seedOrder = order.map((o) => o.id) // seedOrder[0] = Rang 1, ... (Index 0-basiert)
      const rankOf = {}
      seedOrder.forEach((id, i) => { rankOf[id] = i + 1 })
      const bracketArgs = [eloRatings, sogAdjustments, eloStart, homeAdvElo]

      // Play-in (Hin-/Rückspiel + Sudden-Death, KEIN Best-of-3):
      //   Spiel A: 7 vs. 8 -> Sieger direkt VF (Bracket-Seed 7)
      //   Spiel B: 9 vs. 10 -> Sieger weiter in die Entscheidung
      //   Entscheidung: Verlierer(7v8) vs. Sieger(9v10) -> Sieger VF (Bracket-Seed 8)
      const s7 = seedOrder[6], s8 = seedOrder[7], s9 = seedOrder[8], s10 = seedOrder[9]
      const winnerA = twoLegWinner(rng, s7, s8, rankOf, ...bracketArgs)
      const loserA = winnerA === s7 ? s8 : s7
      const winnerB = twoLegWinner(rng, s9, s10, rankOf, ...bracketArgs)
      const decisionWinner = twoLegWinner(rng, loserA, winnerB, rankOf, ...bracketArgs)

      // Viertelfinal (Bo7): 1v8, 2v7, 3v6, 4v5 - Bracket-Plätze 7/8 = Play-in-Sieger
      const b1 = seedOrder[0], b2 = seedOrder[1], b3 = seedOrder[2]
      const b4 = seedOrder[3], b5 = seedOrder[4], b6 = seedOrder[5]
      const b7 = winnerA, b8 = decisionWinner

      ;[b1, b2, b3, b4, b5, b6, b7, b8].forEach((id) => { results[id].playoffs++ })

      const qfPairs = [[b1, b8], [b2, b7], [b3, b6], [b4, b5]]
      const qfWinners = qfPairs.map(([idA, idB]) => {
        const rankA = rankOf[idA], rankB = rankOf[idB]
        const better = rankA <= rankB ? idA : idB
        const worse = rankA <= rankB ? idB : idA
        const winner = simulateSeries(rng, better, worse, BO7_WINS_NEEDED, BO7_HOME_PATTERN, ...bracketArgs)
        return { id: winner, rank: rankOf[winner] }
      })
      qfWinners.forEach((w) => { results[w.id].semifinal++ })

      // Halbfinal (Bo7): bester vs. schlechtester Rest, zweitbester vs. drittbester
      qfWinners.sort((a, b) => a.rank - b.rank)
      const sf1Winner = simulateSeries(rng, qfWinners[0].id, qfWinners[3].id, BO7_WINS_NEEDED, BO7_HOME_PATTERN, ...bracketArgs)
      const sf2Winner = simulateSeries(rng, qfWinners[1].id, qfWinners[2].id, BO7_WINS_NEEDED, BO7_HOME_PATTERN, ...bracketArgs)
      results[sf1Winner].final++
      results[sf2Winner].final++

      // Final (Bo7)
      const sf1Rank = rankOf[sf1Winner], sf2Rank = rankOf[sf2Winner]
      const finalBetter = sf1Rank <= sf2Rank ? sf1Winner : sf2Winner
      const finalWorse = sf1Rank <= sf2Rank ? sf2Winner : sf1Winner
      const champion = simulateSeries(rng, finalBetter, finalWorse, BO7_WINS_NEEDED, BO7_HOME_PATTERN, ...bracketArgs)
      results[champion].champion++

      // Play-out (Rang 13/14, Bo7): Verlierer -> Ligaqualifikation gegen den
      // Swiss-League-Meister (nicht Teil des Datenmodells - hier zählt nur
      // die Wahrscheinlichkeit, dort antreten zu müssen, nicht deren Ausgang).
      const s13 = seedOrder[12], s14 = seedOrder[13]
      const playoutWinner = simulateSeries(rng, s13, s14, BO7_WINS_NEEDED, BO7_HOME_PATTERN, ...bracketArgs)
      const playoutLoser = playoutWinner === s13 ? s14 : s13
      results[playoutLoser].ligaqualifikation++
    }
  }

  // === ERGEBNISSE FORMATIEREN ===

  const rows = teams.map((t) => {
    const r = results[t.id]
    const sortedPts = [...r.allPts].sort((a, b) => a - b)
    const mid = sortedPts.length / 2
    const medianPts = sortedPts.length === 0
      ? 0
      : sortedPts.length % 2 === 0
        ? (sortedPts[mid - 1] + sortedPts[mid]) / 2
        : sortedPts[Math.floor(mid)]
    return {
      team: t,
      startPts: startPts[t.id] || 0,
      pPlayoffs: r.playoffs / runs,
      pTop6: r.top6 / runs,
      pTop4: r.top4 / runs,
      pPlayIn: r.playIn / runs,
      pSemifinal: r.semifinal / runs,
      pFinal: r.final / runs,
      pChampion: r.champion / runs,
      pPlayout1314: r.playout1314 / runs,
      pLigaQualifikation: r.ligaqualifikation / runs,
      avgPts: r.sumPts / runs,
      medianPts,
      minPts: r.minPts === Infinity ? 0 : r.minPts,
      maxPts: r.maxPts === -Infinity ? 0 : r.maxPts,
      avgRank: r.sumRank / runs,
      avgGF: r.sumGF / runs,
      avgGA: r.sumGA / runs,
      minGF: r.minTore === Infinity ? 0 : r.minTore,
      maxGF: r.maxTore === -Infinity ? 0 : r.maxTore,
      rankDistribution: r.ranks,
    }
  })

  // Sortiere (identisch zum bisherigen Verhalten von simulatePlayoffOdds)
  rows.sort((a, b) => b.pPlayoffs - a.pPlayoffs || b.avgPts - a.avgPts)

  return {
    runs,
    seed,
    scheduledCount: fixtures.length,
    teamCount: n,
    leagueGPG: CALIBRATION.leagueHomeGPG + CALIBRATION.leagueAwayGPG,
    homeAdvantage: homeAdvElo,
    otRate: CALIBRATION.historicalTieRate,
    bracketSimulated: canRunBracket,
    rows,
    metadata: {
      simulation: 'calibrated_10k',
      factors: [
        'ELO', 'SOG-zugelassen', 'Heimvorteil (in Torerzeugung)', 'Poisson-Toresimulation',
        'kalibrierte OT/SO-Quote', 'Tabellen-Tiebreaker (Punkte/Siege/direkter Vergleich/Tordifferenz/Tore)',
        'Play-in Rang 7-10 (Hin-/Rückspiel + Sudden-Death, kein Best-of-3)',
        'Playoff-Bracket (Bo7 QF/SF/Final, Reseeding)', 'Play-out Rang 13/14 (Bo7) + Ligaqualifikation',
      ],
    },
  }
}

// Bestehende Funktion/Signatur/Rückgabestruktur bleibt für bestehende
// Aufrufer (SimulationTest.jsx, bisher PlayoffOdds.jsx) unverändert nutzbar -
// reiner Wrapper um simulateSeasonProjections(), das eine Obermenge derselben
// Felder liefert (playoffs/top6/top4/Rangverteilung/Punkte identisch berechnet,
// zusätzlich jetzt auch Halbfinal/Final/Meister/Median - ignorierbar für
// bestehenden Code, der nur die alten Felder liest).
export function simulatePlayoffOdds(teams, games, settings, options = {}) {
  return simulateSeasonProjections(teams, games, settings, options)
}

export { SeededRandom }
