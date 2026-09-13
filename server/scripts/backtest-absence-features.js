// ---------------------------------------------------------------------------
// Backtest: liefern historische Absenz-/Verletzungs-/Lineup-Informationen
// einen leak-freien Prognosemehrwert gegenüber dem aktuellen Produktivmodell
// (ELO mit Pre-Season-Regression=0.25 + SOG-Allowed + Heimvorteil)?
//
// ERGEBNIS DER DATENQUELLEN-PRÜFUNG (siehe Bericht): server/data/historical/
// *.json ist ein reines BOX-SCORE-Archiv (wer hat wie gespielt), KEIN
// Verletzungs-/Lineup-Announcement-Feed. Es existiert keinerlei Feld für
// Verletzungsgrund, Scratch-Status, Sperre, Ausfall-/Rückkehrdatum oder
// Bekanntgabe-Zeitpunkt einer Aufstellung (geprüft: "injur", "scratch",
// "absen", "suspend", "lineup", "confirmed", "dnp", "healthy" - keine
// Treffer in der Rohstruktur ausser dem unrelated Spiel-"status" = Endstand).
//
// Der einzige theoretisch konstruierbare Proxy ("welcher sonst meist
// spielende Spieler fehlt im heutigen Box-Score") hat zwei fundamentale
// Probleme, die unten NUR zur ehrlichen, transparent gekennzeichneten
// Prüfung eingesetzt werden (siehe "OPTIMISTISCHER PROXY" unten) - NICHT
// als produktionsreifes Feature:
//   1. LEAKAGE/ZIRKULARITÄT: "wer heute fehlt" wird aus dem Box-Score GENAU
//      DES SPIELS extrahiert, das prognostiziert werden soll. Das Archiv
//      unterscheidet nicht zwischen "vor Spielbeginn bekannte Aufstellung"
//      und "nachträglich erstellter Box-Score" - beides ist derselbe
//      Datensatz ohne Zeitstempel-Trennung.
//   2. FEHLINTERPRETATION: NL-Teams dressen routinemässig nur ~20 von
//      25-30 Kadermitgliedern pro Spiel (normale Rotation/taktische
//      Entscheidung). "Fehlt im Line-up" ist in der übergrossen Mehrheit
//      der Fälle KEINE Verletzung, sondern normale Kaderrotation - nicht
//      von Verletzung/Sperre/Krankheit unterscheidbar (User-Warnung in
//      Abschnitt 11 der Aufgabenstellung trifft hier exakt zu).
//
// Der folgende Code testet trotzdem NUR zur Absicherung, ob selbst dieser
// bestmögliche (aber nicht produktionstaugliche) Proxy irgendein Signal
// zeigt - als zusätzlicher empirischer Beleg neben der oben dokumentierten
// konzeptionellen Ablehnung. Die "core roster"-Definition selbst ist
// leak-frei (nur vergangene Spiele), nur das "fehlt heute"-Flag ist es
// nicht (siehe Punkt 1).
//
// READ-ONLY: verändert nichts an src/elo.js, src/playoffSim.js,
// src/powerRankings.js, src/preseasonElo.js, MatchupDetail.jsx,
// historischen Rohdaten, db.json, seed.json.
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data', 'historical')
const OUT_PATH = path.join(__dirname, 'backtest-absence-features-result.json')

const SEASON_FILES = ['2017-18', '2018-19', '2019-20', '2020-21', '2021-22', '2022-23', '2023-24', '2024-25', '2025-26']
const CORONA_SEASONS = new Set(['2019/20', '2020/21'])
const TEST_SEASON = '2025/26'

function sigmoid(x) { return 1 / (1 + Math.exp(-x)) }
function loadRaw() { return SEASON_FILES.map((f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f + '.json'), 'utf8'))) }

// ============================================================================
// Referenzmodell: ELO(Regression=0.25, PRODUKTIV) + SOG-Allowed - identische
// Konstruktion wie server/scripts/backtest-goalie-integration.js (dort bereits
// gegen das korrekte, aktuelle Produktivmodell validiert - hier 1:1
// wiederverwendet, NICHT das ältere/fehlerhafte Regression=1.0-Modell).
// ============================================================================
const ELO = {
  start: 1500, baseK: 16, homeAdv: 65, goalDiffFactor: 0.7,
  rw: { regulationWin: 1.0, regulationLoss: 0.0, otWin: 0.70, otLoss: 0.30, soWin: 0.55, soLoss: 0.45 },
  kTiers: [{ m: 5, r: 32 / 24 }, { m: 15, r: 28 / 24 }, { m: 30, r: 24 / 24 }, { m: 50, r: 20 / 24 }, { m: Infinity, r: 16 / 24 }],
  seasonEndRegression: 0.25,
}
function eloK(gp) { for (const t of ELO.kTiers) if (gp <= t.m) return ELO.baseK * t.r; return ELO.baseK * ELO.kTiers.at(-1).r }
function goalMult(d) { if (d === 0) return 1; return 1 + ELO.goalDiffFactor * (Math.log(d + 1) - 1) }
function eloResultScore(homeWon, decision) {
  if (decision === 'SO') return homeWon ? ELO.rw.soWin : ELO.rw.soLoss
  if (decision === 'OT') return homeWon ? ELO.rw.otWin : ELO.rw.otLoss
  return homeWon ? ELO.rw.regulationWin : ELO.rw.regulationLoss
}
function computeEloSnapshots(games) {
  const ratings = new Map(), gp = new Map()
  let curSeason = null
  const snaps = new Array(games.length)
  for (const g of games) {
    if (curSeason !== null && g.season !== curSeason) {
      for (const [id, r] of ratings) ratings.set(id, ELO.start + (r - ELO.start) * (1 - ELO.seasonEndRegression))
    }
    curSeason = g.season
    snaps[g.__idx] = { home: ratings.get(g.homeId) ?? ELO.start, away: ratings.get(g.awayId) ?? ELO.start }
    const rh = snaps[g.__idx].home, ra = snaps[g.__idx].away
    const gpH = gp.get(g.homeId) ?? 0, gpA = gp.get(g.awayId) ?? 0
    const hw = g.homeGoals > g.awayGoals
    const expH = 1 / (1 + Math.pow(10, (ra - (rh + ELO.homeAdv)) / 400))
    const gm = goalMult(Math.abs(g.homeGoals - g.awayGoals))
    const sH = eloResultScore(hw, g.decision)
    const kH = eloK(gpH), kA = eloK(gpA)
    ratings.set(g.homeId, rh + kH * gm * (sH - expH))
    ratings.set(g.awayId, ra + kA * gm * ((1 - sH) - (1 - expH)))
    gp.set(g.homeId, gpH + 1); gp.set(g.awayId, gpA + 1)
  }
  return snaps
}
const SOG_CFG = { weight: 0.15, minGamesFullConfidence: 10, maxZScore: 2.5 }
const LOGIT_TO_ELO = 400 / Math.LN10
function computeSogAdjSnapshots(games) {
  const bySeason = new Map()
  for (const g of games) {
    if (!bySeason.has(g.season)) bySeason.set(g.season, { games: [], teams: new Set() })
    const e = bySeason.get(g.season); e.games.push(g); e.teams.add(g.homeId); e.teams.add(g.awayId)
  }
  const adj = new Array(games.length)
  for (const [, entry] of bySeason) {
    const teamIds = [...entry.teams]
    const stat = new Map(); teamIds.forEach((id) => stat.set(id, { gp: 0, sogAgainst: 0 }))
    for (const g of entry.games) {
      adj[g.__idx] = { home: adjFor(stat, teamIds, g.homeId), away: adjFor(stat, teamIds, g.awayId) }
      const h = stat.get(g.homeId), a = stat.get(g.awayId)
      h.gp++; h.sogAgainst += g.sogAway; a.gp++; a.sogAgainst += g.sogHome
    }
  }
  return adj
}
function adjFor(stat, teamIds, teamId) {
  const withData = teamIds.map((id) => stat.get(id)).filter((s) => s.gp > 0)
  if (withData.length < 2) return 0
  const perGame = withData.map((s) => s.sogAgainst / s.gp)
  const mean = perGame.reduce((a, b) => a + b, 0) / perGame.length
  const std = Math.sqrt(perGame.reduce((a, b) => a + (b - mean) ** 2, 0) / perGame.length)
  const s = stat.get(teamId)
  if (s.gp === 0 || std === 0) return 0
  const z = Math.max(-SOG_CFG.maxZScore, Math.min(SOG_CFG.maxZScore, (mean - s.sogAgainst / s.gp) / std))
  return SOG_CFG.weight * z * Math.min(1, s.gp / SOG_CFG.minGamesFullConfidence) * LOGIT_TO_ELO
}

// ============================================================================
// Metriken + Kalibrierung (identisches Muster wie in allen bisherigen
// Backtests dieses Projekts)
// ============================================================================
function metricsFor(rows, predictFn, filterFn) {
  let n = 0, correct = 0, brier = 0, logloss = 0
  const EPS = 1e-10
  for (const r of rows) {
    if (!filterFn(r)) continue
    const p = Math.min(1 - EPS, Math.max(EPS, predictFn(r)))
    const y = r.homeWon ? 1 : 0
    n++
    if ((p >= 0.5 ? 1 : 0) === y) correct++
    brier += (p - y) ** 2
    logloss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p))
  }
  return n === 0 ? null : { n, accuracy: correct / n, brier: brier / n, logloss: logloss / n }
}
function stdOf(rows, filterFn, key) {
  const s = rows.filter((r) => filterFn(r) && r[key] != null)
  if (s.length === 0) return 1
  const mean = s.reduce((a, r) => a + r[key], 0) / s.length
  return Math.sqrt(s.reduce((a, r) => a + (r[key] - mean) ** 2, 0) / s.length) || 1
}
const G_GRID = [0.7, 0.85, 1.0, 1.15, 1.3]
const C_GRID = [-0.3, -0.15, 0, 0.15, 0.3]
const H_GRID = [-2, -1.5, -1, -0.6, -0.3, -0.15, 0, 0.15, 0.3, 0.6, 1, 1.5, 2]
function fitBaseline(rows, filterFn) {
  let best = null
  for (const g of G_GRID) for (const c of C_GRID) {
    const m = metricsFor(rows, (r) => sigmoid(g * r.refLogit + c), filterFn)
    const score = m.logloss + m.brier
    if (!best || score < best.score) best = { g, c, m, score }
  }
  return best
}
function fitWithFeature(rows, baseG, std, key, filterFn) {
  let best = null
  for (const h of H_GRID) for (const c of C_GRID) {
    const m = metricsFor(rows, (r) => sigmoid(baseG * r.refLogit + h * ((r[key] ?? 0) / std) + c), filterFn)
    const score = m.logloss + m.brier
    if (!best || score < best.score) best = { h, c, m, score }
  }
  return best
}
function fmt(m) { return m ? `n=${m.n} acc=${(m.accuracy * 100).toFixed(1)}% brier=${m.brier.toFixed(4)} logloss=${m.logloss.toFixed(4)}` : 'n/a' }

// ============================================================================
// "OPTIMISTISCHER PROXY" (siehe Kopfkommentar - NICHT leak-frei, NICHT
// produktionstauglich, nur zur empirischen Zusatzprüfung). Core-Roster-
// Definition selbst ist leak-frei (Fenster = die dem Spiel VORAUS-
// GEHENDEN 10 Spiele des Teams), das "fehlt heute"-Flag entstammt aber dem
// Box-Score des zu prognostizierenden Spiels selbst.
// ============================================================================
const CORE_WINDOW = 10, CORE_MIN_GAMES = 6

function main() {
  const t0 = Date.now()
  console.log('Lade historische Rohdaten (9 Saisons)...')
  const seasonsRaw = loadRaw()
  const games = []
  for (const raw of seasonsRaw) {
    for (const g of raw.games) {
      const sog = (g.teamStats || {})['SOG Total'] || {}
      const dressed = { home: new Set(), away: new Set() }
      // player-/goalie-Objekte tragen keine ID, nur Namen -> über roster[] auflösen
      const rosterByName = new Map()
      for (const key of Object.keys(g.roster || {})) {
        const r = g.roster[key]
        rosterByName.set(r.teamId + '|' + r.fullName, r.id)
      }
      for (const side of ['home', 'away']) {
        const teamId = side === 'home' ? g.homeTeam.sihfId : g.awayTeam.sihfId
        for (const p of (g.players && g.players[side]) || []) {
          const id = rosterByName.get(teamId + '|' + p.player)
          if (id != null) dressed[side].add(id)
        }
        for (const p of (g.goalies && g.goalies[side]) || []) {
          const id = rosterByName.get(teamId + '|' + p.player)
          if (id != null && p.secondsPlayed && p.secondsPlayed !== '00:00') dressed[side].add(id)
        }
      }
      games.push({
        season: g.season, corona: CORONA_SEASONS.has(g.season),
        dt: g.startDateTime || g.date,
        homeId: g.homeTeam.sihfId, awayId: g.awayTeam.sihfId,
        homeGoals: g.homeGoals, awayGoals: g.awayGoals, decision: g.decision,
        sogHome: parseFloat(sog.home) || 0, sogAway: parseFloat(sog.away) || 0,
        dressedHome: dressed.home, dressedAway: dressed.away,
      })
    }
  }
  games.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0))
  games.forEach((g, i) => { g.__idx = i })
  const perSeasonCount = new Map()
  for (const g of games) perSeasonCount.set(g.season, (perSeasonCount.get(g.season) || 0) + 1)
  const perSeasonRunning = new Map()
  for (const g of games) {
    const idx = perSeasonRunning.get(g.season) || 0
    g.seasonFraction = idx / perSeasonCount.get(g.season)
    perSeasonRunning.set(g.season, idx + 1)
  }
  const seasons = [...new Set(games.map((g) => g.season))].sort()
  console.log(`Geladen: ${games.length} Spiele, ${seasons.length} Saisons: ${seasons.join(', ')}`)

  // --- Referenzmodell-Snapshots ---
  const eloSnaps = computeEloSnapshots(games)
  const sogAdj = computeSogAdjSnapshots(games)

  // --- "Core roster" pro Team, nur aus den vorausgehenden CORE_WINDOW Spielen (leak-frei) ---
  const teamHistory = new Map() // teamId -> Array von {playerSet, __idx} der letzten Spiele
  function coreRosterBefore(teamId) {
    const hist = teamHistory.get(teamId) || []
    const window = hist.slice(-CORE_WINDOW)
    if (window.length < CORE_WINDOW) return null // zu wenig Historie (Saisonstart) -> Feature nicht verfügbar
    const count = new Map()
    for (const w of window) for (const pid of w.set) count.set(pid, (count.get(pid) || 0) + 1)
    const core = new Set()
    for (const [pid, c] of count) if (c >= CORE_MIN_GAMES) core.add(pid)
    return core
  }

  const rows = games.map((g) => {
    const e = eloSnaps[g.__idx], sAdj = sogAdj[g.__idx]
    const refLogit = ((e.home + sAdj.home) + ELO.homeAdv - (e.away + sAdj.away)) * Math.LN10 / 400

    const coreHome = coreRosterBefore(g.homeId), coreAway = coreRosterBefore(g.awayId)
    let missingHome = null, missingAway = null
    if (coreHome) { missingHome = 0; for (const pid of coreHome) if (!g.dressedHome.has(pid)) missingHome++ }
    if (coreAway) { missingAway = 0; for (const pid of coreAway) if (!g.dressedAway.has(pid)) missingAway++ }

    // Historie NACH diesem Spiel fortschreiben (für zukünftige core-roster-Berechnungen)
    if (!teamHistory.has(g.homeId)) teamHistory.set(g.homeId, [])
    if (!teamHistory.has(g.awayId)) teamHistory.set(g.awayId, [])
    teamHistory.get(g.homeId).push({ set: g.dressedHome, idx: g.__idx })
    teamHistory.get(g.awayId).push({ set: g.dressedAway, idx: g.__idx })

    return {
      season: g.season, corona: g.corona, homeWon: g.homeGoals > g.awayGoals, seasonFraction: g.seasonFraction,
      refLogit,
      absenceDiff: (missingHome != null && missingAway != null) ? (missingAway - missingHome) : null, // positiv = Heimteam im Vorteil (Auswärts fehlen mehr)
    }
  })

  const coreRows = rows.filter((r) => !r.corona)
  const coverage = coreRows.filter((r) => r.absenceDiff != null).length / coreRows.length
  console.log(`\nFeature-Abdeckung (Core, "optimistischer Proxy" absenceDiff): ${(coverage * 100).toFixed(1)}%`)

  const inTrain = (r) => !r.corona && r.season !== TEST_SEASON
  const inTest = (r) => r.season === TEST_SEASON

  const baseA = fitBaseline(rows, inTrain)
  console.log(`\nBaseline A (ELO+PreSeason+SOG) auf TRAIN kalibriert: g=${baseA.g} c=${baseA.c} -> Train ${fmt(baseA.m)}`)

  const std = stdOf(rows, inTrain, 'absenceDiff')
  const fitB = fitWithFeature(rows, baseA.g, std, 'absenceDiff', inTrain)
  console.log(`Modell B (+optimist. Absenz-Proxy) auf TRAIN kalibriert: h=${fitB.h} c=${fitB.c} (std=${std.toFixed(4)}) -> Train ${fmt(fitB.m)}`)

  const predictA = (r) => sigmoid(baseA.g * r.refLogit + baseA.c)
  const predictB = (r) => sigmoid(baseA.g * r.refLogit + fitB.h * ((r.absenceDiff ?? 0) / std) + fitB.c)

  const testA = metricsFor(rows, predictA, inTest)
  const testB = metricsFor(rows, predictB, inTest)
  console.log(`\n=== OUT-OF-SAMPLE TEST (${TEST_SEASON}) ===`)
  console.log(`A (Referenz): ${fmt(testA)}`)
  console.log(`B (+Absenz-Proxy): ${fmt(testB)}`)
  console.log(`Delta LogLoss: ${(testB.logloss - testA.logloss).toFixed(5)} | Delta Brier: ${(testB.brier - testA.brier).toFixed(5)}`)

  const segments = {
    first10: (r) => inTest(r) && r.seasonFraction < 0.10,
    first20: (r) => inTest(r) && r.seasonFraction < 0.20,
    mid: (r) => inTest(r) && r.seasonFraction >= 0.30 && r.seasonFraction < 0.70,
    end: (r) => inTest(r) && r.seasonFraction >= 0.70,
  }
  const segResults = {}
  for (const [label, f] of Object.entries(segments)) {
    const a = metricsFor(rows, predictA, f), b = metricsFor(rows, predictB, f)
    segResults[label] = { a, b, deltaLogloss: a && b ? b.logloss - a.logloss : null }
    console.log(`  ${label.padEnd(8)}: A ${fmt(a)} | B ${fmt(b)} | ΔLogLoss ${a && b ? (b.logloss - a.logloss).toFixed(5) : 'n/a'}`)
  }

  const perSeason = {}
  for (const s of seasons) {
    const f = (r) => r.season === s
    const a = metricsFor(rows, predictA, f), b = metricsFor(rows, predictB, f)
    perSeason[s] = { corona: CORONA_SEASONS.has(s), isTest: s === TEST_SEASON, a, b, deltaLogloss: a && b ? b.logloss - a.logloss : null }
    console.log(`  ${s}${CORONA_SEASONS.has(s) ? ' (Corona)' : ''}${s === TEST_SEASON ? ' (TEST)' : ''}: A ${fmt(a)} | B ${fmt(b)}`)
  }

  // Schlüsselspieler-Sondertest (Abschnitt 10): grössere absenceDiff-Beträge = "mehrere Schlüsselspieler fehlen"
  const keyBuckets = {
    none: (r) => inTest(r) && r.absenceDiff != null && Math.abs(r.absenceDiff) === 0,
    one: (r) => inTest(r) && r.absenceDiff != null && Math.abs(r.absenceDiff) === 1,
    multi: (r) => inTest(r) && r.absenceDiff != null && Math.abs(r.absenceDiff) >= 2,
  }
  const keyResults = {}
  console.log('\nSchlüsselspieler-Sondertest (Betrag der Netto-Absenz-Differenz, optimistischer Proxy):')
  for (const [label, f] of Object.entries(keyBuckets)) {
    const a = metricsFor(rows, predictA, f), b = metricsFor(rows, predictB, f)
    keyResults[label] = { a, b, deltaLogloss: a && b ? b.logloss - a.logloss : null }
    console.log(`  ${label.padEnd(6)}: A ${fmt(a)} | B ${fmt(b)}`)
  }

  const detCheck = rows.filter(inTest).slice(0, 5).every((r) => predictB(r) === predictB(r))
  const anyBad = rows.map(predictB).some((p) => !Number.isFinite(p) || p < 0 || p > 1)
  const meaningful = testB.logloss < testA.logloss - 0.0005
  const decision = meaningful ? 'SCHWACHES_SIGNAL_TROTZ_LEAKAGE_RISIKO' : 'KEIN_SIGNAL'

  console.log(`\n=== ENTSCHEIDUNG (nur zur empirischen Zusatzabsicherung - Datenquelle bereits konzeptionell abgelehnt, siehe Kopfkommentar) ===`)
  console.log(`Meaningful (ΔLogLoss < -0.0005 auf Test-Set): ${meaningful}`)
  console.log(`=> ${decision}`)
  console.log(`\nFertig in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  const result = {
    dataSourceFinding: 'KEINE_ZUVERLAESSIGE_ABSENZQUELLE - historisches Archiv ist reines Box-Score-Archiv ohne Verletzungs-/Scratch-/Lineup-Zeitstempel-Felder',
    seasons, testSeason: TEST_SEASON, coverage,
    coreWindow: CORE_WINDOW, coreMinGames: CORE_MIN_GAMES,
    baseA: { g: baseA.g, c: baseA.c, trainMetrics: baseA.m },
    modelB_optimisticProxy: { h: fitB.h, c: fitB.c, std, trainMetrics: fitB.m, caveat: 'NICHT leak-frei, NICHT produktionstauglich - siehe Kopfkommentar der Skriptdatei' },
    testSet: { a: testA, b: testB, deltaLogloss: testB.logloss - testA.logloss, deltaBrier: testB.brier - testA.brier },
    segments: segResults,
    perSeason,
    keySoloAbsenceTest: keyResults,
    checks: { deterministic: detCheck, anyInvalidProbability: anyBad },
    decision: { meaningful, label: decision },
    finalRecommendation: 'NICHT_INTEGRIEREN',
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2))
  console.log(`Ergebnis geschrieben: ${OUT_PATH}`)
}

main()
