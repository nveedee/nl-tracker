// ---------------------------------------------------------------------------
// Match-Detailseite (/matchup/:gameId) - professionelle Pre-Game Analytics /
// Match Preview für ein einzelnes Spiel (geplant oder bereits gespielt).
// Verwendet ausschliesslich bestehende, unveränderte Produktivfunktionen
// (ELO, Power Ranking, Monte-Carlo-Simulation) sowie die für die
// Head-to-Head-Seite gebauten Hilfsfunktionen (src/headToHead.js) - keine
// neue Prognoselogik, keine erfundenen Daten, keine neuen Gewichtungen.
// Rein lesend, speichert nichts.
// ---------------------------------------------------------------------------

import { useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge } from '../components/ui.jsx'
import { isFinalGame, computeStandings, computeHomeSplits } from '../stats.js'
import { computePowerRankings } from '../powerRankings.js'
import { homeWinProbability, ELO_CONFIG } from '../elo.js'
import { computeFixtures, simulateGameResult, SeededRandom } from '../playoffSim.js'
import { buildScorelineMatrix, buildGoalDistribution, expectedGoals } from '../scorelineMatrix.js'
import ScorelineMatrix from '../components/ScorelineMatrix.jsx'
import ExpectedGoals from '../components/ExpectedGoals.jsx'
import GoalProbabilities from '../components/GoalProbabilities.jsx'
import LiveMatchHeader from '../components/LiveMatchHeader.jsx'
import LiveWinProbabilityPanel from '../components/LiveWinProbabilityPanel.jsx'
import LiveGameTimeline from '../components/LiveGameTimeline.jsx'
import LiveStatistics from '../components/LiveStatistics.jsx'
import { buildDemoLiveMatch, DEMO_PERIOD_MARKERS, DEMO_MAX_MINUTE } from '../liveDemoData.js'
import { usePreseasonElo, computePreseasonRatings } from '../preseasonElo.js'
import { computeMarketValuePrior, DEFAULT_PRIOR_SPREAD } from '../marketValuePrior.js'
import { applyRestAdjustment, computeRestAdjustment, DEFAULT_BACK_TO_BACK_PENALTY } from '../restDays.js'
import {
  mergeMatchups, summarizeRecord, summarizeHomeAway,
  computeRecentFormDetailed, computeShotsAllowedPerGame, useHistoricalH2H,
} from '../headToHead.js'

function fmt2(v) { return v == null ? '–' : v.toFixed(2) }
function fmtPct(v) { return v == null ? '–' : (v * 100).toFixed(1) + '%' }
function fmtPct0(v) { return v == null ? '–' : Math.round(v * 100) + '%' }
function fmtDateTime(iso) {
  if (!iso) return '–'
  const d = new Date(iso)
  return d.toLocaleDateString('de-CH') + ', ' + d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
}

const BADGE_STYLE = {
  S: { bg: 'var(--good)', label: 'S' }, OTS: { bg: 'var(--good)', label: 'OTS' }, SOS: { bg: 'var(--good)', label: 'SOS' },
  N: { bg: 'var(--bad)', label: 'N' }, OTN: { bg: 'var(--bad)', label: 'OTN' }, SON: { bg: 'var(--bad)', label: 'SON' },
}
function ResultBadge({ code }) {
  const s = BADGE_STYLE[code] || { bg: 'var(--text-dim)', label: code }
  return (
    <span style={{
      display: 'inline-block', minWidth: 30, textAlign: 'center', padding: '2px 6px',
      borderRadius: 5, fontSize: 11, fontWeight: 700, color: '#fff', background: s.bg,
    }}>
      {s.label}
    </span>
  )
}

function StatTile({ label, value }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 18 }}>{value}</div>
    </div>
  )
}

// Vergleichszeile mit dezenter Hervorhebung des besseren Werts (Text
// fett + Akzentfarbe) - keine Balken/Boxen, keine Erfindung neuer Werte.
function CompareRow({ label, v1, v2, fmt = (v) => v, lowerIsBetter = false, sub }) {
  const has1 = v1 != null, has2 = v2 != null
  let w1 = false, w2 = false
  if (has1 && has2 && v1 !== v2) {
    const firstBetter = lowerIsBetter ? v1 < v2 : v1 > v2
    w1 = firstBetter
    w2 = !firstBetter
  }
  const cellStyle = (won) => won ? { fontWeight: 800, color: 'var(--accent)' } : { fontWeight: 600 }
  return (
    <tr>
      <td className="left muted" style={{ fontSize: 12.5 }}>{label}{sub && <div style={{ fontSize: 10.5, marginTop: 1 }}>{sub}</div>}</td>
      <td className="num" style={cellStyle(w1)}>{has1 ? fmt(v1) : '–'}</td>
      <td className="num" style={cellStyle(w2)}>{has2 ? fmt(v2) : '–'}</td>
    </tr>
  )
}

function resultCode(won, decision) {
  if (decision === 'SO') return won ? 'SOS' : 'SON'
  if (decision === 'OT') return won ? 'OTS' : 'OTN'
  return won ? 'S' : 'N'
}

// Simuliert GENAU dieses eine Spiel 10'000x mit den bestehenden, unveränderten
// Bausteinen aus src/playoffSim.js: computeFixtures() liefert dieselbe
// kalibrierte Teamstärke/Torerwartung (ELO + SOG-Faktor, unverändert),
// simulateGameResult() dieselbe Poisson-/OT-SO-Logik wie die Playoff-
// Simulation. Keine neue Formel - nur eine andere Aggregation (pro Spiel
// statt pro Saison, inkl. Endresultat-Häufigkeit) derselben Bausteine.
// `homeGoals`/`awayGoals` je Lauf sind das FINALE Ergebnis (inkl. OT/SO-
// Entscheidungstor, siehe simulateGameResult()) - dieselbe Definition, die
// bereits für pHomeWin/topScores unten verwendet wird. Die Scoreline-Matrix
// (src/scorelineMatrix.js) nutzt exakt dieselben `runs` Läufe wie
// topScores/pHomeWin - keine zweite/separate Simulation nur für die Matrix.
function simulateSingleGame(teams, allGames, settings, players, homeTeamId, awayTeamId, initialRatings, runs = 10000, seed = 424242) {
  const finalGames = allGames.filter(isFinalGame)
  const targetGame = { id: '__matchup_sim__', homeTeamId, awayTeamId, status: 'scheduled', date: '2999-01-01' }
  const { fixtures } = computeFixtures(teams, [...finalGames, targetGame], settings, players, initialRatings)
  const fixture = fixtures.find((f) => f.home === homeTeamId && f.away === awayTeamId)
  if (!fixture) return null

  const rng = new SeededRandom(seed)
  let homeWins = 0, awayWins = 0, ot = 0, so = 0
  const scoreCounts = new Map()
  const results = new Array(runs)
  for (let i = 0; i < runs; i++) {
    const r = simulateGameResult(rng, fixture)
    results[i] = r
    if (r.homeGoals > r.awayGoals) homeWins++
    else awayWins++
    if (r.decision === 'OT') ot++
    else if (r.decision === 'SO') so++
    const key = `${r.homeGoals}:${r.awayGoals}`
    scoreCounts.set(key, (scoreCounts.get(key) || 0) + 1)
  }
  // Scoreline-Matrix, Goal-Distribution (Expected Goals + Goal Probabilities
  // by Team, src/components/ExpectedGoals.jsx + GoalProbabilities.jsx) und
  // topScores nutzen alle exakt dieselben `results` - eine Datenquelle,
  // drei Aggregationen (siehe scorelineMatrix.js für die Begründung der
  // unterschiedlichen Bucket-Caps: 5+ für die Matrix, 6+ für die reine
  // Team-Torverteilung).
  const scoreline = buildScorelineMatrix(results)
  const goalDist = {
    home: buildGoalDistribution(results, 'homeGoals'),
    away: buildGoalDistribution(results, 'awayGoals'),
  }
  const xg = expectedGoals(results)
  const topScores = [...scoreCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([score, count]) => ({ score, count, pct: count / runs }))

  return {
    runs,
    pHomeWin: homeWins / runs,
    pAwayWin: awayWins / runs,
    pOT: ot / runs,
    pSO: so / runs,
    avgHomeGoals: xg.homeXG,
    avgAwayGoals: xg.awayXG,
    xg,
    goalDist,
    topScores,
    scoreline,
  }
}

// Fliesstext, warum das Modell ein Team vorne sieht - ausschliesslich aus
// tatsächlich vorhandenen Modellwerten abgeleitet (ELO, Heimvorteil,
// SOG-zugelassen, Form, Power Ranking). Keine subjektiven Einschätzungen.
function buildWhyText(leadTeam, otherTeam, leadIsHome, a) {
  const leadElo = Math.round(leadIsHome ? a.eh : a.ea)
  const otherElo = Math.round(leadIsHome ? a.ea : a.eh)
  const leadForm = leadIsHome ? a.formHome : a.formAway
  const otherForm = leadIsHome ? a.formAway : a.formHome
  const leadSog = leadIsHome ? a.sogHome : a.sogAway
  const otherSog = leadIsHome ? a.sogAway : a.sogHome
  const leadPower = a.powerByTeam[leadTeam.id]?.powerScore
  const otherPower = a.powerByTeam[otherTeam.id]?.powerScore

  // Jeder Faktor wird nur aufgeführt, wenn er TATSÄCHLICH das führende Team
  // begünstigt (nicht nur "Differenz gross genug", sondern auch die richtige
  // Richtung) - sonst würde z.B. ein niedrigeres ELO fälschlich als "höheres
  // ELO" präsentiert.
  const reasons = []
  const counterReasons = []
  if (Math.abs(leadElo - otherElo) >= 5) {
    if (leadElo > otherElo) reasons.push(`einem höheren ELO (${leadElo} vs. ${otherElo})`)
    else counterReasons.push(`einem niedrigeren ELO (${leadElo} vs. ${otherElo})`)
  }
  if (leadIsHome) {
    reasons.push(`dem Heimvorteil (+${a.homeAdv} ELO im Modell)`)
  }
  if (leadSog != null && otherSog != null && Math.abs(leadSog - otherSog) >= 0.5) {
    if (leadSog < otherSog) reasons.push(`der besseren defensiven Schussunterdrückung (${fmt2(leadSog)} vs. ${fmt2(otherSog)} SOG zugelassen/Spiel)`)
    else counterReasons.push(`einer schwächeren defensiven Schussunterdrückung (${fmt2(leadSog)} vs. ${fmt2(otherSog)} SOG zugelassen/Spiel)`)
  }
  if (leadForm.gp > 0 && otherForm.gp > 0 && Math.abs(leadForm.pts / leadForm.gp - otherForm.pts / otherForm.gp) >= 0.15) {
    if (leadForm.pts / leadForm.gp > otherForm.pts / otherForm.gp) reasons.push(`der besseren Form der letzten 5 Spiele (${leadForm.pts} vs. ${otherForm.pts} Punkte)`)
    else counterReasons.push(`der schwächeren Form der letzten 5 Spiele (${leadForm.pts} vs. ${otherForm.pts} Punkte)`)
  }
  if (leadPower != null && otherPower != null && Math.abs(leadPower - otherPower) >= 3) {
    if (leadPower > otherPower) reasons.push(`dem höheren Power Ranking (${leadPower} vs. ${otherPower})`)
    else counterReasons.push(`einem niedrigeren Power Ranking (${leadPower} vs. ${otherPower})`)
  }

  if (reasons.length === 0) {
    return 'Das Modell sieht beide Teams als nahezu gleichwertig – kein einzelner Faktor zeigt einen klaren Vorteil.'
  }
  const first = reasons[0]
  const rest = reasons.slice(1)
  let text = `${leadTeam.name} startet mit ${first}`
  if (rest.length > 0) text += ` und profitiert zusätzlich von ${rest.join(', ')}`
  text += '.'
  if (counterReasons.length > 0) {
    text += ` Dagegen sprechen ${counterReasons.join(', ')} – der Vorteil ist entsprechend knapp.`
  }
  return text
}

export default function MatchupDetail() {
  const { gameId } = useParams()
  const { data, derived } = useData()
  const historical = useHistoricalH2H()
  const preseasonSeasonEnd = usePreseasonElo()
  const loadingHistorical = historical === null
  const [showLiveDemo, setShowLiveDemo] = useState(false)

  const game = data?.games?.find((g) => g.id === gameId)
  const homeTeam = game && data.teams.find((t) => t.id === game.homeTeamId)
  const awayTeam = game && data.teams.find((t) => t.id === game.awayTeamId)
  const played = game ? isFinalGame(game) : false
  // Unveränderlicher Pre-Game Prediction Snapshot (server/scripts/predictions.js),
  // vom SIHF-Sync erzeugt, sobald das Spiel noch geplant war - falls vorhanden,
  // rein informativ angezeigt, nie hier berechnet oder verändert.
  const predictionSnapshot = game ? (data.predictions || []).find((p) => p.gameId === game.id) : null

  const analysis = useMemo(() => {
    if (!game || !homeTeam || !awayTeam || loadingHistorical) return null

    const players = data.players || []
    const eloRatings = derived.elo.ratings
    const eloStart = data.settings?.eloStart ?? ELO_CONFIG.eloStart
    const homeAdv = data.settings?.eloHomeAdvantage ?? ELO_CONFIG.homeAdvantage

    const standings = computeStandings(data.teams, data.games)
    const power = computePowerRankings(data.teams, data.games, eloRatings, players)
    const standingsByTeam = Object.fromEntries(standings.map((s, i) => [s.team.id, { ...s, rank: i + 1 }]))
    const powerByTeam = Object.fromEntries(power.map((p) => [p.team.id, p]))

    const formHome = computeRecentFormDetailed(homeTeam.id, data.games, historical, 5)
    const formAway = computeRecentFormDetailed(awayTeam.id, data.games, historical, 5)
    const sogHome = computeShotsAllowedPerGame(homeTeam.id, data.games, players)
    const sogAway = computeShotsAllowedPerGame(awayTeam.id, data.games, players)
    const homeSplitsHome = computeHomeSplits(homeTeam.id, data.games).home
    const homeSplitsAway = computeHomeSplits(awayTeam.id, data.games).away

    const allMatchups = mergeMatchups(homeTeam.id, awayTeam.id, data.games, historical)
    const hasAnyH2H = allMatchups.length > 0
    const overall = hasAnyH2H
      ? { home: summarizeRecord(homeTeam.id, allMatchups), away: summarizeRecord(awayTeam.id, allMatchups) }
      : null
    const last5 = [...allMatchups].slice(-5).reverse()
    const homeAwaySplit = hasAnyH2H ? summarizeHomeAway(homeTeam.id, awayTeam.id, allMatchups) : null

    const eh = eloRatings[homeTeam.id] ?? eloStart
    const ea = eloRatings[awayTeam.id] ?? eloStart
    const rawPHomeWin = homeWinProbability(eh, ea, homeAdv)

    // Ruhetage/Back-to-back (Erweiterung 2, src/restDays.js): NUR für die
    // Einzelspiel-Prognose dieses konkreten, terminierten Spiels - wirkt sich
    // NICHT auf eloRatings/die Saison-Simulation aus. Bei bereits gespieltem
    // Spiel kein Sinn (Resultat steht fest) -> kein Adjustment.
    const restDaysEnabled = data.settings?.restDaysEnabled !== false
    const backToBackPenalty = data.settings?.backToBackPenalty ?? DEFAULT_BACK_TO_BACK_PENALTY
    const restAdjustment = restDaysEnabled && !played ? computeRestAdjustment(game, data.games, backToBackPenalty) : 0
    const pHomeWin = restAdjustment !== 0 ? applyRestAdjustment(rawPHomeWin, game, data.games, backToBackPenalty) : rawPHomeWin
    const pAwayWin = 1 - pHomeWin

    // Marktwert-Prior (Erweiterung 1, src/marketValuePrior.js) - identische
    // Logik/Priorität wie in DataContext.jsx (derived.eloPriorSource), hier
    // separat berechnet, weil simulateSingleGame() die STARTWERTE braucht (um
    // die Saison bis "jetzt" neu durchzurechnen), nicht die bereits
    // aktualisierten `derived.elo.ratings`.
    const useMarketValue = data.settings?.marketValuePriorEnabled !== false
    const marketPrior = useMarketValue
      ? computeMarketValuePrior(data.teams, players, eloStart, data.settings?.priorSpread ?? DEFAULT_PRIOR_SPREAD)
      : null
    const initialRatings = marketPrior || computePreseasonRatings(preseasonSeasonEnd, eloStart)
    const rawMonteCarlo = played
      ? null
      : simulateSingleGame(data.teams, data.games, data.settings, players, homeTeam.id, awayTeam.id, initialRatings, 10000)
    const monteCarlo = rawMonteCarlo && restAdjustment !== 0
      ? {
          ...rawMonteCarlo,
          pHomeWin: applyRestAdjustment(rawMonteCarlo.pHomeWin, game, data.games, backToBackPenalty),
          pAwayWin: 1 - applyRestAdjustment(rawMonteCarlo.pHomeWin, game, data.games, backToBackPenalty),
        }
      : rawMonteCarlo

    return {
      s1: standingsByTeam[homeTeam.id], s2: standingsByTeam[awayTeam.id], powerByTeam,
      formHome, formAway, sogHome, sogAway, homeSplitsHome, homeSplitsAway,
      hasAnyH2H, overall, last5, homeAwaySplit,
      eh, ea, homeAdv, pHomeWin, pAwayWin, monteCarlo, restAdjustment,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, homeTeam, awayTeam, data, derived, historical, loadingHistorical, played, preseasonSeasonEnd])

  if (!game) {
    return (
      <div className="empty">
        <div className="title">Spiel nicht gefunden</div>
        <div style={{ marginTop: 14 }}><Link className="btn primary" to="/schedule">← Zurück zum Spielplan</Link></div>
      </div>
    )
  }

  const mc = analysis?.monteCarlo
  const leadIsHome = mc ? mc.pHomeWin >= mc.pAwayWin : null
  const leadTeam = leadIsHome == null ? null : (leadIsHome ? homeTeam : awayTeam)
  const otherTeam = leadIsHome == null ? null : (leadIsHome ? awayTeam : homeTeam)

  return (
    <div>
      <div className="row gap-sm mb wrap">
        <Link className="btn ghost sm" to="/schedule">← Zurück zum Spielplan</Link>
        <Link className="btn ghost sm" to={`/head-to-head?team1=${homeTeam.id}&team2=${awayTeam.id}`}>Head-to-Head öffnen</Link>
        <button className="btn ghost sm" onClick={() => setShowLiveDemo((v) => !v)}>
          {showLiveDemo ? 'Live-Ansicht (Demo) ausblenden' : '🔴 Live-Ansicht (Demo) anzeigen'}
        </button>
      </div>

      {/* Live-Match-Ansicht: reines UI-Konzept mit statischen Demo-Daten
          (src/liveDemoData.js), unabhängig von echten Spieldaten/Status.
          Keine SIHF-Anbindung, kein Polling, keine liveState-Struktur im
          Backend - siehe LIVE_PROBABILITY_ANALYSIS.md. Standardmässig
          ausgeblendet, damit die reguläre Seite unverändert bleibt. */}
      {showLiveDemo && homeTeam && awayTeam && (() => {
        const liveDemo = buildDemoLiveMatch(homeTeam, awayTeam)
        return (
          <div className="mb">
            <div className="live-demo-banner">
              <strong style={{ color: 'var(--text)' }}>UI-Konzept:</strong>
              Live-Win/Draw/Loss-Probability. Alle Werte unten sind erfundene Demo-Daten zur Veranschaulichung des Designs - keine echte Live-Verbindung, nichts wird gespeichert.
            </div>
            {/* Header/Chart/Events/Stats als EIN zusammenhängender Live-Bereich
                (.live-section-group entfernt die Zwischenabstände/Radien
                zwischen den einzelnen .card-Blöcken) statt vier separater
                Dashboard-Kacheln. */}
            <div className="live-section-group">
              <LiveMatchHeader homeTeam={homeTeam} awayTeam={awayTeam} live={liveDemo} />
              <LiveWinProbabilityPanel
                homeTeam={homeTeam} awayTeam={awayTeam}
                probability={liveDemo.probability}
                probabilityHistory={liveDemo.probabilityHistory}
                events={liveDemo.events}
                periodMarkers={DEMO_PERIOD_MARKERS}
                maxMinute={DEMO_MAX_MINUTE}
                isLive={liveDemo.isLive}
              />
              <LiveGameTimeline homeTeam={homeTeam} awayTeam={awayTeam} events={liveDemo.events} />
              <LiveStatistics homeTeam={homeTeam} awayTeam={awayTeam} stats={liveDemo.stats} />
            </div>
          </div>
        )
      })()}

      {/* 1. Header - bei aktiver Live-Demo ausgeblendet (Widerspruch sonst:
          "Geplant"/Datum unten vs. LIVE-Badge oben in LiveMatchHeader, das
          Score/Teams bereits eigenständig zeigt - siehe LiveMatchHeader.jsx). */}
      {!showLiveDemo && (
        <div className="card card-pad mb" style={{ textAlign: 'center' }}>
          <div className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
            {new Date(game.date).toLocaleDateString('de-CH', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
            {game.time ? ` · ${game.time} Uhr` : ''}
            {' · '}
            <span className="chip">{played ? 'Beendet' : 'Geplant'}</span>
          </div>
          <div className="row spread" style={{ alignItems: 'center', gap: 20 }}>
            <div style={{ flex: 1, textAlign: 'right' }}>
              <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', marginBottom: 8 }}>HEIM</div>
              <div className="row gap-sm" style={{ justifyContent: 'flex-end' }}>
                <h1 style={{ fontSize: 20 }}>
                  <Link to={`/teams/${homeTeam.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>{homeTeam.name}</Link>
                </h1>
                <span className="dot" style={{ background: homeTeam.color, width: 18, height: 18 }} />
              </div>
            </div>
            <div style={{ fontSize: played ? 30 : 18, fontWeight: 800, minWidth: 110, fontFamily: 'var(--mono)' }}>
              {played ? `${game.homeGoals} : ${game.awayGoals}` : 'vs.'}
              {played && game.decision !== 'REG' && (
                <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginTop: 2 }}>{game.decision}</div>
              )}
            </div>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', marginBottom: 8 }}>AUSWÄRTS</div>
              <div className="row gap-sm">
                <span className="dot" style={{ background: awayTeam.color, width: 18, height: 18 }} />
                <h1 style={{ fontSize: 20 }}>
                  <Link to={`/teams/${awayTeam.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>{awayTeam.name}</Link>
                </h1>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Trennt die Live-Sektion oben klar von der Pre-Game-Modellprognose
          darunter - verhindert Verwechslung von Live Probability und
          Pre-Game Forecast (beides sind unterschiedliche, unabhängige
          Werte). Nur sichtbar, wenn die Live-Demo aktiv ist. */}
      {showLiveDemo && (
        <div className="section-label" style={{ marginTop: 4, marginBottom: 10, textAlign: 'center' }}>
          ── Pre-Game / Vor dem Spiel ──
        </div>
      )}

      {!analysis ? (
        <div className="muted" style={{ padding: '20px 0' }}>Lädt…</div>
      ) : (
        <>
          {/* 1b. Model Forecast (nur für zukünftige Spiele, ausschliesslich aus der
              bestehenden Monte-Carlo-Simulation - keine separate Berechnung) */}
          {!played && mc && (
            <div className="card card-pad mb">
              <div className="row spread" style={{ alignItems: 'baseline', flexWrap: 'wrap', rowGap: 4 }}>
                <div className="section-label">Model Forecast</div>
                {predictionSnapshot && (
                  <span className="muted" style={{ fontSize: 11 }} title={`Modellversion: ${predictionSnapshot.modelVersion}`}>
                    Snapshot gespeichert · {fmtDateTime(predictionSnapshot.createdAt)}
                  </span>
                )}
              </div>
              <div className="row gap-sm wrap" style={{ marginBottom: 8 }}>
                {derived.eloPriorSource === 'marketValue' && (
                  <span className="chip" style={{ fontSize: 10.5 }} title="Start-ELO dieser Saison aus der Summe der Kader-Marktwerte abgeleitet (Einstellungen → Prognose-Erweiterungen)">
                    Vorsaison-Prior aus Marktwert
                  </span>
                )}
                {analysis.restAdjustment !== 0 && (
                  <span className="chip" style={{ fontSize: 10.5 }} title="Ein Team spielt am Vortag bereits (Back-to-back) - Heimsieg-Wahrscheinlichkeit entsprechend angepasst (Einstellungen → Prognose-Erweiterungen)">
                    Back-to-back {analysis.restAdjustment > 0 ? `+${Math.round(analysis.restAdjustment * 100)}%` : `${Math.round(analysis.restAdjustment * 100)}%`} {homeTeam.short}
                  </span>
                )}
              </div>
              <div className="row spread" style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 20, fontWeight: 800 }}>
                  <span style={{ color: leadIsHome ? 'var(--accent)' : 'inherit' }}>{homeTeam.short} {fmtPct0(mc.pHomeWin)}</span>
                  <span className="muted" style={{ margin: '0 8px', fontWeight: 600 }}>—</span>
                  <span style={{ color: !leadIsHome ? 'var(--accent)' : 'inherit' }}>{fmtPct0(mc.pAwayWin)} {awayTeam.short}</span>
                </div>
              </div>
              <div className="bar-track" style={{ height: 8, marginBottom: 18 }}>
                <div className="bar-fill" style={{ width: `${Math.round(mc.pHomeWin * 100)}%` }} />
              </div>
              <div className="tiles" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                <StatTile label={`Erwartete Tore ${homeTeam.short}`} value={fmt2(mc.avgHomeGoals)} />
                <StatTile label={`Erwartete Tore ${awayTeam.short}`} value={fmt2(mc.avgAwayGoals)} />
                <StatTile label="OT-Wahrscheinlichkeit" value={fmtPct(mc.pOT)} />
                <StatTile label="SO-Wahrscheinlichkeit" value={fmtPct(mc.pSO)} />
              </div>
            </div>
          )}

          {/* 1c. Warum liegt Team X vorne - nur zukünftige Spiele, ausschliesslich
              aus bereits vorhandenen Modellwerten (ELO, Heimvorteil, SOG, Form, Power) */}
          {!played && mc && leadTeam && (
            <div className="card card-pad mb">
              <h2 className="mb">Warum {leadTeam.short} vorne liegt</h2>
              <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.6, margin: 0 }}>
                {buildWhyText(leadTeam, otherTeam, leadIsHome, analysis)}
              </p>
            </div>
          )}

          {/* 2. Teamvergleich */}
          <div className="card mb">
            <div className="card-pad" style={{ paddingBottom: 0 }}>
              <h2>Teamvergleich</h2>
            </div>
            <div className="table-wrap" style={{ border: 'none' }}>
              <table>
                <thead>
                  <tr>
                    <th className="left">Kennzahl</th>
                    <th className="num">{homeTeam.short}</th>
                    <th className="num">{awayTeam.short}</th>
                  </tr>
                </thead>
                <tbody>
                  <CompareRow label="ELO" v1={Math.round(analysis.eh)} v2={Math.round(analysis.ea)} />
                  <CompareRow label="Power Score" v1={analysis.powerByTeam[homeTeam.id]?.powerScore ?? null} v2={analysis.powerByTeam[awayTeam.id]?.powerScore ?? null} />
                  <CompareRow label="SOG zugelassen / Spiel" v1={analysis.sogHome} v2={analysis.sogAway} fmt={fmt2} lowerIsBetter />
                  <CompareRow
                    label="Punkte / Spiel"
                    v1={analysis.s1 && analysis.s1.gp > 0 ? analysis.s1.pts / analysis.s1.gp : null}
                    v2={analysis.s2 && analysis.s2.gp > 0 ? analysis.s2.pts / analysis.s2.gp : null}
                    fmt={fmt2}
                  />
                  <CompareRow
                    label="Heim / Auswärts"
                    sub={`${homeTeam.short} zuhause vs. ${awayTeam.short} auswärts`}
                    v1={analysis.homeSplitsHome.gp > 0 ? analysis.homeSplitsHome.pts / analysis.homeSplitsHome.gp : null}
                    v2={analysis.homeSplitsAway.gp > 0 ? analysis.homeSplitsAway.pts / analysis.homeSplitsAway.gp : null}
                    fmt={(v) => fmt2(v) + ' Pkt/Sp'}
                  />
                  <CompareRow
                    label="Letzte 5 Spiele"
                    v1={analysis.formHome.gp > 0 ? analysis.formHome.pts : null}
                    v2={analysis.formAway.gp > 0 ? analysis.formAway.pts : null}
                    fmt={(v) => v + ' Pkt'}
                  />
                </tbody>
              </table>
            </div>
          </div>

          {/* 3. Form */}
          <div className="card card-pad mb">
            <h2>Aktuelle Form</h2>
            <div className="grid grid-2">
              {[[homeTeam, analysis.formHome], [awayTeam, analysis.formAway]].map(([t, f]) => (
                <div key={t.id}>
                  <div className="row spread" style={{ marginBottom: 10 }}>
                    <TeamBadge team={t} link={false} />
                    <span className="row gap-sm">
                      {f.letters.length === 0
                        ? <span className="muted" style={{ fontSize: 12.5 }}>Keine Spiele</span>
                        : [...f.letters].reverse().map((code, i) => <ResultBadge key={i} code={code} />)}
                    </span>
                  </div>
                  {f.games.length === 0 ? (
                    <div className="muted" style={{ fontSize: 13 }}>Keine Spiele vorhanden.</div>
                  ) : (
                    <div className="tiles" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                      <StatTile label="Punkte" value={f.pts} />
                      <StatTile label="Tore" value={f.gf} />
                      <StatTile label="Gegentore" value={f.ga} />
                      <StatTile label="Ø T / GT" value={`${fmt2(f.avgGf)} / ${fmt2(f.avgGa)}`} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 4. Head-to-Head */}
          <div className="card card-pad mb">
            <div className="row spread" style={{ marginBottom: 4 }}>
              <h2>Head-to-Head</h2>
              <span className="chip" style={{ color: 'var(--text-dim)' }}>Historische Daten – nicht Bestandteil der Modellprognose</span>
            </div>
            {!analysis.hasAnyH2H ? (
              <div className="muted mt">Keine historischen Daten verfügbar.</div>
            ) : (
              <>
                <div className="grid grid-2" style={{ marginTop: 16, marginBottom: 16 }}>
                  {[[homeTeam, analysis.overall.home], [awayTeam, analysis.overall.away]].map(([t, r]) => (
                    <div key={t.id}>
                      <div className="row gap-sm" style={{ marginBottom: 8 }}><TeamBadge team={t} link={false} /></div>
                      <div className="tiles" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                        <StatTile label="Spiele (Gesamtbilanz)" value={r.gp} />
                        <StatTile label="Siege" value={r.wins} />
                        <StatTile label="Niederlagen" value={r.losses} />
                        <StatTile label="Tore" value={r.gf} />
                        <StatTile label="Gegentore" value={r.ga} />
                        <StatTile label="OT/SO-Bilanz" value={`${r.otw + r.sow}S / ${r.otl + r.sol}N`} />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                  Heim/Auswärts-Bilanz: {homeTeam.short} zuhause {analysis.homeAwaySplit.team1AtHome.gp} Sp. ({analysis.homeAwaySplit.team1AtHome.wins}S/{analysis.homeAwaySplit.team1AtHome.losses}N)
                  {' · '}{awayTeam.short} zuhause {analysis.homeAwaySplit.team2AtHome.gp} Sp. ({analysis.homeAwaySplit.team2AtHome.wins}S/{analysis.homeAwaySplit.team2AtHome.losses}N)
                </div>
                <div className="section-label">Letzte 5 direkte Duelle</div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th className="left">Datum</th><th className="left">Heim</th><th className="left">Auswärts</th><th className="num">Ergebnis</th><th className="left">Entscheidung</th></tr>
                    </thead>
                    <tbody>
                      {analysis.last5.map((g, i) => {
                        const h = g.homeTeamId === homeTeam.id ? homeTeam : awayTeam
                        const a = g.awayTeamId === homeTeam.id ? homeTeam : awayTeam
                        const homeWon = g.homeGoals > g.awayGoals
                        return (
                          <tr key={i}>
                            <td className="left" style={{ fontSize: 13 }}>
                              {new Date(g.date).toLocaleDateString('de-CH')}
                              {!g.isCurrentSeason && <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>({g.season})</span>}
                            </td>
                            <td className="left" style={{ fontWeight: homeWon ? 700 : 400 }}>{h.short}</td>
                            <td className="left" style={{ fontWeight: !homeWon ? 700 : 400 }}>{a.short}</td>
                            <td className="num"><strong>{g.homeGoals}:{g.awayGoals}</strong></td>
                            <td className="left"><span className="chip">{g.decision}</span></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          {/* 5. Simulationsergebnisse (nur zukünftige Spiele) */}
          {!played && mc && (
            <div className="card card-pad mb">
              <h2 className="mb">Simulationsergebnisse</h2>
              <div className="stat-strip">
                <div className="stat"><strong>{mc.runs.toLocaleString()}</strong><span>Simulationen</span></div>
                <div className="stat"><strong>{fmtPct(mc.pHomeWin)}</strong><span>Heimsieg {homeTeam.short}</span></div>
                <div className="stat"><strong>{fmtPct(mc.pAwayWin)}</strong><span>Auswärtssieg {awayTeam.short}</span></div>
                <div className="stat"><strong>{fmtPct(mc.pOT)}</strong><span>OT</span></div>
                <div className="stat"><strong>{fmtPct(mc.pSO)}</strong><span>SO</span></div>
              </div>
              <div className="section-label">5 häufigste Endresultate</div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th className="left">Endresultat</th><th className="num">Häufigkeit</th></tr>
                  </thead>
                  <tbody>
                    {mc.topScores.map((row) => (
                      <tr key={row.score}>
                        <td className="left" style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{row.score.replace(':', ' : ')}</td>
                        <td className="num">{fmtPct(row.pct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 5a. Expected Goals + Goal Probabilities by Team + Scoreline
              Probabilities (nur zukünftige Spiele) - alle drei aus denselben
              10'000 Läufen wie "Simulationsergebnisse" oben, nur anders
              aggregiert (Ø/Torverteilung je Team/volle Heim-x-Auswärtstore-
              Matrix statt Top-5-Liste). Eine Datenquelle (mc), drei Ansichten. */}
          {!played && mc && (
            <>
              <ExpectedGoals homeTeam={homeTeam} awayTeam={awayTeam} xg={mc.xg} />
              <GoalProbabilities
                homeTeam={homeTeam} awayTeam={awayTeam}
                homeDistribution={mc.goalDist.home} awayDistribution={mc.goalDist.away}
              />
              <ScorelineMatrix homeTeam={homeTeam} awayTeam={awayTeam} scorelineProbabilities={mc.scoreline} />
            </>
          )}

          {/* 5c. Pre-Game Prediction (nur bereits gespielte Spiele mit vorhandenem
              Snapshot) - zeigt EXAKT den beim Sync eingefrorenen Wert, NICHT die
              heutige Modellprognose. Kein Leakage: predictionSnapshot wurde vor
              Spielbeginn gespeichert und seither nie verändert (server/scripts/predictions.js). */}
          {played && predictionSnapshot && (() => {
            const favIsHome = predictionSnapshot.homeWinProbability >= predictionSnapshot.awayWinProbability
            const homeWon = game.homeGoals > game.awayGoals
            const predictionCorrect = favIsHome === homeWon
            return (
              <div className="card card-pad mb">
                <div className="row spread" style={{ alignItems: 'baseline', flexWrap: 'wrap', rowGap: 4 }}>
                  <div className="section-label">Pre-Game Prediction</div>
                  <span className="muted" style={{ fontSize: 11 }} title={`Modellversion: ${predictionSnapshot.modelVersion} · Seed: ${predictionSnapshot.seed}`}>
                    Eingefroren · {fmtDateTime(predictionSnapshot.createdAt)}
                  </span>
                </div>
                <div style={{ fontSize: 18, fontWeight: 800, marginTop: 6, marginBottom: 14 }}>
                  <span style={{ color: favIsHome ? 'var(--accent)' : 'inherit' }}>{homeTeam.short} {fmtPct0(predictionSnapshot.homeWinProbability)}</span>
                  <span className="muted" style={{ margin: '0 8px', fontWeight: 600 }}>—</span>
                  <span style={{ color: !favIsHome ? 'var(--accent)' : 'inherit' }}>{fmtPct0(predictionSnapshot.awayWinProbability)} {awayTeam.short}</span>
                </div>
                <div className="grid grid-2" style={{ marginBottom: 14 }}>
                  <div>
                    <div className="muted" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 4 }}>Tatsächliches Ergebnis</div>
                    <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--mono)' }}>
                      {homeTeam.short} {game.homeGoals} – {game.awayGoals} {awayTeam.short}
                      {game.decision !== 'REG' && <span className="chip" style={{ marginLeft: 8 }}>{game.decision}</span>}
                    </div>
                  </div>
                  <div>
                    <div className="muted" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 4 }}>Prediction</div>
                    <div style={{ fontSize: 16, fontWeight: 800 }} className={predictionCorrect ? 'good' : 'bad'}>
                      {predictionCorrect ? 'Richtig' : 'Falsch'}
                    </div>
                  </div>
                </div>
                <div className="tiles" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                  <StatTile label={`Erwartete Tore ${homeTeam.short}`} value={fmt2(predictionSnapshot.expectedHomeGoals)} />
                  <StatTile label={`Erwartete Tore ${awayTeam.short}`} value={fmt2(predictionSnapshot.expectedAwayGoals)} />
                  <StatTile label="OT-Wahrscheinlichkeit" value={fmtPct(predictionSnapshot.otProbability)} />
                  <StatTile label="SO-Wahrscheinlichkeit" value={fmtPct(predictionSnapshot.soProbability)} />
                </div>
              </div>
            )
          })()}

          {/* 5b. Match-Statistiken (nur bereits gespielte Spiele) */}
          {played && (
            <div className="card card-pad mb">
              <h2>Match-Statistiken</h2>
              {(!game.playerStats || game.playerStats.length === 0) ? (
                <div className="muted">Keine detaillierten Spielstatistiken erfasst.</div>
              ) : (
                <div className="grid grid-2">
                  {[homeTeam, awayTeam].map((t) => {
                    const rosterIds = new Set(data.players.filter((p) => p.teamId === t.id).map((p) => p.id))
                    const stats = game.playerStats.filter((s) => rosterIds.has(s.playerId))
                    const skaters = stats.filter((s) => (s.goals || 0) > 0 || (s.assists || 0) > 0)
                    const goalies = stats.filter((s) => s.saves != null || s.goalsAgainst != null)
                    return (
                      <div key={t.id}>
                        <div className="row gap-sm" style={{ marginBottom: 8 }}><TeamBadge team={t} link={false} /></div>
                        {skaters.length === 0 && goalies.length === 0 ? (
                          <div className="muted" style={{ fontSize: 13 }}>Keine Statistiken für dieses Team.</div>
                        ) : (
                          <>
                            {skaters.map((s, i) => {
                              const p = data.players.find((x) => x.id === s.playerId)
                              return <div key={'sk' + i} style={{ fontSize: 13, padding: '3px 0' }}>{p?.name ?? '?'}: {s.goals || 0}T {s.assists || 0}A</div>
                            })}
                            {goalies.map((s, i) => {
                              const p = data.players.find((x) => x.id === s.playerId)
                              const shots = (Number(s.saves) || 0) + (Number(s.goalsAgainst) || 0)
                              const svp = shots > 0 ? (Number(s.saves) || 0) / shots : null
                              return (
                                <div key={'gk' + i} className="muted" style={{ fontSize: 13, padding: '3px 0' }}>
                                  {p?.name ?? '?'} (G): {s.saves || 0}/{shots} Paraden{svp != null ? ` (${(svp * 100).toFixed(1)}%)` : ''}
                                </div>
                              )
                            })}
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              {!predictionSnapshot && (
                <div className="muted mt" style={{ fontSize: 12 }}>
                  Kein Pre-Game Model Forecast gespeichert – dieses Spiel hatte keinen eingefrorenen Snapshot vor Spielbeginn.
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
