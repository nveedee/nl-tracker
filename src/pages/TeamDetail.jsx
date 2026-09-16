// ---------------------------------------------------------------------------
// Team-Detailseite (/teams/:id) - Team-Analytics-Ebene, analog zur mehrfach
// erweiterten Player-Analytics-Ebene (PlayerDetail.jsx/playerHistory.js).
// Rein deskriptiv/analytisch - VERWENDET ausschliesslich bereits bestehende,
// unveränderte Produktivfunktionen (computeElo/homeWinProbability aus
// elo.js, computeFixtures aus playoffSim.js, computePowerRankings aus
// powerRankings.js, computeStandings/computeHomeSplits/computeTeamForm aus
// stats.js). Keine neue Prognoseformel, nichts fliesst in die Match-Prognose
// zurück - "Schedule Strength" und "Team Strength Profile" sind ausdrücklich
// NUR Anzeige (siehe dortige Kommentare).
// ---------------------------------------------------------------------------

import { useMemo, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge, Modal, toast, SortableTable, MarketValueTrend } from '../components/ui.jsx'
import {
  fmtPct, fmtNum, fmtChf, plusMinusStr, computeHomeSplits,
  isFinalGame,
} from '../stats.js'
import {
  usePlayerHistory, usePositionBaselines, computeTeamRosterProfile, computeTeamDepth,
  getPlayerSeasons, classifyTrend, buildCurrentSeasonRecord,
} from '../playerHistory.js'
import { useTeamHistory, getTeamSeasons, teamSeasonRates, lastNSeasons } from '../teamHistory.js'
import { homeWinProbability } from '../elo.js'
import { computePowerRankings } from '../powerRankings.js'
import { computeFixtures, computeMatchForecasts } from '../playoffSim.js'
import { OT_SHARE_OF_TIES } from '../liveProbability.js'
import { usePreseasonElo, computePreseasonRatings } from '../preseasonElo.js'
import { computeMarketValuePrior, DEFAULT_PRIOR_SPREAD } from '../marketValuePrior.js'
import { useSimResults, getProbsRow } from '../simResultsContext.jsx'
import MatchForecast from '../components/MatchForecast.jsx'

const POS = [
  { v: 'G', label: 'Torhüter' },
  { v: 'D', label: 'Verteidiger' },
  { v: 'F', label: 'Stürmer' },
]
const posOrder = { G: 0, D: 1, F: 2 }

function fmt2(v) { return v == null ? '–' : v.toFixed(2) }
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null }

// Punkte/Tore/Gegentore/Siegquote über die letzten N (bzw. alle) Spiele eines
// Teams - dieselbe NL-Punktelogik wie computeTeamForm/computeStandings in
// stats.js, hier nur zusätzlich mit Tor-/Gegentor-Rate ergänzt (die
// bestehenden Funktionen liefern das nicht). Reine Deskriptivstatistik, kein
// Bestandteil der Prognose.
function computeFormWindow(teamId, games, n) {
  const finalGames = games.filter(isFinalGame)
    .filter((g) => g.homeTeamId === teamId || g.awayTeamId === teamId)
    .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0))
    .slice(0, n)
  if (finalGames.length === 0) return null
  let pts = 0, gf = 0, ga = 0, wins = 0
  for (const g of finalGames) {
    const isHome = g.homeTeamId === teamId
    const my = isHome ? g.homeGoals : g.awayGoals
    const opp = isHome ? g.awayGoals : g.homeGoals
    gf += my; ga += opp
    const won = my > opp
    const ot = g.decision === 'OT' || g.decision === 'SO'
    if (won) { wins++; pts += ot ? 2 : 3 } else { pts += ot ? 1 : 0 }
  }
  const gp = finalGames.length
  return { gp, ptsPerGame: pts / gp, gfpg: gf / gp, gapg: ga / gp, winPct: wins / gp }
}

export default function TeamDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, derived, api, refresh } = useData()
  const playerHistoryData = usePlayerHistory()
  const baselines = usePositionBaselines()
  const teamHistoryData = useTeamHistory()
  const preseasonSeasonEnd = usePreseasonElo()
  const { rows: simRows, updatedAt: simUpdatedAt } = useSimResults()
  const team = data.teams.find((t) => t.id === id)
  const [editing, setEditing] = useState(null)
  const [editTeam, setEditTeam] = useState(false)
  const [top5Mode, setTop5Mode] = useState('impact')
  const [compareTeamId, setCompareTeamId] = useState('')
  const [rosterFilter, setRosterFilter] = useState('all')
  const [rosterSearch, setRosterSearch] = useState('')

  const eloStart = data.settings?.eloStart ?? 1500
  const homeAdv = data.settings?.eloHomeAdvantage ?? 65

  // Marktwert-Prior (src/marketValuePrior.js), wenn aktiviert und Daten
  // vorhanden, sonst der bestehende historische Pre-Season-ELO - identische
  // Priorität wie in DataContext.jsx (derived.eloPriorSource).
  const preseasonRatings = useMemo(() => {
    const useMarketValue = data.settings?.marketValuePriorEnabled !== false
    const marketPrior = useMarketValue
      ? computeMarketValuePrior(data.teams, data.players, eloStart, data.settings?.priorSpread ?? DEFAULT_PRIOR_SPREAD)
      : null
    return marketPrior || computePreseasonRatings(preseasonSeasonEnd, eloStart)
  }, [preseasonSeasonEnd, eloStart, data.teams, data.players, data.settings])
  const power = useMemo(() => {
    if (!derived?.elo?.ratings) return []
    return computePowerRankings(data.teams, data.games, derived.elo.ratings, data.players || [])
  }, [data, derived])
  const fixturesData = useMemo(
    () => computeFixtures(data.teams, data.games, data.settings, data.players || [], preseasonRatings),
    [data, preseasonRatings]
  )

  if (!team) return <div className="muted">Team nicht gefunden.</div>

  const players = data.players
    .filter((p) => p.teamId === id)
    .sort((a, b) => (posOrder[a.position] - posOrder[b.position]) || (Number(a.number) - Number(b.number)))

  const rosterProfile = baselines ? computeTeamRosterProfile(players, playerHistoryData, baselines) : null
  const teamDepth = baselines ? computeTeamDepth(players, playerHistoryData, baselines) : null

  const statById = Object.fromEntries(derived.playerStats.map((s) => [s.player.id, s]))
  const currentSeasonLabel = data.settings?.seasonName?.match(/\d{4}\/\d{2}/)?.[0] || null

  const top5Enriched = (rosterProfile?.top5 || []).map((entry) => {
    const s = statById[entry.player.id]
    const ppg = s && s.gp > 0 ? s.points / s.gp : null
    const seasons = getPlayerSeasons(playerHistoryData, entry.player.id)
    const current = buildCurrentSeasonRecord(s, entry.player, currentSeasonLabel)
    const trend = classifyTrend(current ? [...seasons, current] : seasons)
    return { ...entry, ppg, trend }
  })

  // Team Player Core (Abschnitt 8): wählbare Top-5-Sortierung. "P/GP" und
  // "Punkte" beziehen sich auf die LAUFENDE Saison (statById) - beide Listen
  // sind naturgemäss leer, solange 0 Spiele gespielt wurden (kein Leakage,
  // kein erfundener Wert).
  const scoredWithCurrent = (rosterProfile?.scored || []).map((s) => {
    const stat = statById[s.player.id]
    return { ...s, currentPpg: stat && stat.gp > 0 ? stat.points / stat.gp : null, currentPoints: stat?.points ?? 0 }
  })
  const top5ByMode = top5Mode === 'ppg'
    ? [...scoredWithCurrent].filter((s) => s.currentPpg != null).sort((a, b) => b.currentPpg - a.currentPpg).slice(0, 5)
    : top5Mode === 'points'
      ? [...scoredWithCurrent].filter((s) => s.currentPoints > 0).sort((a, b) => b.currentPoints - a.currentPoints).slice(0, 5)
      : top5Enriched

  const teamPointsTotal = players.reduce((sum, p) => sum + (statById[p.id]?.points || 0), 0)
  const currentContributors = teamPointsTotal > 0
    ? players
        .map((p) => ({ player: p, points: statById[p.id]?.points || 0, gp: statById[p.id]?.gp || 0 }))
        .filter((c) => c.points > 0)
        .sort((a, b) => b.points - a.points)
        .slice(0, 5)
        .map((c) => ({ ...c, share: c.points / teamPointsTotal }))
    : []

  const standing = derived.standings.find((s) => s.team.id === id)
  const rank = standing ? derived.standings.indexOf(standing) + 1 : null
  const bilanz = standing ? `${standing.w}-${standing.otw}-${standing.otl}-${standing.l}` : null
  const eloRow = derived.elo.ranking.find((r) => r.team.id === id)
  const powerRow = power.find((p) => p.team.id === id)
  const eloHistory = derived.elo.history[id] || []
  const preseasonElo = preseasonRatings?.[id] ?? null
  // Season-Projection-Kompaktwerte (Abschnitt G) aus dem app-weiten Live-
  // Simulationsergebnis (simResultsContext.jsx) - derselbe Store wie
  // Dashboard/PlayoffOdds. NICHT hier neu simuliert (siehe Kommentar oben in
  // der Datei). Null, solange in dieser Session noch nie simuliert wurde.
  const projectionRow = getProbsRow(simRows, id)

  const form5 = computeFormWindow(id, data.games, 5)
  const form10 = computeFormWindow(id, data.games, 10)
  const formSeason = standing?.gp > 0 ? { gp: standing.gp, ptsPerGame: standing.pts / standing.gp, gfpg: standing.gf / standing.gp, gapg: standing.ga / standing.gp } : null
  const splits = computeHomeSplits(id, data.games)
  const gpg = standing?.gp > 0 ? (standing.gf / standing.gp).toFixed(2) : '–'
  const gpa = standing?.gp > 0 ? (standing.ga / standing.gp).toFixed(2) : '–'
  // Kleiner Formtrend fürs Hero (Abschnitt A) - Vergleich Ø-Punkte/Spiel der
  // letzten 5 Spiele gegen den Saisonschnitt, reine Ableitung aus bereits
  // vorhandenen Werten (form5/formSeason), kein neuer Modellwert.
  const formTrend = form5 && formSeason && form5.gp >= 3
    ? (form5.ptsPerGame - formSeason.ptsPerGame > 0.3 ? 'up' : form5.ptsPerGame - formSeason.ptsPerGame < -0.3 ? 'down' : 'flat')
    : null

  // Formverlauf über die Saison: kumulierte Punkte/Spiel nach jedem
  // absolvierten Spiel (chronologisch) - reine Deskriptivstatistik.
  const formSeries = useMemo(() => {
    const gs = data.games.filter(isFinalGame)
      .filter((g) => g.homeTeamId === id || g.awayTeamId === id)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    let cum = 0
    return gs.map((g, i) => {
      const isHome = g.homeTeamId === id
      const won = (isHome ? g.homeGoals : g.awayGoals) > (isHome ? g.awayGoals : g.homeGoals)
      const ot = g.decision === 'OT' || g.decision === 'SO'
      cum += won ? (ot ? 2 : 3) : (ot ? 1 : 0)
      return { index: i + 1, ppg: cum / (i + 1) }
    })
  }, [data.games, id])

  // Offense/Defense: rohe SOG-Summen aus den bereits erfassten
  // Spieler-/Torhüter-Statistiken (kein neuer Faktor, nur Addition
  // vorhandener Zahlen) - "falls verfügbar" (nur befüllt, sobald der
  // SIHF-Sync SOG liefert, siehe stats.js).
  const teamSkaters = players.filter((p) => p.position !== 'G')
  const teamGoalies = players.filter((p) => p.position === 'G')
  const sogForTotal = teamSkaters.reduce((s, p) => s + (statById[p.id]?.sog || 0), 0)
  const sogAllowedTotal = teamGoalies.reduce((s, p) => s + ((statById[p.id]?.saves || 0) + (statById[p.id]?.goalsAgainst || 0)), 0)
  const sogForPg = standing?.gp > 0 && sogForTotal > 0 ? sogForTotal / standing.gp : null
  const sogAllowedPg = standing?.gp > 0 && sogAllowedTotal > 0 ? sogAllowedTotal / standing.gp : null
  const histLast3 = lastNSeasons(teamHistoryData, id, 3)

  // Schedule Strength (Abschnitt 6) - NUR Anzeige, kein Prognose-Input:
  // bestehende computeFixtures()/homeWinProbability() für die verbleibenden
  // Spiele dieses Teams, aggregiert zu Ø-Gegner-ELO / Ø-Modell-Siegchance.
  const fixtureByPair = new Map(fixturesData.fixtures.map((f) => [`${f.home}:${f.away}`, f]))
  const scheduleRows = data.games
    .filter((g) => g.status === 'scheduled' && (g.homeTeamId === id || g.awayTeamId === id))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((g) => {
      const isHome = g.homeTeamId === id
      const oppId = isHome ? g.awayTeamId : g.homeTeamId
      const f = fixtureByPair.get(`${g.homeTeamId}:${g.awayTeamId}`)
      if (!f) return null
      const oppElo = fixturesData.eloRatings[oppId] ?? eloStart
      const pWin = isHome ? f.pHome : 1 - f.pHome
      return { game: g, opp: data.teams.find((t) => t.id === oppId), isHome, oppElo, pWin }
    })
    .filter(Boolean)
  const scheduleAvgOppElo = scheduleRows.length ? mean(scheduleRows.map((r) => r.oppElo)) : null
  const scheduleAvgPWin = scheduleRows.length ? mean(scheduleRows.map((r) => r.pWin)) : null

  // Recent Results (Abschnitt 7): aus derived.elo.history[id] (ELO vor/nach
  // JEDEM Spiel bereits vorhanden, siehe elo.js) - keine Rekonstruktion.
  const recentResults = [...eloHistory].filter((h) => h.gameId).slice(-8).reverse().map((h, i, arr) => {
    const g = data.games.find((x) => x.id === h.gameId)
    if (!g) return null
    const idx = eloHistory.findIndex((x) => x.gameId === h.gameId)
    const eloBefore = idx > 0 ? eloHistory[idx - 1].rating : null
    const isHome = g.homeTeamId === id
    const opp = data.teams.find((t) => t.id === (isHome ? g.awayTeamId : g.homeTeamId))
    return { game: g, opp, isHome, eloBefore, eloAfter: h.rating }
  }).filter(Boolean)

  // Team Strength Profile (Abschnitt 12) - AUSSCHLIESSLICH DARSTELLUNG,
  // keine neue Prognosekennzahl: jede Kennzahl ist bereits an anderer Stelle
  // eigenständig definiert/validiert (ELO, Power-Ranking-Offense/Defense via
  // Impact Score, Kader-Impact, Form) - hier nur auf eine gemeinsame
  // 0-100-Anzeigeskala gebracht (ELO per Liga-Min/Max, Form per /3 Punkte),
  // damit sie nebeneinander als Balken darstellbar sind.
  const leagueElos = derived.elo.ranking.map((r) => r.rating)
  const eloMin = Math.min(...leagueElos), eloMax = Math.max(...leagueElos)
  const strengthProfile = [
    eloRow ? { label: 'ELO', pct: eloMax > eloMin ? ((eloRow.rating - eloMin) / (eloMax - eloMin)) * 100 : 50, raw: eloRow.rating } : null,
    powerRow ? { label: 'Power Score', pct: powerRow.powerScore, raw: powerRow.powerScore } : null,
    rosterProfile?.offense != null ? { label: 'Offense (Kader)', pct: rosterProfile.offense, raw: rosterProfile.offense } : null,
    rosterProfile?.defense != null ? { label: 'Defense (Kader)', pct: rosterProfile.defense, raw: rosterProfile.defense } : null,
    rosterProfile?.avgScore != null ? { label: 'Roster (Ø Impact)', pct: rosterProfile.avgScore, raw: rosterProfile.avgScore } : null,
    form10 ? { label: 'Form (10 Sp.)', pct: (form10.ptsPerGame / 3) * 100, raw: form10.ptsPerGame } : null,
  ].filter(Boolean)

  // Matchups (Abschnitt H) - dieselbe Herleitung wie Dashboard.jsx/
  // PlayoffOdds.jsx (computeMatchForecasts + computeFixtures-Anreicherung),
  // hier auf die Spiele DIESES Teams gefiltert. Verwendet die bereits oben
  // berechnete fixturesData - kein zweiter Simulationslauf.
  const teamForecasts = computeMatchForecasts(data.teams, data.games, data.settings, data.players || [], preseasonRatings)
    .filter((f) => f.homeTeam.id === id || f.awayTeam.id === id)
    .map((f) => {
      const fx = fixtureByPair.get(`${f.homeTeam.id}:${f.awayTeam.id}`)
      if (!fx) return f
      return {
        ...f,
        expHomeGoals: fx.expHome, expAwayGoals: fx.expAway,
        eloHome: fixturesData.eloRatings[f.homeTeam.id], eloAway: fixturesData.eloRatings[f.awayTeam.id],
        pOT: f.pDecision * OT_SHARE_OF_TIES, pSO: f.pDecision * (1 - OT_SHARE_OF_TIES),
      }
    })

  // Roster Value (Abschnitt E) - reine Summe/Sortierung bereits vorhandener
  // Marktwerte (player.marketValue, NL-API via server/sync.js). Keine neue
  // Bewertungslogik, kein Team-Score. Historische Team-Marktwertentwicklung
  // (Verlauf über die Saison) ist NICHT umgesetzt: es gibt nur eine
  // Zeitreihe PRO SPIELER (player.marketValueHistory), keine bereits
  // aggregierte Team-Zeitreihe - eine tagesweise Summierung über alle
  // Spieler wäre eine neue Berechnung, siehe Abschlussbericht.
  const playersWithValue = players.filter((p) => p.marketValue != null)
  const rosterValueTotal = playersWithValue.reduce((s, p) => s + p.marketValue, 0)
  const topValuablePlayers = [...playersWithValue].sort((a, b) => b.marketValue - a.marketValue).slice(0, 5)
  const rosterTrendUp = players.filter((p) => p.marketValueTrend === 1).length
  const rosterTrendDown = players.filter((p) => p.marketValueTrend === -1).length

  // Kader (Abschnitt D) - Position/Namenfilter für die sortierbare
  // Kadertabelle, dieselben statById-Werte wie überall sonst auf der Seite.
  const rosterSearchLower = rosterSearch.trim().toLowerCase()
  const rosterFiltered = players.filter((p) => {
    if (rosterSearchLower && !p.name.toLowerCase().includes(rosterSearchLower)) return false
    if (rosterFilter === 'all') return true
    return p.position === rosterFilter
  })
  const rosterSkaters = rosterFiltered.filter((p) => p.position !== 'G')
  const rosterGoalies = rosterFiltered.filter((p) => p.position === 'G')

  const compareTeam = compareTeamId ? data.teams.find((t) => t.id === compareTeamId) : null
  const compareRow = compareTeam ? power.find((p) => p.team.id === compareTeamId) : null
  const compareStanding = compareTeam ? derived.standings.find((s) => s.team.id === compareTeamId) : null
  const compareEloRow = compareTeam ? derived.elo.ranking.find((r) => r.team.id === compareTeamId) : null
  const compareSplits = compareTeam ? computeHomeSplits(compareTeamId, data.games) : null
  const compareRosterProfile = compareTeam && baselines
    ? computeTeamRosterProfile(data.players.filter((p) => p.teamId === compareTeamId), playerHistoryData, baselines)
    : null

  const savePlayer = async (form) => {
    try {
      if (editing.id) await api.updatePlayer(editing.id, form)
      else await api.createPlayer({ ...form, teamId: id })
      await refresh()
      setEditing(null)
      toast(editing.id ? 'Spieler aktualisiert' : 'Spieler hinzugefügt')
    } catch (e) { toast(e.message, true) }
  }
  const removePlayer = async (p) => {
    if (!window.confirm(`${p.name} wirklich löschen?`)) return
    try { await api.deletePlayer(p.id); await refresh(); toast('Gelöscht') }
    catch (e) { toast(e.message, true) }
  }
  const saveTeam = async (form) => {
    try { await api.updateTeam(id, form); await refresh(); setEditTeam(false); toast('Team gespeichert') }
    catch (e) { toast(e.message, true) }
  }

  const skaterColumns = [
    { key: 'number', label: '#', num: true, noSort: true, render: (p) => <span className="muted">{p.number}</span> },
    { key: 'name', label: 'Spieler', left: true, value: (p) => p.name, render: (p) => <Link to={`/players/${p.id}`}>{p.name}</Link> },
    { key: 'position', label: 'Pos.', left: true, value: (p) => p.position, render: (p) => <span className="chip">{p.position}</span> },
    { key: 'gp', label: 'GP', num: true, value: (p) => statById[p.id]?.gp || 0, render: (p) => statById[p.id]?.gp || 0 },
    { key: 'goals', label: 'G', num: true, value: (p) => statById[p.id]?.goals || 0, render: (p) => statById[p.id]?.goals || 0 },
    { key: 'assists', label: 'A', num: true, value: (p) => statById[p.id]?.assists || 0, render: (p) => statById[p.id]?.assists || 0 },
    { key: 'points', label: 'P', num: true, value: (p) => statById[p.id]?.points || 0, render: (p) => <strong>{statById[p.id]?.points || 0}</strong> },
    {
      key: 'ppg', label: 'P/GP', num: true,
      value: (p) => { const s = statById[p.id]; return s?.gp > 0 ? s.points / s.gp : -1 },
      render: (p) => { const s = statById[p.id]; return s?.gp > 0 ? (s.points / s.gp).toFixed(2) : <span className="muted">–</span> },
    },
    { key: 'sog', label: 'SOG', num: true, value: (p) => statById[p.id]?.sog ?? -1, render: (p) => statById[p.id]?.sog ?? <span className="muted">–</span> },
    {
      key: 'plusMinus', label: '+/–', num: true,
      value: (p) => statById[p.id]?.plusMinus ?? 0,
      render: (p) => statById[p.id]?.plusMinus != null ? plusMinusStr(statById[p.id].plusMinus) : 0,
    },
    {
      key: 'actions', label: '', num: true, noSort: true,
      render: (p) => (
        <span className="row gap-sm" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); setEditing(p) }}>Bearbeiten</button>
          <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); removePlayer(p) }}>Entfernen</button>
        </span>
      ),
    },
  ]
  const goalieColumns = [
    { key: 'number', label: '#', num: true, noSort: true, render: (p) => <span className="muted">{p.number}</span> },
    { key: 'name', label: 'Spieler', left: true, value: (p) => p.name, render: (p) => <Link to={`/players/${p.id}`}>{p.name}</Link> },
    { key: 'gp', label: 'GP', num: true, value: (p) => statById[p.id]?.gp || 0, render: (p) => statById[p.id]?.gp || 0 },
    { key: 'wins', label: 'S', num: true, value: (p) => statById[p.id]?.wins || 0, render: (p) => statById[p.id]?.wins || 0 },
    { key: 'losses', label: 'N', num: true, value: (p) => statById[p.id]?.losses || 0, render: (p) => statById[p.id]?.losses || 0 },
    { key: 'savePct', label: 'SV%', num: true, value: (p) => statById[p.id]?.savePct ?? -1, render: (p) => fmtPct(statById[p.id]?.savePct) },
    { key: 'gaa', label: 'GTS', num: true, value: (p) => statById[p.id]?.gaa ?? 999, render: (p) => fmtNum(statById[p.id]?.gaa) },
    { key: 'shutouts', label: 'SO', num: true, value: (p) => statById[p.id]?.shutouts || 0, render: (p) => statById[p.id]?.shutouts || 0 },
    {
      key: 'actions', label: '', num: true, noSort: true,
      render: (p) => (
        <span className="row gap-sm" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); setEditing(p) }}>Bearbeiten</button>
          <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); removePlayer(p) }}>Entfernen</button>
        </span>
      ),
    },
  ]

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row gap-sm"><Link className="muted" to="/teams">Teams</Link><span className="muted">/</span></div>
          <h1 className="row gap-sm"><span className="dot" style={{ background: team.color, width: 16, height: 16 }} />{team.name}</h1>
          <div className="sub">{team.short} · {players.length} Spieler im Kader</div>
        </div>
        <div className="row gap-sm">
          <button className="btn" onClick={() => setEditTeam(true)}>Team bearbeiten</button>
          <button className="btn primary" onClick={() => setEditing({})}>Spieler hinzufügen</button>
        </div>
      </div>

      {/* A) Team Hero - die wichtigsten Kennzahlen auf einen Blick, oberhalb
          jeder weiteren Sektion. Playoff-Chance kommt aus dem app-weiten
          Live-Simulationsstore (kein Neuberechnen hier, siehe projectionRow). */}
      <div className="card card-pad mb">
        <div className="stat-strip">
          <div className="stat"><strong>{rank ? `#${rank}` : '–'}</strong><span>Tabellenplatz</span></div>
          <div className="stat"><strong>{standing?.pts ?? 0}</strong><span>Punkte</span></div>
          <div className="stat"><strong>{bilanz ?? '–'}</strong><span>Bilanz (S-SnV-NnV-N)</span></div>
          <div className="stat">
            <strong className={standing && standing.gd > 0 ? 'good' : standing && standing.gd < 0 ? 'bad' : ''}>
              {standing ? (standing.gd > 0 ? '+' : '') + standing.gd : '–'}
            </strong>
            <span>Tordifferenz</span>
          </div>
          <div className="stat"><strong>{eloRow?.rating ?? eloStart}</strong><span>ELO</span></div>
          <div className="stat"><strong>{powerRow?.powerScore ?? '–'}</strong><span>Power Score</span></div>
          <div className="stat">
            <strong>{projectionRow ? fmtPct(projectionRow.pPlayoffs) : '–'}</strong>
            <span>Playoff-Chance</span>
          </div>
          {formTrend && (
            <div className="stat">
              <strong className={formTrend === 'up' ? 'good' : formTrend === 'down' ? 'bad' : 'muted'} title="Ø Punkte/Spiel der letzten 5 Spiele vs. Saisonschnitt">
                {formTrend === 'up' ? '▲' : formTrend === 'down' ? '▼' : '→'}
              </strong>
              <span>Formtrend</span>
            </div>
          )}
        </div>
        {!projectionRow && (
          <div className="muted mt" style={{ fontSize: 11.5 }}>
            Playoff-/Meister-Wahrscheinlichkeit noch nicht verfügbar - <Link to="/playoff-odds">Season-Projections-Simulation starten</Link>.
          </div>
        )}
      </div>

      {/* B) Form - Kurzfenster (5/10/Saison), letzte 5 Resultate als Badges
          statt reinem Text, plus Saisonverlauf (Ø Punkte/Spiel kumuliert). */}
      <div className="card card-pad mb">
        <h2 className="mb">Form</h2>
        <div className="grid grid-3 mb">
          {[['Letzte 5', form5], ['Letzte 10', form10], ['Saison', formSeason]].map(([label, f]) => (
            <div key={label} className="tile">
              <div className="label">{label}</div>
              {f ? (
                <div style={{ marginTop: 6, fontSize: 12.5 }}>
                  <div className="row spread"><span className="muted">Pkt/Sp.</span><strong>{fmt2(f.ptsPerGame)}</strong></div>
                  <div className="row spread"><span className="muted">Tore/Sp.</span><strong>{fmt2(f.gfpg)}</strong></div>
                  <div className="row spread"><span className="muted">Gegent./Sp.</span><strong>{fmt2(f.gapg)}</strong></div>
                  {f.winPct != null && <div className="row spread"><span className="muted">Siegquote</span><strong>{fmtPct(f.winPct)}</strong></div>}
                </div>
              ) : <div className="muted mt" style={{ fontSize: 12.5 }}>Keine Spiele</div>}
            </div>
          ))}
        </div>
        {recentResults.length > 0 && (
          <div className="row gap-sm mb" style={{ flexWrap: 'wrap' }}>
            {[...recentResults].slice(0, 5).reverse().map((r) => {
              const won = r.isHome ? r.game.homeGoals > r.game.awayGoals : r.game.awayGoals > r.game.homeGoals
              return (
                <ResultBadge
                  key={r.game.id}
                  code={resultCode(won, r.game.decision)}
                  title={`${r.game.date} vs. ${r.opp?.short}: ${r.isHome ? `${r.game.homeGoals}:${r.game.awayGoals}` : `${r.game.awayGoals}:${r.game.homeGoals}`}`}
                />
              )
            })}
          </div>
        )}
        {formSeries.length >= 2 ? <FormChart series={formSeries} /> : <div className="muted" style={{ fontSize: 12.5 }}>Formverlauf erscheint, sobald mehrere Spiele absolviert sind.</div>}
      </div>

      {/* C) ELO / Team-Entwicklung - unverändert aus der historischen
          ELO-Verlaufsreihe (derived.elo.history), keine Neuberechnung. */}
      <div className="card card-pad mb">
        <h2 className="mb">ELO-Verlauf</h2>
        <div className="stat-strip">
          <div className="stat"><strong>{preseasonElo != null ? Math.round(preseasonElo) : '–'}</strong><span>Pre-Season-ELO</span></div>
          <div className="stat"><strong>{eloRow?.rating ?? eloStart}</strong><span>Aktuell</span></div>
          <div className="stat"><strong>{eloHistory.length ? Math.round(Math.max(...eloHistory.map((h) => h.rating))) : '–'}</strong><span>Saisonhoch</span></div>
          <div className="stat"><strong>{eloHistory.length ? Math.round(Math.min(...eloHistory.map((h) => h.rating))) : '–'}</strong><span>Saisontief</span></div>
          <div className="stat">
            <strong className={(eloRow?.rating ?? eloStart) - eloHistory[0]?.rating >= 0 ? 'good' : 'bad'}>
              {eloHistory.length ? (((eloRow?.rating ?? eloStart) - eloHistory[0].rating) >= 0 ? '+' : '') + Math.round((eloRow?.rating ?? eloStart) - eloHistory[0].rating) : '–'}
            </strong>
            <span>Veränderung</span>
          </div>
        </div>
        {eloHistory.length >= 2 ? <TeamEloChart history={eloHistory} color={team.color} start={eloStart} /> : <div className="muted" style={{ fontSize: 12.5 }}>Verlauf erscheint, sobald Spiele absolviert sind.</div>}
      </div>

      {/* D) Kader - sortierbare Tabelle (SortableTable, src/components/ui.jsx)
          mit Positionsfilter + Suche. Ersetzt die frühere separate
          Admin-Kadertabelle vollständig (Bearbeiten/Entfernen bleiben hier
          erhalten) - keine zweite, redundante Spielerliste mehr auf der Seite. */}
      <div className="card card-pad mb">
        <div className="row spread mb" style={{ flexWrap: 'wrap', gap: 10 }}>
          <h2 style={{ margin: 0 }}>Kader</h2>
          <input
            value={rosterSearch}
            onChange={(e) => setRosterSearch(e.target.value)}
            placeholder="Spieler suchen…"
            style={{ width: 200 }}
          />
        </div>
        <div className="pill-tabs mb">
          <button className={rosterFilter === 'all' ? 'active' : ''} onClick={() => setRosterFilter('all')}>Alle</button>
          <button className={rosterFilter === 'F' ? 'active' : ''} onClick={() => setRosterFilter('F')}>Stürmer</button>
          <button className={rosterFilter === 'D' ? 'active' : ''} onClick={() => setRosterFilter('D')}>Verteidiger</button>
          <button className={rosterFilter === 'G' ? 'active' : ''} onClick={() => setRosterFilter('G')}>Goalies</button>
        </div>
        {players.length === 0 ? (
          <div className="empty">
            <div className="title">Noch keine Spieler</div>
            <div className="hint">Füge die Spieler dieses Teams hinzu.</div>
            <div style={{ marginTop: 14 }}><button className="btn primary" onClick={() => setEditing({})}>Ersten Spieler hinzufügen</button></div>
          </div>
        ) : rosterFiltered.length === 0 ? (
          <div className="muted" style={{ fontSize: 12.5 }}>Keine Spieler gefunden.</div>
        ) : (
          <>
            {rosterSkaters.length > 0 && <SortableTable columns={skaterColumns} rows={rosterSkaters} initialSort="points" rowKey={(p) => p.id} />}
            {rosterGoalies.length > 0 && (
              <div style={{ marginTop: rosterSkaters.length > 0 ? 16 : 0 }}>
                {rosterSkaters.length > 0 && <div className="section-label">Torhüter</div>}
                <SortableTable columns={goalieColumns} rows={rosterGoalies} initialSort="gp" rowKey={(p) => p.id} />
              </div>
            )}
          </>
        )}
      </div>

      {/* E) Roster Value - reine Summe/Sortierung bestehender Marktwerte
          (player.marketValue/marketValueTrend, NL-API), keine neue
          Bewertungslogik. Team-weite Marktwertentwicklung über die Saison
          ist NICHT dargestellt (siehe Abschlussbericht: keine aggregierte
          Team-Zeitreihe vorhanden, nur pro Spieler). */}
      {playersWithValue.length > 0 && (
        <div className="card card-pad mb">
          <h2 className="mb">Roster Value</h2>
          <div className="stat-strip">
            <div className="stat"><strong>CHF {fmtChf(rosterValueTotal)}</strong><span>Kaderwert gesamt</span></div>
            <div className="stat"><strong>{playersWithValue.length}/{players.length}</strong><span>Spieler mit Marktwert</span></div>
            <div className="stat"><strong className="good">{rosterTrendUp}</strong><span>Im Aufwind</span></div>
            <div className="stat"><strong className="bad">{rosterTrendDown}</strong><span>Im Abwind</span></div>
          </div>
          <div className="section-label">Wertvollste Spieler</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th className="left">Spieler</th><th className="left">Pos.</th><th className="num">Marktwert</th><th className="num">Trend</th></tr></thead>
              <tbody>
                {topValuablePlayers.map((p) => (
                  <tr key={p.id}>
                    <td className="left"><Link to={`/players/${p.id}`}>{p.name}</Link></td>
                    <td className="left"><span className="chip">{p.position}</span></td>
                    <td className="num"><strong>CHF {fmtChf(p.marketValue)}</strong></td>
                    <td className="num"><MarketValueTrend trend={p.marketValueTrend} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted mt" style={{ fontSize: 11 }}>Quelle: nationalleague.ch.</div>
        </div>
      )}

      {/* F) Team Strength - AUSSCHLIESSLICH DARSTELLUNG, keine neue
          Prognosekennzahl: jede Grösse ist bereits eigenständig definiert
          (ELO, Power Score, Kader-Impact-Score, Form), hier nur auf eine
          gemeinsame 0-100-Anzeigeskala gebracht. */}
      {strengthProfile.length > 0 && (
        <div className="card card-pad mb">
          <h2 className="mb">Team Strength</h2>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>
            Nur Darstellung, keine neue Prognosekennzahl - jede Grösse ist bereits eigenständig definiert (ELO, Power Score, Kader-Impact-Score, Form), hier nur auf eine gemeinsame 0-100-Skala gebracht.
          </div>
          {strengthProfile.map((s) => (
            <div key={s.label} className="row" style={{ fontSize: 12.5, marginBottom: 8 }}>
              <span className="muted" style={{ minWidth: 120 }}>{s.label}</span>
              <div className="bar-track" style={{ flex: 1 }}><div className="bar-fill" style={{ width: `${Math.max(0, Math.min(100, s.pct))}%` }} /></div>
              <strong style={{ minWidth: 50, textAlign: 'right', fontFamily: 'var(--mono)' }}>{s.raw.toFixed(s.label === 'ELO' || s.label === 'Power Score' ? 0 : s.label.startsWith('Form') ? 2 : 1)}</strong>
            </div>
          ))}
        </div>
      )}

      {/* G) Season Projection - Kompaktansicht der zuletzt gelaufenen
          Monte-Carlo-Simulation (simResultsContext.jsx), gefiltert auf dieses
          Team. Keine Neuberechnung - Hinweistext + Link, falls in dieser
          Session noch nie simuliert wurde. */}
      <div className="card card-pad mb">
        <h2 className="mb">Season Projection</h2>
        {!projectionRow ? (
          <div className="muted" style={{ fontSize: 12.5 }}>
            Noch keine Simulation in dieser Session gelaufen. <Link to="/playoff-odds">Jetzt simulieren →</Link>
          </div>
        ) : (
          <>
            <div className="stat-strip">
              <div className="stat"><strong>{fmtPct(projectionRow.pPlayoffs)}</strong><span>Playoffs</span></div>
              <div className="stat"><strong>{fmtPct(projectionRow.pTop6)}</strong><span>Top 6</span></div>
              <div className="stat"><strong>{fmtPct(projectionRow.pPlayIn)}</strong><span>Play-in</span></div>
              <div className="stat"><strong>{fmtPct(projectionRow.pSemifinal)}</strong><span>Halbfinale</span></div>
              <div className="stat"><strong>{fmtPct(projectionRow.pFinal)}</strong><span>Finale</span></div>
              <div className="stat"><strong style={{ color: 'var(--accent)' }}>{fmtPct(projectionRow.pChampion)}</strong><span>Meister</span></div>
              <div className="stat"><strong style={projectionRow.pPlayout1314 >= 0.1 ? { color: 'var(--warn)' } : undefined}>{fmtPct(projectionRow.pPlayout1314)}</strong><span>Play-out</span></div>
              <div className="stat"><strong style={projectionRow.pLigaQualifikation >= 0.05 ? { color: 'var(--bad)' } : undefined}>{fmtPct(projectionRow.pLigaQualifikation)}</strong><span>Ligaqualifikation</span></div>
              <div className="stat"><strong>{projectionRow.avgRank != null ? projectionRow.avgRank.toFixed(1) : '–'}</strong><span>Ø Rang</span></div>
              <div className="stat"><strong>{projectionRow.avgPts != null ? projectionRow.avgPts.toFixed(1) : '–'}</strong><span>Ø Punkte</span></div>
              {projectionRow.minPts != null && projectionRow.maxPts != null && (
                <div className="stat"><strong>{Math.round(projectionRow.minPts)}–{Math.round(projectionRow.maxPts)}</strong><span>Range</span></div>
              )}
            </div>
            <div className="muted mt" style={{ fontSize: 11 }}>
              Aus der zuletzt gelaufenen Season-Projections-Simulation{simUpdatedAt ? ` (${new Date(simUpdatedAt).toLocaleString('de-CH')})` : ''} - <Link to="/playoff-odds">vollständige Ansicht</Link>. Hier nicht neu berechnet.
            </div>
          </>
        )}
      </div>

      {/* H) Matchups - dieselbe Karten-Komponente wie Dashboard/PlayoffOdds
          (inkl. "Warum?"-Erklärung), hier auf dieses Team gefiltert. Bewusst
          KEINE Vermischung mit historischen H2H-Daten (siehe Team vs. Team
          weiter unten, klar getrennt und nur verlinkt). */}
      {teamForecasts.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 4 }}>Matchups</div>
          <MatchForecast
            forecasts={teamForecasts}
            title="Kommende Spiele"
            caption={scheduleAvgOppElo != null
              ? `Ø Gegner-ELO ${Math.round(scheduleAvgOppElo)} · Ø Modell-Siegchance ${fmtPct(scheduleAvgPWin)} für die ${scheduleRows.length} verbleibenden Spiele.`
              : 'Heimsieg-/Auswärtssieg-Chance aus ELO + Heimvorteil.'}
            limit={6}
            showCount={teamForecasts.length > 6}
          />
        </>
      )}

      {/* I) Recent Games - klickbar auf die bestehende Matchup-Detailseite,
          REG/OT/SO klar unterschieden (derselbe Badge-Code wie
          MatchupDetail.jsx/headToHead.js), ELO vor/nach aus der bereits
          vorhandenen ELO-Historie. */}
      {recentResults.length > 0 && (
        <div className="card card-pad mb">
          <h2 className="mb">Letzte Spiele</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th className="left">Datum</th><th className="left">Gegner</th><th className="left">H/A</th><th className="num">Ergebnis</th><th className="left"></th><th className="num">ELO vor</th><th className="num">ELO nach</th></tr></thead>
              <tbody>
                {recentResults.map((r) => {
                  const won = r.isHome ? r.game.homeGoals > r.game.awayGoals : r.game.awayGoals > r.game.homeGoals
                  return (
                    <tr key={r.game.id} onClick={() => navigate(`/matchup/${r.game.id}`)} style={{ cursor: 'pointer' }}>
                      <td className="left" style={{ fontSize: 12 }}>{r.game.date}</td>
                      <td className="left"><TeamBadge team={r.opp} short /></td>
                      <td className="left">{r.isHome ? 'H' : 'A'}</td>
                      <td className="num"><strong>{r.isHome ? `${r.game.homeGoals}:${r.game.awayGoals}` : `${r.game.awayGoals}:${r.game.homeGoals}`}</strong></td>
                      <td className="left"><ResultBadge code={resultCode(won, r.game.decision)} /></td>
                      <td className="num muted">{r.eloBefore != null ? Math.round(r.eloBefore) : '–'}</td>
                      <td className="num">{Math.round(r.eloAfter)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* J) Detailed Statistics - alles Tiefere/Granularere ganz unten:
          Offense/Defense, Heim/Auswärts, Kaderanalyse (Impact Score/Team
          Depth), historischer Mehrsaisonvergleich, direkter Teamvergleich. */}
      <div className="section-label" style={{ marginTop: 4 }}>Detailed Statistics</div>

      <div className="card card-pad mb">
        <h2 className="mb">Offense / Defense</h2>
        <div className="grid grid-2">
          <div>
            <div className="section-label">Offense</div>
            <div className="tiles" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
              <div className="tile"><div className="label">Tore/Spiel</div><div className="value mono">{gpg}</div></div>
              <div className="tile"><div className="label">SOG/Spiel</div><div className="value mono">{sogForPg != null ? sogForPg.toFixed(1) : '–'}</div></div>
            </div>
          </div>
          <div>
            <div className="section-label">Defense</div>
            <div className="tiles" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
              <div className="tile"><div className="label">Gegentore/Spiel</div><div className="value mono">{gpa}</div></div>
              <div className="tile"><div className="label">SOG zugelassen/Spiel</div><div className="value mono">{sogAllowedPg != null ? sogAllowedPg.toFixed(1) : '–'}</div></div>
            </div>
          </div>
        </div>
        {histLast3.length > 0 && (
          <div className="muted mt" style={{ fontSize: 12 }}>
            Historische Entwicklung (Ø Tore/Sp. · Ø Gegent./Sp., letzte {histLast3.length} Archiv-Saisons): {histLast3.map((s) => {
              const r = teamSeasonRates(s)
              return `${s.season.slice(2)} ${fmt2(r.gfpg)}/${fmt2(r.gapg)}`
            }).join(' · ')}
          </div>
        )}
      </div>

      {standing && (
        <div className="card card-pad mb">
          <h2 className="mb">Heim / Auswärts</h2>
          <div className="grid grid-2">
            {[['Heimspiele', splits.home], ['Auswärtsspiele', splits.away]].map(([label, s]) => (
              <div key={label}>
                <div className="section-label">{label}</div>
                <div style={{ fontSize: '0.9rem', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem' }}>
                  <div><span className="muted">Spiele</span> <strong>{s.gp}</strong></div>
                  <div><span className="muted">Bilanz</span> <strong>{s.w}-{s.otw}-{s.otl}-{s.l}</strong></div>
                  <div><span className="muted">Punkte/Sp.</span> <strong>{s.gp > 0 ? fmt2(s.pts / s.gp) : '–'}</strong></div>
                  <div><span className="muted">Tore/Sp.</span> <strong>{s.gp > 0 ? fmt2(s.gf / s.gp) : '–'}</strong></div>
                  <div><span className="muted">Gegent./Sp.</span> <strong>{s.gp > 0 ? fmt2(s.ga / s.gp) : '–'}</strong></div>
                </div>
              </div>
            ))}
          </div>
          {splits.home.gp > 0 && splits.away.gp > 0 && (
            <div className="mt">
              <div className="row" style={{ fontSize: 12 }}>
                <span className="muted" style={{ minWidth: 70 }}>Heim Pkt/Sp.</span>
                <div className="bar-track" style={{ flex: 1 }}><div className="bar-fill" style={{ width: `${Math.min((splits.home.pts / splits.home.gp / 3) * 100, 100)}%` }} /></div>
                <strong style={{ minWidth: 34, textAlign: 'right' }}>{fmt2(splits.home.pts / splits.home.gp)}</strong>
              </div>
              <div className="row mt" style={{ fontSize: 12 }}>
                <span className="muted" style={{ minWidth: 70 }}>Ausw. Pkt/Sp.</span>
                <div className="bar-track" style={{ flex: 1 }}><div className="bar-fill" style={{ width: `${Math.min((splits.away.pts / splits.away.gp / 3) * 100, 100)}%`, background: 'var(--text-faint)' }} /></div>
                <strong style={{ minWidth: 34, textAlign: 'right' }}>{fmt2(splits.away.pts / splits.away.gp)}</strong>
              </div>
            </div>
          )}
        </div>
      )}

      {rosterProfile && rosterProfile.scoredCount > 0 && (
        <div className="card card-pad mb">
          <h2 className="mb">Kaderanalyse</h2>
          <div className="stat-strip">
            <div className="stat"><strong>{rosterProfile.playerCount}</strong><span>Feldspieler</span></div>
            <div className="stat"><strong>{rosterProfile.avgScore.toFixed(1)}</strong><span>Ø Impact Score</span></div>
            <div className="stat"><strong>{rosterProfile.medianScore.toFixed(1)}</strong><span>Median Impact</span></div>
            {rosterProfile.avgBirthYear != null && <div className="stat"><strong>{rosterProfile.avgBirthYear}</strong><span>Ø Geburtsjahr</span></div>}
          </div>
          <div className="muted mb" style={{ fontSize: 11 }}>
            Impact Score: positions-relatives Perzentil (0-100) aus Karriere-P/GP, TOI/GP, +/-/GP und SOG/GP – siehe Spielerprofil für Details.
            {rosterProfile.scoredCount < rosterProfile.playerCount && ` Nur für ${rosterProfile.scoredCount}/${rosterProfile.playerCount} Feldspieler genug Karrieredaten vorhanden.`}
          </div>

          <div className="row spread mb">
            <div className="section-label" style={{ marginBottom: 0 }}>Top 5</div>
            <div className="pill-tabs">
              <button className={top5Mode === 'impact' ? 'active' : ''} onClick={() => setTop5Mode('impact')}>Impact Score</button>
              <button className={top5Mode === 'ppg' ? 'active' : ''} onClick={() => setTop5Mode('ppg')}>P/GP (Saison)</button>
              <button className={top5Mode === 'points' ? 'active' : ''} onClick={() => setTop5Mode('points')}>Punkte (Saison)</button>
            </div>
          </div>
          {top5ByMode.length === 0 ? (
            <div className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>Noch keine Saisonspiele - diese Ansicht basiert auf {currentSeasonLabel || 'der laufenden Saison'}.</div>
          ) : (
            <div className="table-wrap" style={{ marginBottom: 16 }}>
              <table>
                <thead><tr><th className="left">Spieler</th><th className="left">Position</th><th className="num">P/GP (Saison)</th><th className="num">Punkte (Saison)</th><th className="left">Trend</th><th className="num">Impact Score</th></tr></thead>
                <tbody>
                  {top5ByMode.map((s) => (
                    <tr key={s.player.id}>
                      <td className="left"><Link to={`/players/${s.player.id}`}>{s.player.name}</Link></td>
                      <td className="left"><span className="chip">{s.position}</span></td>
                      <td className="num">{s.ppg != null || s.currentPpg != null ? (s.currentPpg ?? s.ppg).toFixed(2) : <span className="muted">–</span>}</td>
                      <td className="num">{s.currentPoints ?? statById[s.player.id]?.points ?? 0}</td>
                      <td className="left">
                        {s.trend ? (
                          <span className={s.trend.label.includes('steigend') ? 'good' : s.trend.label === 'fallend' ? 'bad' : 'muted'} style={{ fontSize: 12.5, fontWeight: 700 }}>
                            {s.trend.label}
                          </span>
                        ) : <span className="muted" style={{ fontSize: 12.5 }}>–</span>}
                      </td>
                      <td className="num"><strong>{s.score.toFixed(1)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Team Depth */}
          {teamDepth && (
            <>
              <div className="section-label">Team Depth</div>
              <div className="grid grid-3 mb">
                {[
                  ['Stürmer', teamDepth.forwards],
                  ['Verteidiger', teamDepth.defense],
                  ['Torhüter', teamDepth.goalies],
                ].map(([label, g]) => (
                  <div key={label} className="tile">
                    <div className="label">{label}</div>
                    <div className="value mono">{g.count}</div>
                    <div style={{ marginTop: 6, fontSize: 12 }}>
                      {label === 'Torhüter' ? (
                        g.avgSavePct != null ? (
                          <>
                            <div className="row spread"><span className="muted">Ø SV%</span><strong>{fmtPct(g.avgSavePct)}</strong></div>
                            <div className="row spread"><span className="muted">Median SV%</span><strong>{fmtPct(g.medianSavePct)}</strong></div>
                          </>
                        ) : <span className="muted">Zu wenig Karrieredaten</span>
                      ) : g.avgImpact != null ? (
                        <>
                          <div className="row spread"><span className="muted">Ø Impact</span><strong>{g.avgImpact.toFixed(1)}</strong></div>
                          <div className="row spread"><span className="muted">Median</span><strong>{g.medianImpact.toFixed(1)}</strong></div>
                          {g.avgPpg != null && <div className="row spread"><span className="muted">Ø Karriere-P/GP</span><strong>{fmt2(g.avgPpg)}</strong></div>}
                        </>
                      ) : <span className="muted">Zu wenig Karrieredaten</span>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {currentContributors.length > 0 && (
            <>
              <div className="section-label">Wer trägt das Team aktuell? ({currentSeasonLabel || 'laufende Saison'}, Punkteanteil)</div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th className="left">Spieler</th><th className="num">GP</th><th className="num">Punkte</th><th className="num">Anteil</th></tr></thead>
                  <tbody>
                    {currentContributors.map((c) => (
                      <tr key={c.player.id}>
                        <td className="left"><Link to={`/players/${c.player.id}`}>{c.player.name}</Link></td>
                        <td className="num">{c.gp}</td>
                        <td className="num"><strong>{c.points}</strong></td>
                        <td className="num">{(c.share * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {histLast3.length > 0 && (
        <div className="card card-pad mb">
          <h2 className="mb">Historischer Teamvergleich</h2>
          <div className="table-wrap mb">
            <table>
              <thead><tr><th className="left">Saison</th><th className="num">Rang</th><th className="num">Pkt/Sp.</th><th className="num">Tore/Sp.</th><th className="num">Gegent./Sp.</th><th className="num">ELO (Saisonende)</th></tr></thead>
              <tbody>
                {[...histLast3].reverse().map((s) => {
                  const r = teamSeasonRates(s)
                  return (
                    <tr key={s.season}>
                      <td className="left">{s.season}</td>
                      <td className="num">#{s.rank}</td>
                      <td className="num">{fmt2(r.ptsPerGame)}</td>
                      <td className="num">{fmt2(r.gfpg)}</td>
                      <td className="num">{fmt2(r.gapg)}</td>
                      <td className="num">{s.eloEnd != null ? Math.round(s.eloEnd) : '–'}</td>
                    </tr>
                  )
                })}
                <tr>
                  <td className="left"><strong>{currentSeasonLabel || 'Aktuell'}</strong></td>
                  <td className="num">{rank ? '#' + rank : '–'}</td>
                  <td className="num"><strong>{formSeason ? fmt2(formSeason.ptsPerGame) : '–'}</strong></td>
                  <td className="num">{gpg}</td>
                  <td className="num">{gpa}</td>
                  <td className="num"><strong>{eloRow?.rating ?? eloStart}</strong></td>
                </tr>
              </tbody>
            </table>
          </div>
          <TeamHistoryChart seasons={getTeamSeasons(teamHistoryData, id)} color={team.color} />
          <div className="muted mt" style={{ fontSize: 10.5 }}>{teamHistoryData?.note}</div>
        </div>
      )}

      <div className="card card-pad mb">
        <h2 className="mb">Team vs. Team</h2>
        <div className="row gap-sm mb">
          <select style={{ width: 240 }} value={compareTeamId} onChange={(e) => setCompareTeamId(e.target.value)}>
            <option value="">– Team wählen –</option>
            {data.teams.filter((t) => t.id !== id).sort((a, b) => a.name.localeCompare(b.name)).map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {compareTeam && <Link className="btn ghost sm" to={`/head-to-head?team1=${id}&team2=${compareTeamId}`}>Head-to-Head öffnen</Link>}
        </div>
        {!compareTeam ? (
          <div className="muted" style={{ fontSize: 12.5 }}>Team wählen für einen direkten Vergleich (H2H wird dabei nur verlinkt, nicht als Prognosefaktor verwendet).</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th className="left">Kennzahl</th><th className="num">{team.short}</th><th className="num">{compareTeam.short}</th></tr></thead>
              <tbody>
                <CompareRow label="ELO" v1={eloRow?.rating} v2={compareEloRow?.rating} />
                <CompareRow label="Power Score" v1={powerRow?.powerScore} v2={compareRow?.powerScore} />
                <CompareRow label="Punkte/Spiel" v1={formSeason?.ptsPerGame} v2={compareStanding?.gp > 0 ? compareStanding.pts / compareStanding.gp : null} fmt={fmt2} />
                <CompareRow label="Tore/Spiel (Offense)" v1={standing?.gp > 0 ? standing.gf / standing.gp : null} v2={compareStanding?.gp > 0 ? compareStanding.gf / compareStanding.gp : null} fmt={fmt2} />
                <CompareRow label="Gegentore/Spiel (Defense)" v1={standing?.gp > 0 ? standing.ga / standing.gp : null} v2={compareStanding?.gp > 0 ? compareStanding.ga / compareStanding.gp : null} fmt={fmt2} lowerIsBetter />
                <CompareRow label="Heim Pkt/Sp." v1={splits.home.gp > 0 ? splits.home.pts / splits.home.gp : null} v2={compareSplits?.home.gp > 0 ? compareSplits.home.pts / compareSplits.home.gp : null} fmt={fmt2} />
                <CompareRow label="Auswärts Pkt/Sp." v1={splits.away.gp > 0 ? splits.away.pts / splits.away.gp : null} v2={compareSplits?.away.gp > 0 ? compareSplits.away.pts / compareSplits.away.gp : null} fmt={fmt2} />
                <CompareRow label="Roster Impact (Ø)" v1={rosterProfile?.avgScore} v2={compareRosterProfile?.avgScore} fmt={(v) => v.toFixed(1)} />
              </tbody>
            </table>
          </div>
        )}
        <div className="muted mt" style={{ fontSize: 11 }}>
          Historischer H2H-Vergleich: <Link to={compareTeam ? `/head-to-head?team1=${id}&team2=${compareTeamId}` : '/head-to-head'}>eigene Head-to-Head-Seite</Link> (bewusst getrennt von den Modellwerten oben).
        </div>
      </div>

      {editing && <PlayerModal player={editing} onSave={savePlayer} onClose={() => setEditing(null)} />}
      {editTeam && <TeamModal team={team} onSave={saveTeam} onClose={() => setEditTeam(false)} />}
    </>
  )
}

// Ergebnis-Code (S/OTS/SOS/N/OTN/SON) - identische Logik wie resultCode() in
// src/headToHead.js bzw. MatchupDetail.jsx, hier lokal dupliziert (gleiches
// Muster wie CompareRow unten): kein neuer Zustand, nur Text-Klassifikation
// eines bereits vorhandenen game.decision-Werts.
function resultCode(won, decision) {
  if (decision === 'SO') return won ? 'SOS' : 'SON'
  if (decision === 'OT') return won ? 'OTS' : 'OTN'
  return won ? 'S' : 'N'
}
const BADGE_STYLE = {
  S: { bg: 'var(--good)', label: 'S' }, OTS: { bg: 'var(--good)', label: 'OTS' }, SOS: { bg: 'var(--good)', label: 'SOS' },
  N: { bg: 'var(--bad)', label: 'N' }, OTN: { bg: 'var(--bad)', label: 'OTN' }, SON: { bg: 'var(--bad)', label: 'SON' },
}
function ResultBadge({ code, title }) {
  const s = BADGE_STYLE[code] || { bg: 'var(--text-dim)', label: code }
  return (
    <span title={title} style={{
      display: 'inline-block', minWidth: 30, textAlign: 'center', padding: '2px 6px',
      borderRadius: 5, fontSize: 11, fontWeight: 700, color: '#fff', background: s.bg,
    }}>
      {s.label}
    </span>
  )
}

// Vergleichszeile mit dezenter Hervorhebung des besseren Werts - identisches
// Muster wie CompareRow in MatchupDetail.jsx (dort für Team-vs-Team im
// Matchup-Kontext, hier für die Teamseite - bewusst lokal dupliziert statt
// aus einer Seite in die andere importiert, um beide Seiten unabhängig zu
// halten, exakt gleiches Verhalten).
function CompareRow({ label, v1, v2, fmt = (v) => v, lowerIsBetter = false }) {
  const has1 = v1 != null, has2 = v2 != null
  let w1 = false, w2 = false
  if (has1 && has2 && v1 !== v2) {
    const firstBetter = lowerIsBetter ? v1 < v2 : v1 > v2
    w1 = firstBetter; w2 = !firstBetter
  }
  const cellStyle = (won) => won ? { fontWeight: 800, color: 'var(--accent)' } : { fontWeight: 600 }
  return (
    <tr>
      <td className="left muted" style={{ fontSize: 12.5 }}>{label}</td>
      <td className="num" style={cellStyle(w1)}>{has1 ? fmt(v1) : '–'}</td>
      <td className="num" style={cellStyle(w2)}>{has2 ? fmt(v2) : '–'}</td>
    </tr>
  )
}

// Kompaktes SVG-Liniendiagramm: kumulierte Punkte/Spiel über die Saison.
function FormChart({ series }) {
  const W = 700, H = 140, pad = { l: 30, r: 10, t: 10, b: 10 }
  const max = Math.max(3, ...series.map((p) => p.ppg))
  const x = (i) => pad.l + (i / Math.max(1, series.length - 1)) * (W - pad.l - pad.r)
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b)
  const d = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.ppg)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 320 }}>
      <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--border)" />
      <text x={pad.l - 6} y={y(0) + 4} fontSize="10" fill="var(--text-dim)" textAnchor="end">0</text>
      <line x1={pad.l} x2={W - pad.r} y1={y(3)} y2={y(3)} stroke="var(--border)" />
      <text x={pad.l - 6} y={y(3) + 4} fontSize="10" fill="var(--text-dim)" textAnchor="end">3</text>
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" opacity="0.9" />
    </svg>
  )
}

// Einzelteam-ELO-Verlauf, analog zu EloChart in EloRanking.jsx (dort nicht
// exportiert, daher hier als eigene, gleich aufgebaute Komponente).
function TeamEloChart({ history, color, start }) {
  const W = 700, H = 180, pad = { l: 40, r: 10, t: 10, b: 18 }
  const ratings = history.map((p) => p.rating)
  const min = Math.min(...ratings, start - 40), max = Math.max(...ratings, start + 40)
  const x = (i) => pad.l + (i / Math.max(1, history.length - 1)) * (W - pad.l - pad.r)
  const y = (v) => pad.t + (1 - (v - min) / (max - min || 1)) * (H - pad.t - pad.b)
  const d = history.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.rating)}`).join(' ')
  const yTicks = 3
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => Math.round(min + ((max - min) * i) / yTicks))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 320 }}>
      {ticks.map((tk) => (
        <g key={tk}>
          <line x1={pad.l} x2={W - pad.r} y1={y(tk)} y2={y(tk)} stroke="var(--border)" />
          <text x={pad.l - 8} y={y(tk) + 4} fontSize="10" fill="var(--text-dim)" textAnchor="end">{tk}</text>
        </g>
      ))}
      <path d={d} fill="none" stroke={color} strokeWidth="2" opacity="0.9" />
    </svg>
  )
}

// Historischer Teamverlauf (Punkte/Spiel über alle verfügbaren Archiv-
// Saisons + laufende Saison) - separates, saisonbasiertes Diagramm (X =
// Saisonindex statt Spielindex), analog aufgebaut.
function TeamHistoryChart({ seasons, color }) {
  const played = (seasons || []).filter((s) => s.gp > 0)
  if (played.length < 2) return null
  const W = 700, H = 140, pad = { l: 30, r: 10, t: 10, b: 20 }
  const rates = played.map((s) => s.pts / s.gp)
  const max = Math.max(3, ...rates)
  const x = (i) => pad.l + (i / Math.max(1, played.length - 1)) * (W - pad.l - pad.r)
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b)
  const d = played.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(s.pts / s.gp)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 320 }}>
      <path d={d} fill="none" stroke={color} strokeWidth="2" opacity="0.9" />
      {played.map((s, i) => (
        <text key={s.season} x={x(i)} y={H - 4} fontSize="9" fill="var(--text-dim)" textAnchor="middle">{s.season.slice(2, 4)}</text>
      ))}
    </svg>
  )
}

function PlayerModal({ player, onSave, onClose }) {
  const [name, setName] = useState(player.name || '')
  const [number, setNumber] = useState(player.number ?? '')
  const [position, setPosition] = useState(player.position || 'F')
  const [positionDetail, setPositionDetail] = useState(player.positionDetail || '')
  const [shoots, setShoots] = useState(player.shoots || '')
  const [nationality, setNationality] = useState(player.nationality || '')
  const [heightCm, setHeightCm] = useState(player.heightCm ?? '')
  const [weightKg, setWeightKg] = useState(player.weightKg ?? '')
  const [birthdate, setBirthdate] = useState(player.birthdate || '')
  const submit = () => {
    if (!name.trim()) return
    onSave({
      name: name.trim(),
      number: number === '' ? '' : Number(number),
      position,
      positionDetail: positionDetail.trim(),
      shoots,
      nationality: nationality.trim(),
      heightCm: heightCm === '' ? '' : Number(heightCm),
      weightKg: weightKg === '' ? '' : Number(weightKg),
      birthdate,
    })
  }
  return (
    <Modal
      title={player.id ? 'Spieler bearbeiten' : 'Spieler hinzufügen'}
      onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Abbrechen</button><button className="btn primary" onClick={submit}>Speichern</button></>}
    >
      <div>
        <label className="field">Name</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="z. B. Nico Hischier" />
      </div>
      <div className="form-row">
        <div>
          <label className="field">Nummer</label>
          <input type="number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="13" />
        </div>
        <div>
          <label className="field">Position</label>
          <select value={position} onChange={(e) => setPosition(e.target.value)}>
            {POS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
          </select>
        </div>
      </div>
      <div className="form-row">
        <div>
          <label className="field">Positions-Detail</label>
          <input value={positionDetail} onChange={(e) => setPositionDetail(e.target.value)} placeholder="z. B. C/RW" />
        </div>
        <div>
          <label className="field">Schusshand</label>
          <select value={shoots} onChange={(e) => setShoots(e.target.value)}>
            <option value="">–</option>
            <option value="L">Links</option>
            <option value="R">Rechts</option>
          </select>
        </div>
      </div>
      <div className="form-row">
        <div>
          <label className="field">Nationalität</label>
          <input value={nationality} onChange={(e) => setNationality(e.target.value)} placeholder="z. B. CH" />
        </div>
        <div>
          <label className="field">Geburtsdatum</label>
          <input type="date" value={birthdate} onChange={(e) => setBirthdate(e.target.value)} />
        </div>
      </div>
      <div className="form-row">
        <div>
          <label className="field">Grösse (cm)</label>
          <input type="number" value={heightCm} onChange={(e) => setHeightCm(e.target.value)} placeholder="186" />
        </div>
        <div>
          <label className="field">Gewicht (kg)</label>
          <input type="number" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} placeholder="88" />
        </div>
      </div>
    </Modal>
  )
}

function TeamModal({ team, onSave, onClose }) {
  const [name, setName] = useState(team.name)
  const [short, setShort] = useState(team.short)
  const [color, setColor] = useState(team.color)
  return (
    <Modal
      title="Team bearbeiten"
      onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Abbrechen</button><button className="btn primary" onClick={() => onSave({ name, short, color })}>Speichern</button></>}
    >
      <div><label className="field">Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="form-row">
        <div><label className="field">Kürzel</label><input value={short} onChange={(e) => setShort(e.target.value)} /></div>
        <div><label className="field">Farbe</label>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ height: 40, padding: 4 }} />
        </div>
      </div>
    </Modal>
  )
}
