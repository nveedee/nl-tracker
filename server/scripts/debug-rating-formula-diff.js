// ---------------------------------------------------------------------------
// ROOT-CAUSE-UNTERSUCHUNG: Zeile-für-Zeile-Vergleich zwischen dem
// EXPLORATIVEN Rating (server/playerRatingBacktestCore.js::
// computeHistSkaterRating) und der ECHTEN PRODUKTIONSFORMEL
// (src/playerRating.js::calculatePlayerRating), für denselben Spieler,
// dasselbe Cutoff-Datum, dieselben zugrunde liegenden historischen Rohdaten.
//
// Read-only, verändert NICHTS an Produktionscode. Nur Analyse.
//
// Aufruf: node server/scripts/debug-rating-formula-diff.js
// ---------------------------------------------------------------------------

import { loadHistoricalGames, createSkaterTracker, snapshotSkaterRates, updateSkaterTracker, buildSkaterBaselineFromRates, computeHistSkaterRating } from '../playerRatingBacktestCore.js'
import { calculatePlayerRating, buildSkaterRatingBaselines } from '../../src/playerRating.js'

const SEASON = '2023/24'
const CUTOFF_GAME_INDEX = 300 // tief in der Saison - viele Spieler mit ausreichend GP

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

function fmt(v, d = 3) { return v == null ? 'null' : (typeof v === 'number' ? v.toFixed(d) : String(v)) }
function diffOf(a, b) { if (a == null || b == null) return (a == null && b == null) ? 0 : null; return a - b }

function main() {
  console.log('ROOT-CAUSE-UNTERSUCHUNG: Explorativ vs. Produktion (calculatePlayerRating)')
  console.log('='.repeat(100))

  const allGames = loadHistoricalGames({ seasonFiles: ['2023-24'] })
  const seasonGames = allGames.filter((g) => g.season === SEASON)
  const gamesSoFar = seasonGames.slice(0, CUTOFF_GAME_INDEX)
  const cutoffDate = gamesSoFar[gamesSoFar.length - 1].date
  console.log(`Saison: ${SEASON}, Cutoff nach ${gamesSoFar.length} Spielen (Datum: ${cutoffDate})`)

  // ---------------------------------------------------------------------
  // EXPLORATIVER Zustand aufbauen (identisch zu runIntegrationWalkForward()
  // in backtest-player-rating-integration.js: Tracker inkrementell mit ALLEN
  // Spielen bis zum Cutoff füttern, Baseline EINMAL aus dem finalen Zustand
  // bauen - reproduziert exakt, was der echte explorative Backtest an diesem
  // Punkt im Walk sehen würde).
  // ---------------------------------------------------------------------
  const tracker = createSkaterTracker()
  for (const g of gamesSoFar) for (const s of g.skaters) updateSkaterTracker(tracker, s, g.season)

  const explRatesByPos = { F: [], D: [] }
  const seenPlayers = new Set()
  for (const g of gamesSoFar) {
    for (const s of g.skaters) {
      if (seenPlayers.has(s.playerId)) continue
      seenPlayers.add(s.playerId)
      const snap = snapshotSkaterRates(tracker, s.playerId, SEASON)
      if (snap.season && snap.position) explRatesByPos[snap.position].push(snap.season)
    }
  }
  const explBaseline = buildSkaterBaselineFromRates(explRatesByPos)

  // ---------------------------------------------------------------------
  // PRODUKTIONS-Zustand aufbauen (identisch zu runProductionFormulaWalk() in
  // backtest-player-rating-production-formula.js: Live-Format-Konvertierung,
  // players-Liste aus playerMeta, buildSkaterRatingBaselines()).
  // ---------------------------------------------------------------------
  const playerMeta = new Map()
  const liveGames = []
  for (const g of gamesSoFar) {
    for (const s of g.skaters) playerMeta.set(String(s.playerId), { id: String(s.playerId), teamId: s.teamId, position: s.position })
    liveGames.push({ id: g.gameId, date: g.date, status: 'final', homeTeamId: g.homeTeamId, awayTeamId: g.awayTeamId, playerStats: g.skaters.map(toLivePlayerStatsRow) })
  }
  const prodPlayers = [...playerMeta.values()]
  const prodBaseline = buildSkaterRatingBaselines(prodPlayers, liveGames)

  console.log(`\nBaseline-Populationsgrössen: explorativ F=${explBaseline.F.n} D=${explBaseline.D.n} | Produktion F=${prodBaseline.F.n} D=${prodBaseline.D.n}`)
  for (const key of ['pointsPerGame', 'goalsPerGame', 'plusMinusPerGame', 'toiPerGame', 'blockedShotsPerGame']) {
    console.log(`  Baseline F.${key}: explorativ mean=${fmt(explBaseline.F[key].mean)} std=${fmt(explBaseline.F[key].std)}  |  Produktion mean=${fmt(prodBaseline.F[key].mean)} std=${fmt(prodBaseline.F[key].std)}`)
  }

  // ---------------------------------------------------------------------
  // Stichprobe: alle Spieler mit gp>=10 in BEIDEN Systemen (>= 100 Spieler
  // gefordert) - direkter Vergleich Rate-für-Rate, Komponente-für-Komponente.
  // ---------------------------------------------------------------------
  const sampleIds = [...seenPlayers].filter((pid) => {
    const snap = snapshotSkaterRates(tracker, pid, SEASON)
    return snap.season && snap.season.gp >= 10
  })
  console.log(`\nStichprobe (gp>=10 in beiden Systemen): ${sampleIds.length} Spieler`)

  const RATE_COMPONENTS = [
    'pointsPerGame', 'goalsPerGame', 'assistsPerGame', 'sogPerGame', 'plusMinusPerGame',
    'blockedShotsPerGame', 'toiPerGame', 'ppToiPerGame', 'pkToiPerGame', 'faceoffPercentage',
  ]
  const sumAbsDiff = Object.fromEntries(RATE_COMPONENTS.map((k) => [k, 0]))
  const countDiff = Object.fromEntries(RATE_COMPONENTS.map((k) => [k, 0]))
  let printedSamples = 0
  const overallZDiffs = []
  const gpBucketDiffs = { '1-4': [], '5-9': [], '10+': [] }
  const posDiffs = { F: [], D: [] }
  let firstDivergingExample = null

  for (const pid of sampleIds) {
    const explSnap = snapshotSkaterRates(tracker, pid, SEASON)
    const explRating = computeHistSkaterRating(explSnap, explBaseline, {})
    const prodRating = calculatePlayerRating(String(pid), liveGames, { players: prodPlayers, asOfDate: cutoffDateNextDay(cutoffDate), skaterBaselines: prodBaseline })
    if (!explRating || !prodRating) continue

    const explRates = explSnap.season
    const prodRates = prodRating.components.rates

    for (const key of RATE_COMPONENTS) {
      const d = diffOf(explRates?.[key], prodRates?.[key])
      if (d != null) { sumAbsDiff[key] += Math.abs(d); countDiff[key]++ }
      else if (explRates?.[key] != null || prodRates?.[key] != null) {
        // eine Seite null, die andere nicht - zählt als maximale Diskrepanz (1 Einheit "vorhanden vs. fehlend")
        countDiff[key]++
      }
    }

    if (printedSamples < 15) {
      console.log(`\n--- Spieler SIHF-ID ${pid} (${explSnap.position}, gp=${explRates.gp}) ---`)
      console.log('  Komponente'.padEnd(20) + 'Explorativ'.padEnd(14) + 'Produktion'.padEnd(14) + 'Diff')
      for (const key of RATE_COMPONENTS) {
        const e = explRates?.[key], p = prodRates?.[key]
        const d = diffOf(e, p)
        console.log(`  ${key.padEnd(18)}${fmt(e).padEnd(14)}${fmt(p).padEnd(14)}${d == null ? (e == null) !== (p == null) ? 'NULL-MISMATCH' : '0' : fmt(d)}`)
      }
      console.log(`  overall(0-100)   ${fmt(explRating.overall, 1).padEnd(14)}${fmt(prodRating.overall, 1).padEnd(14)}${fmt(diffOf(explRating.overall, prodRating.overall), 1)}`)
      console.log(`  overallZ         ${fmt(explRating.overallZ).padEnd(14)}${fmt(prodRating.overallZ).padEnd(14)}${fmt(diffOf(explRating.overallZ, prodRating.overallZ))}`)
      console.log(`  confidence       ${fmt(explRating.confidence, 1).padEnd(14)}${fmt(prodRating.confidence, 1).padEnd(14)}${fmt(diffOf(explRating.confidence, prodRating.confidence), 1)}`)
      printedSamples++
    }

    const zDiff = diffOf(explRating.overallZ, prodRating.overallZ)
    if (zDiff != null) {
      overallZDiffs.push(zDiff)
      posDiffs[explSnap.position]?.push(zDiff)
      const gp = explRates.gp
      const bucket = gp <= 4 ? '1-4' : gp <= 9 ? '5-9' : '10+'
      gpBucketDiffs[bucket].push(zDiff)
      if (!firstDivergingExample && Math.abs(zDiff) > 0.05) {
        firstDivergingExample = { pid, position: explSnap.position, gp, explRates, prodRates, explRating, prodRating }
      }
    }
  }

  console.log('\n' + '='.repeat(100))
  console.log(`AGGREGIERTE KOMPONENTEN-ABWEICHUNG (n=${sampleIds.length} Spieler, mittlere absolute Differenz)`)
  console.log('='.repeat(100))
  console.log('Komponente'.padEnd(20) + 'Ø|Diff|'.padEnd(14) + 'n mit Diff!=0/Null-Mismatch')
  const sortedComponents = [...RATE_COMPONENTS].sort((a, b) => (sumAbsDiff[b] / (countDiff[b] || 1)) - (sumAbsDiff[a] / (countDiff[a] || 1)))
  for (const key of sortedComponents) {
    const avg = countDiff[key] > 0 ? sumAbsDiff[key] / countDiff[key] : 0
    console.log(`${key.padEnd(20)}${fmt(avg, 5).padEnd(14)}${countDiff[key]}`)
  }

  console.log('\n' + '-'.repeat(100))
  console.log('overallZ-DIFFERENZ (explorativ - produktion)')
  console.log('-'.repeat(100))
  console.log(`n=${overallZDiffs.length}, Ø=${fmt(mean(overallZDiffs))}, Ø|Diff|=${fmt(mean(overallZDiffs.map(Math.abs)))}, Median=${fmt(median(overallZDiffs))}`)
  console.log(`Forward (F): n=${posDiffs.F.length}, Ø=${fmt(mean(posDiffs.F))}, Ø|Diff|=${fmt(mean(posDiffs.F.map(Math.abs)))}`)
  console.log(`Defense (D): n=${posDiffs.D.length}, Ø=${fmt(mean(posDiffs.D))}, Ø|Diff|=${fmt(mean(posDiffs.D.map(Math.abs)))}`)
  for (const bucket of ['1-4', '5-9', '10+']) {
    const arr = gpBucketDiffs[bucket]
    console.log(`GP-Bucket ${bucket}: n=${arr.length}, Ø=${fmt(mean(arr))}, Ø|Diff|=${fmt(mean(arr.map(Math.abs)))}`)
  }

  if (firstDivergingExample) {
    console.log('\n' + '='.repeat(100))
    console.log('ERSTES BEISPIEL MIT SPÜRBARER overallZ-DIVERGENZ (|Diff| > 0.05) - Detailanalyse')
    console.log('='.repeat(100))
    const ex = firstDivergingExample
    console.log(`Spieler SIHF-ID ${ex.pid}, Position ${ex.position}, GP=${ex.gp}`)
    console.log('explorative Rates:', JSON.stringify(ex.explRates))
    console.log('Produktions-Rates:', JSON.stringify(ex.prodRates))
    console.log('explorative Rating:', JSON.stringify(ex.explRating))
    console.log('Produktions-Rating:', JSON.stringify({ ...ex.prodRating, components: { ...ex.prodRating.components, rates: '(oben)' } }))
  }
}

function cutoffDateNextDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null }
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

main()
