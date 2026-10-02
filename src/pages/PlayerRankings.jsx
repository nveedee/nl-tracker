// ---------------------------------------------------------------------------
// Spieler-Seite (/players) - zentrale Player-Analytics-Seite des NL Trackers.
// Informationsarchitektur (oben -> unten, wichtig -> Detail):
//   1. Hero (Liga-Kader-Übersicht)  2. League Leaders  3. Player Ranking
//   4. Form & Entwicklung (Breakout/Declining)  5. Market Analytics
//   6. Spieler vergleichen
// Verwendet ausschliesslich bereits bestehende Datenquellen/Berechnungen
// (derived.playerStats aus stats.js::computePlayerStats, Impact Score/Trend-
// Klassifikation aus playerHistory.js, Marktwert-Verlauf aus
// marketValueHistory.js) - keine neue Kennzahl, keine Modelländerung.
// ---------------------------------------------------------------------------

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge, SortableTable, MarketValueTrend, SectionHeader, Empty } from '../components/ui.jsx'
import { fmtPct, fmtNum, plusMinusStr, fmtChf, isFinalGame } from '../stats.js'
import {
  usePlayerHistory, usePositionBaselines, getPlayerSeasons, classifyTrend, isBreakout, isDeclining,
  buildCurrentSeasonRecord, computeImpactScore, POSITION_LABEL,
} from '../playerHistory.js'
import { computeLeagueMarketMovers, hasEnoughHistoryForChart } from '../marketValueHistory.js'
import {
  calculatePlayerRating, buildSkaterRatingBaselines, buildGoalieRatingBaselines, buildGoalieCareerBaseline,
} from '../playerRating.js'

const MARKET_MOVERS_WINDOW_DAYS = 14
const posLabel = { G: 'G', D: 'D', F: 'F' }
const MIN_GP_OPTIONS = [0, 5, 10, 20]
const PAGE_SIZE_OPTIONS = [25, 50, 100, 0] // 0 = alle (Auftrag Punkt E)
// League Leaders sind bewusst UNABHÄNGIG vom Mindestspiele-/Team-Filter der
// Haupttabelle (sonst verschwinden Liga-Bestwerte, sobald man die Tabelle
// filtert) - für Ratenstatistiken (P/GP) trotzdem eine Mindestspielzahl
// gegen Kleinstichproben, derselbe Wert wie die Default-Einstellung des
// Mindestspiele-Filters unten (keine neue Schwelle erfunden).
const LEADER_MIN_GP_RATE = 5
// Liga-Durchschnitt (Hero) erst zeigen, wenn nicht nur 1-2 Spieler zufällig
// bereits gp>0 haben - sonst ist der "Durchschnitt" nur ein Einzelwert.
const LEAGUE_AVG_MIN_PLAYERS = 5
// Exakt dieselben Erklärtexte wie schon bisher als title-Attribut auf den
// Spaltenköpfen (siehe computeImpactScore/calculatePlayerRating-Kommentare
// in playerHistory.js/playerRating.js) - hier nur zentralisiert, damit sie
// identisch für den Spaltenkopf UND den neuen InfoDot verwendet werden.
const IMPACT_TOOLTIP = 'Positions-relatives Karriere-Perzentil (0-100) aus Punkte/Spiel, Eiszeit/Spiel, +/- /Spiel und Schüsse/Spiel, je innerhalb Stürmer/Verteidiger normiert (siehe playerHistory.js::computeImpactScore).'
const RATING_TOOLTIP = 'Player Rating (analytisch, unabhängig vom Prediction-Modell) - kombiniert Karriere-Impact, aktuelle Saison und Form je nach Spielanzahl (siehe playerRating.js).'
const GOALIE_RATING_TOOLTIP = 'Goalie Rating (analytisch, unabhängig vom Prediction-Modell) - kombiniert Karriere, aktuelle Saison und Form je nach Spielanzahl (siehe playerRating.js).'

function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null }
function fmt2(v) { return v == null ? '–' : v.toFixed(2) }
function normalizeSearch(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}
// Info-Hinweis-Punkt neben einem Spaltenkopf/Label - macht einen bereits
// vorhandenen title-Tooltip sichtbar/entdeckbar statt nur per Zufalls-Hover
// (Auftrag Punkt F). Kein neuer Erklärtext - derselbe `title` wie die Spalte.
function InfoDot({ title }) {
  return <span className="info-dot" title={title} aria-label={title}>i</span>
}

// Kleine Inline-SVG-Sparkline (Marktwert-Verlauf, Auftrag Punkt I) - nur
// aufgerufen, wenn hasEnoughHistoryForChart() bereits bestätigt hat, dass
// genug echte Historie vorhanden ist (marketValueHistory.js). Keine Achsen/
// Beschriftung - reiner Trendverlauf, Farbe je nach Richtung (letzter vs.
// erster Punkt).
function Sparkline({ values, width = 56, height = 20 }) {
  if (!values || values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const n = values.length
  const pts = values.map((v, i) => {
    const x = (i / (n - 1)) * (width - 2) + 1
    const y = height - 1 - ((v - min) / span) * (height - 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const rising = values[values.length - 1] >= values[0]
  const color = rising ? 'var(--good)' : 'var(--bad)'
  return (
    <svg className="market-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Marktwert-Verlauf">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Top-N nach einem Wert, `player`/`value` je Eintrag ableiten - liefert eine
// einheitliche [{player, value}]-Form für LeaderCard, egal aus welcher
// Datenquelle (derived.playerStats-Zeile, {player, impact}-Objekt, rohes
// player-Objekt für Marktwert).
function topN(items, playerFn, valueFn, n = 3) {
  return items
    .map((it) => ({ player: playerFn(it), value: valueFn(it) }))
    .filter((e) => e.value != null && Number.isFinite(e.value))
    .sort((a, b) => b.value - a.value)
    .slice(0, n)
}

export default function PlayerRankings() {
  const { data, derived } = useData()
  const playerHistoryData = usePlayerHistory()
  const baselines = usePositionBaselines()
  const [mode, setMode] = useState('skater') // skater | goalie
  const [teamFilter, setTeamFilter] = useState('all')
  const [posFilter, setPosFilter] = useState('all') // all | F | D (nur im skater-Modus relevant)
  const [query, setQuery] = useState('')
  const [minGp, setMinGp] = useState(5) // Mindestspiele gegen Kleinstichproben-Verzerrung
  const [compareA, setCompareA] = useState('')
  const [compareB, setCompareB] = useState('')
  const [pageSize, setPageSize] = useState(25) // Pagination der Haupttabelle (Auftrag Punkt E) - 0 = alle

  const currentSeasonLabel = data.settings?.seasonName?.match(/\d{4}\/\d{2}/)?.[0] || null
  const statById = useMemo(() => Object.fromEntries(derived.playerStats.map((s) => [s.player.id, s])), [derived.playerStats])
  const teamMap = useMemo(() => Object.fromEntries(data.teams.map((t) => [t.id, t])), [data.teams])

  // Player-Rating-Baselines (src/playerRating.js) - EINMAL für die ganze
  // Liga gebaut (unabhängig von mode/Filtern), nicht pro Tabellenzeile neu
  // berechnet. Analytisches Rating, unabhängig vom Prediction-Modell -
  // KEINE Änderung an der Rating-Logik selbst.
  const skaterRatingBaselines = useMemo(() => buildSkaterRatingBaselines(data.players, data.games), [data.players, data.games])
  const goalieRatingBaselines = useMemo(() => buildGoalieRatingBaselines(data.players, data.games), [data.players, data.games])
  const goalieCareerBaseline = useMemo(() => (playerHistoryData ? buildGoalieCareerBaseline(playerHistoryData) : null), [playerHistoryData])

  // 1) Hero: reine Kaderzahlen (ALLE data.players, unabhängig von
  // Saison-Spielstatistiken) + wie viele davon schon verwertbare Stats haben.
  // Behebt die frühere irreführende "0 Feldspieler"-Anzeige (die vorher aus
  // derived.playerStats.filter(gp>0) kam, nicht aus dem tatsächlichen Kader).
  const skaterCount = useMemo(() => data.players.filter((p) => p.position !== 'G').length, [data.players])
  const goalieCount = useMemo(() => data.players.filter((p) => p.position === 'G').length, [data.players])
  const playersWithStats = useMemo(() => derived.playerStats.filter((p) => p.gp > 0), [derived.playerStats])
  const finalGamesCount = useMemo(() => data.games.filter(isFinalGame).length, [data.games])
  const avgPpg = useMemo(() => {
    const sk = playersWithStats.filter((p) => p.player.position !== 'G')
    if (sk.length < LEAGUE_AVG_MIN_PLAYERS) return null
    return mean(sk.map((p) => p.points / p.gp))
  }, [playersWithStats])
  const avgMarketValue = useMemo(() => {
    const withMv = data.players.filter((p) => p.marketValue != null)
    if (withMv.length < LEAGUE_AVG_MIN_PLAYERS) return null
    return mean(withMv.map((p) => p.marketValue))
  }, [data.players])

  // 2) League Leaders - ligaweite Top-3 je Kategorie, siehe topN() oben.
  const leagueSkaters = useMemo(
    () => derived.playerStats.filter((p) => p.player.position !== 'G' && p.gp > 0),
    [derived.playerStats]
  )
  const leagueGoalies = useMemo(
    () => derived.playerStats.filter((p) => p.player.position === 'G' && p.gp > 0),
    [derived.playerStats]
  )
  const leagueSkatersWithImpact = useMemo(() => {
    if (!baselines || !playerHistoryData) return []
    return data.players
      .filter((p) => p.position !== 'G')
      .map((p) => ({ player: p, impact: computeImpactScore(getPlayerSeasons(playerHistoryData, p.id), POSITION_LABEL[p.position], baselines) }))
      .filter((e) => e.impact != null)
  }, [data.players, playerHistoryData, baselines])
  const leaguePlayersWithMv = useMemo(() => data.players.filter((p) => p.marketValue != null), [data.players])

  // Liga-Rating-Leaderboard (Auftrag Punkt C, Gruppe "Performance") - nutzt
  // exakt dieselbe calculatePlayerRating()-Funktion wie die Haupttabelle
  // unten (src/playerRating.js, unverändert), hier einmal ligaweit
  // (unabhängig von den Tabellenfiltern) über alle Feldspieler mit
  // Saison-Einsatz berechnet - keine neue Kennzahl, nur eine zusätzliche
  // Top-3-Ansicht derselben bereits vorhandenen Zahl.
  const leagueSkatersWithRating = useMemo(() => {
    if (!skaterRatingBaselines) return []
    return leagueSkaters.map((r) => ({
      player: r.player,
      rating: calculatePlayerRating(r.player.id, data.games, {
        players: data.players, playerHistoryData, careerBaselines: baselines, skaterBaselines: skaterRatingBaselines,
      })?.overall ?? null,
    })).filter((e) => e.rating != null)
  }, [leagueSkaters, data.games, data.players, playerHistoryData, baselines, skaterRatingBaselines])

  const leaders = useMemo(() => ({
    points: topN(leagueSkaters, (r) => r.player, (r) => r.points),
    goals: topN(leagueSkaters, (r) => r.player, (r) => r.goals),
    assists: topN(leagueSkaters, (r) => r.player, (r) => r.assists),
    ppg: topN(leagueSkaters.filter((r) => r.gp >= LEADER_MIN_GP_RATE), (r) => r.player, (r) => r.points / r.gp),
    impact: topN(leagueSkatersWithImpact, (e) => e.player, (e) => e.impact.score),
    rating: topN(leagueSkatersWithRating, (e) => e.player, (e) => e.rating),
    marketValue: topN(leaguePlayersWithMv, (p) => p, (p) => p.marketValue),
    savePct: topN(leagueGoalies.filter((r) => r.savePct != null), (r) => r.player, (r) => r.savePct),
    wins: topN(leagueGoalies, (r) => r.player, (r) => r.wins),
    shutouts: topN(leagueGoalies.filter((r) => r.shutouts > 0), (r) => r.player, (r) => r.shutouts),
  }), [leagueSkaters, leagueGoalies, leagueSkatersWithImpact, leagueSkatersWithRating, leaguePlayersWithMv])

  // 4) Form & Entwicklung: Breakout/Declining - rein aus der Trend-
  // Klassifikation (src/playerHistory.js::classifyTrend) abgeleitet, keine
  // subjektive Bewertung, unverändert gegenüber der bisherigen Logik. Bezieht
  // seit dem Player Tracker auch die LAUFENDE Saison mit ein (via
  // buildCurrentSeasonRecord aus bereits abgeschlossenen Spielen - kein
  // Leakage). Nur Spieler mit >=3 gespielten Saisons werden klassifiziert.
  const { breakouts, declines } = useMemo(() => {
    if (!playerHistoryData) return { breakouts: [], declines: [] }
    const b = [], d = []
    for (const p of data.players) {
      if (p.position === 'G') continue
      const seasons = getPlayerSeasons(playerHistoryData, p.id)
      const current = buildCurrentSeasonRecord(statById[p.id], p, currentSeasonLabel)
      const trend = classifyTrend(current ? [...seasons, current] : seasons)
      if (!trend) continue
      const impact = baselines ? computeImpactScore(seasons, POSITION_LABEL[p.position], baselines) : null
      const team = data.teams.find((t) => t.id === p.teamId)
      const entry = { player: p, team, trend, impact }
      if (isBreakout(trend)) b.push(entry)
      else if (isDeclining(trend)) d.push(entry)
    }
    b.sort((a, b2) => b2.trend.ratio - a.trend.ratio)
    d.sort((a, b2) => a.trend.ratio - b2.trend.ratio)
    return { breakouts: b.slice(0, 5), declines: d.slice(0, 5) }
  }, [data.players, data.teams, playerHistoryData, statById, currentSeasonLabel, baselines])

  // 5) Market Analytics. mvRisers/mvFallers: Richtung aus marketValueTrend
  // (NL-API liefert nur -1/0/1, keine Delta-Höhe) - Fallback, solange
  // leagueMovers (echte CHF-Differenz aus marketValueHistory) noch nicht
  // genug Historie hat.
  const { mvRisers, mvFallers } = useMemo(() => {
    const withMv = data.players.filter((p) => p.marketValue != null && p.marketValueTrend != null)
    const build = (trend) => withMv
      .filter((p) => p.marketValueTrend === trend)
      .sort((a, b) => b.marketValue - a.marketValue)
      .slice(0, 5)
      .map((p) => ({ player: p, team: teamMap[p.teamId] }))
    return { mvRisers: build(1), mvFallers: build(-1) }
  }, [data.players, teamMap])
  const topMarketValues = useMemo(
    () => [...leaguePlayersWithMv].sort((a, b) => b.marketValue - a.marketValue).slice(0, 5),
    [leaguePlayersWithMv]
  )
  const leagueMovers = useMemo(
    () => computeLeagueMarketMovers(data.players, MARKET_MOVERS_WINDOW_DAYS),
    [data.players]
  )

  // "Was ist aktuell interessant?" - reine Zusammenstellung bereits oben
  // berechneter Werte (leaders/leagueMovers/breakouts), keine neue
  // Berechnung. Jeder Eintrag nur, wenn tatsächlich ein Wert vorhanden ist.
  const topRiser = leagueMovers.ready ? leagueMovers.risers[0] : (mvRisers[0] ? { player: mvRisers[0].player, delta: null } : null)
  const topFaller = leagueMovers.ready ? leagueMovers.fallers[0] : (mvFallers[0] ? { player: mvFallers[0].player, delta: null } : null)
  const insights = [
    leaders.points[0] && { label: 'Top Scorer', player: leaders.points[0].player, value: `${leaders.points[0].value} Pkt.` },
    leaders.ppg[0] && { label: 'Top P/GP', player: leaders.ppg[0].player, value: leaders.ppg[0].value.toFixed(2) },
    leaders.impact[0] && { label: 'Top Impact', player: leaders.impact[0].player, value: leaders.impact[0].value.toFixed(1) },
    topRiser && { label: 'Grösster Marktwertanstieg', player: topRiser.player, value: topRiser.delta != null ? `+${fmtChf(topRiser.delta)}` : fmtChf(topRiser.player.marketValue), tone: 'good' },
    topFaller && { label: 'Grösster Marktwertrückgang', player: topFaller.player, value: topFaller.delta != null ? fmtChf(topFaller.delta) : fmtChf(topFaller.player.marketValue), tone: 'bad' },
    breakouts[0] && { label: 'Stärkster Breakout', player: breakouts[0].player, value: `${breakouts[0].trend.latestPpg.toFixed(2)} P/GP (${breakouts[0].trend.ratio >= 1 ? '+' : ''}${Math.round((breakouts[0].trend.ratio - 1) * 100)}%)`, tone: 'good' },
  ].filter(Boolean)

  // 3) Haupt-Ranking
  let rows = derived.playerStats.filter((p) => p.gp > 0)
  if (teamFilter !== 'all') rows = rows.filter((p) => p.player.teamId === teamFilter)
  const isGoalie = (p) => p.player.position === 'G'
  rows = rows.filter((p) => (mode === 'goalie' ? isGoalie(p) : !isGoalie(p)))
  if (mode === 'skater' && posFilter !== 'all') rows = rows.filter((p) => p.player.position === posFilter)
  if (minGp > 0) rows = rows.filter((p) => p.gp >= minGp)

  // Performante Client-Suche: bei ~409 Spielern reicht ein einfacher, per
  // Query memoizierter Substring-Filter über Name+Team, akzent-unempfindlich.
  const filtered = useMemo(() => {
    const q = normalizeSearch(query)
    if (!q) return rows
    return rows.filter((p) => {
      const teamName = normalizeSearch(teamMap[p.player.teamId]?.name)
      const teamShort = normalizeSearch(teamMap[p.player.teamId]?.short)
      return normalizeSearch(p.player.name).includes(q) || teamName.includes(q) || teamShort.includes(q)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, query])

  // Rang: einmal nach dem für den Modus üblichen Standardkriterium
  // vorsortiert (SortableTable sortiert die ANZEIGE unabhängig davon weiter).
  const ranked = useMemo(() => {
    const arr = [...filtered].sort((a, b) =>
      mode === 'goalie' ? (b.savePct ?? -1) - (a.savePct ?? -1) : b.points - a.points || b.goals - a.goals
    )
    return arr.map((r, i) => ({
      ...r, rank: i + 1,
      impact: (mode === 'skater' && baselines && playerHistoryData)
        ? computeImpactScore(getPlayerSeasons(playerHistoryData, r.player.id), POSITION_LABEL[r.player.position], baselines)
        : null,
      rating: calculatePlayerRating(r.player.id, data.games, {
        players: data.players,
        playerHistoryData,
        careerBaselines: mode === 'skater' ? baselines : undefined,
        skaterBaselines: mode === 'skater' ? skaterRatingBaselines : undefined,
        goalieBaselines: mode === 'goalie' ? goalieRatingBaselines : undefined,
        goalieCareerBaseline: mode === 'goalie' ? goalieCareerBaseline : undefined,
      }),
    }))
  }, [filtered, mode, baselines, playerHistoryData, data.games, data.players, skaterRatingBaselines, goalieRatingBaselines, goalieCareerBaseline])

  const nameCell = (r) => (
    <span className="row gap-sm">
      <Link to={`/players/${r.player.id}`}>{r.player.name}</Link>
      {r.player.number != null && r.player.number !== '' && <span className="muted">#{r.player.number}</span>}
    </span>
  )
  const teamCell = (r) => <TeamBadge team={teamMap[r.player.teamId]} short />
  const posCell = (r) => <span className="chip">{posLabel[r.player.position] || r.player.position}{r.player.positionDetail ? ` · ${r.player.positionDetail}` : ''}</span>

  const marketValueCol = {
    key: 'marketValue', label: 'Marktwert', num: true, title: 'Marktwert in CHF · Quelle: nationalleague.ch',
    value: (r) => r.player.marketValue ?? -1,
    render: (r) => r.player.marketValue == null ? <span className="muted">–</span> : (
      <span className="row gap-sm" style={{ justifyContent: 'flex-end' }}>
        {fmtChf(r.player.marketValue)}
        <MarketValueTrend trend={r.player.marketValueTrend} />
      </span>
    ),
  }

  // Haupttabelle für Skater - bewusst genau die vom Nutzer priorisierten
  // Spalten (Rank/Spieler/Team/Pos/GP/G/A/P/P-GP/SOG/+-/Impact/Marktwert);
  // Impact steht direkt hier statt in einer separaten "Wer trägt das Team"-
  // Ansicht (die gab es auf /players ohnehin nicht, aber derselbe Grundsatz).
  const skaterCols = [
    { key: 'rank', label: '#', num: true, noSort: true, render: (r) => <span className="rank">{r.rank}</span> },
    { key: 'name', label: 'Spieler', left: true, noSort: true, render: nameCell },
    { key: 'team', label: 'Team', left: true, noSort: true, render: teamCell },
    { key: 'pos', label: 'Pos.', left: true, noSort: true, render: posCell },
    { key: 'gp', label: 'GP', num: true },
    { key: 'goals', label: 'G', num: true },
    { key: 'assists', label: 'A', num: true },
    { key: 'points', label: 'P', num: true, render: (r) => <strong>{r.points}</strong> },
    { key: 'ppg', label: 'P/GP', num: true, value: (r) => (r.gp > 0 ? r.points / r.gp : -1), render: (r) => (r.gp > 0 ? (r.points / r.gp).toFixed(2) : '–') },
    { key: 'sog', label: 'SOG', num: true, value: (r) => r.sog ?? -1, render: (r) => r.sog ?? <span className="muted">–</span> },
    { key: 'plusMinus', label: '+/–', num: true, value: (r) => r.plusMinus,
      render: (r) => <span style={{ color: r.plusMinus > 0 ? 'var(--good)' : r.plusMinus < 0 ? 'var(--bad)' : 'inherit' }}>{plusMinusStr(r.plusMinus)}</span> },
    {
      key: 'impact', num: true, title: IMPACT_TOOLTIP,
      label: <>Impact<InfoDot title={IMPACT_TOOLTIP} /></>,
      value: (r) => r.impact?.score ?? -1, render: (r) => r.impact ? r.impact.score.toFixed(1) : <span className="muted">–</span>,
    },
    {
      key: 'rating', num: true, title: RATING_TOOLTIP,
      label: <>Rating<InfoDot title={RATING_TOOLTIP} /></>,
      value: (r) => r.rating?.overall ?? -1, render: (r) => r.rating?.overall != null ? <strong>{r.rating.overall.toFixed(1)}</strong> : <span className="muted">–</span>,
    },
    marketValueCol,
  ]

  const goalieCols = [
    { key: 'rank', label: '#', num: true, noSort: true, render: (r) => <span className="rank">{r.rank}</span> },
    { key: 'name', label: 'Torhüter', left: true, noSort: true, render: nameCell },
    { key: 'team', label: 'Team', left: true, noSort: true, render: teamCell },
    { key: 'gp', label: 'GP', num: true },
    { key: 'wins', label: 'S', num: true },
    { key: 'losses', label: 'N', num: true },
    { key: 'savePct', label: 'SV%', num: true, value: (r) => r.savePct ?? -1, render: (r) => fmtPct(r.savePct) },
    { key: 'gaa', label: 'GTS', num: true, title: 'Gegentorschnitt', value: (r) => r.gaa ?? 99, render: (r) => fmtNum(r.gaa) },
    { key: 'saves', label: 'Paraden', num: true },
    { key: 'shutouts', label: 'SO', num: true },
    {
      key: 'rating', num: true, title: GOALIE_RATING_TOOLTIP,
      label: <>Rating<InfoDot title={GOALIE_RATING_TOOLTIP} /></>,
      value: (r) => r.rating?.overall ?? -1, render: (r) => r.rating?.overall != null ? <strong>{r.rating.overall.toFixed(1)}</strong> : <span className="muted">–</span>,
    },
    marketValueCol,
  ]

  return (
    <>
      {/* 1) Hero - bewusst kompakt (eine Zeile, keine grosse Box) */}
      <div className="page-head">
        <div>
          <h1>Spieler</h1>
          <div className="sub">National League 2026/27</div>
        </div>
      </div>
      <div className="card mb" style={{ padding: '10px 16px' }}>
        <div className="stat-strip">
          <div className="stat"><strong>{data.players.length}</strong><span>Spieler im Kader</span></div>
          <div className="stat"><strong>{skaterCount}</strong><span>Feldspieler</span></div>
          <div className="stat"><strong>{goalieCount}</strong><span>Torhüter</span></div>
          <div className="stat"><strong>{playersWithStats.length}</strong><span>mit Saison-Stats</span></div>
          <div className="stat"><strong>{finalGamesCount}</strong><span>Spiele mit Player Stats</span></div>
          {avgPpg != null && <div className="stat"><strong>{avgPpg.toFixed(2)}</strong><span>Ø P/GP (Liga)</span></div>}
          {avgMarketValue != null && <div className="stat"><strong>CHF {fmtChf(Math.round(avgMarketValue))}</strong><span>Ø Marktwert</span></div>}
        </div>
      </div>

      {/* 2) "Was ist aktuell interessant?" - 5-Sekunden-Überblick aus bereits
          vorhandenen Werten (Leaders/Market Movers/Breakout), bevor man durch
          die grosse Tabelle suchen muss. */}
      {insights.length > 0 && (
        <>
          <SectionHeader title="Was ist aktuell interessant?" />
          <div className="insights-grid mb">
            {insights.map((e, i) => (
              <Link key={i} to={`/players/${e.player.id}`} className="insight-card">
                <div className="insight-label">{e.label}</div>
                <div className="insight-name">{e.player.name}</div>
                <div className={['insight-value', e.tone || ''].join(' ')}>{e.value}</div>
              </Link>
            ))}
          </div>
        </>
      )}

      {/* 3) League Leaders - gruppiert (Offense/Performance/Goalies/Market)
          statt einer langen horizontal scrollenden Reihe. */}
      <SectionHeader title="League Leaders" caption="Top 3 je Kategorie, ligaweit (unabhängig von den Filtern unten)." />
      <div className="mb">
        <div className="leader-group">
          <div className="leader-group-label">Offense</div>
          <div className="leader-group-grid">
            <LeaderCard title="Punkte" entries={leaders.points} formatValue={(v) => v} />
            <LeaderCard title="P/GP" entries={leaders.ppg} formatValue={(v) => v.toFixed(2)} />
            <LeaderCard title="Tore" entries={leaders.goals} formatValue={(v) => v} />
            <LeaderCard title="Assists" entries={leaders.assists} formatValue={(v) => v} />
          </div>
        </div>
        <div className="leader-group">
          <div className="leader-group-label">Performance</div>
          <div className="leader-group-grid">
            <LeaderCard title="Impact" entries={leaders.impact} formatValue={(v) => v.toFixed(1)} />
            <LeaderCard title="Rating" entries={leaders.rating} formatValue={(v) => v.toFixed(1)} />
          </div>
        </div>
        {leagueGoalies.length > 0 && (
          <div className="leader-group">
            <div className="leader-group-label">Goalies</div>
            <div className="leader-group-grid">
              <LeaderCard title="SV%" entries={leaders.savePct} formatValue={(v) => fmtPct(v)} />
              <LeaderCard title="Siege" entries={leaders.wins} formatValue={(v) => v} />
              <LeaderCard title="Shutouts" entries={leaders.shutouts} formatValue={(v) => v} />
            </div>
          </div>
        )}
        <div className="leader-group">
          <div className="leader-group-label">Market</div>
          <div className="leader-group-grid">
            <LeaderCard title="Marktwert" entries={leaders.marketValue} formatValue={(v) => fmtChf(v)} />
          </div>
        </div>
      </div>

      {/* 4) Haupt-Ranking - das Herzstück der Seite */}
      <SectionHeader title="Player Ranking" caption="Alle Kaderspieler mit Saison-Stats, sortierbar per Klick auf die Spaltenköpfe." />
      <div className="card card-pad mb">
        <div className="row gap-sm wrap">
          <div className="pill-tabs">
            <button className={mode === 'skater' ? 'active' : ''} onClick={() => setMode('skater')}>Skater</button>
            <button className={mode === 'goalie' ? 'active' : ''} onClick={() => setMode('goalie')}>Goalies</button>
          </div>
          <input
            type="text" placeholder="Spieler oder Team suchen…" value={query}
            onChange={(e) => setQuery(e.target.value)} style={{ width: 200 }}
          />
          <select style={{ width: 'auto' }} value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
            <option value="all">Alle Teams</option>
            {[...data.teams].sort((a, b) => a.name.localeCompare(b.name)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {mode === 'skater' && (
            <select style={{ width: 'auto' }} value={posFilter} onChange={(e) => setPosFilter(e.target.value)}>
              <option value="all">Alle Positionen</option>
              <option value="F">Stürmer</option>
              <option value="D">Verteidiger</option>
            </select>
          )}
          <select style={{ width: 'auto' }} value={minGp} onChange={(e) => setMinGp(Number(e.target.value))} title="Mindestanzahl Spiele">
            {MIN_GP_OPTIONS.map((n) => <option key={n} value={n}>{n === 0 ? 'Alle Spiele' : `≥ ${n} Spiele`}</option>)}
          </select>
          <select style={{ width: 'auto' }} value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} title="Spieler pro Seite">
            {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n === 0 ? 'Alle anzeigen' : `${n} pro Seite`}</option>)}
          </select>
        </div>
      </div>

      {ranked.length === 0 ? (
        <Empty
          title={query ? 'Keine Treffer' : 'Noch keine Werte für diese Auswahl'}
          hint={query ? 'Andere Suche versuchen.' : 'Filter lockern oder abwarten, bis mehr Spiele erfasst sind - die Kaderdaten oben sind davon unabhängig bereits vollständig.'}
        />
      ) : (
        <div className="card mb">
          <SortableTable
            columns={mode === 'goalie' ? goalieCols : skaterCols}
            rows={ranked}
            initialSort={mode === 'goalie' ? 'savePct' : 'points'}
            initialDir="desc"
            rowKey={(r) => r.player.id}
            pageSize={pageSize || undefined}
            wrapClassName={pageSize ? 'ranking-scroll' : ''}
          />
        </div>
      )}

      {/* 4) Form & Entwicklung */}
      {(breakouts.length > 0 || declines.length > 0) && (
        <>
          <SectionHeader
            title="Form & Entwicklung"
            caption="Vergleich der jüngsten ausgewerteten Saison (mind. 10 Spiele - das kann die laufende Saison 2026/27 sein, sobald ein Spieler dort ≥10 Spiele erreicht hat, sonst die letzte abgeschlossene Saison) gegen den Karriere-Schnitt davor (mind. 3 gespielte Saisons insgesamt)."
          />
          <div className="grid grid-2 mb" style={{ gap: 14 }}>
            <TrendGroup title="Breakout" entries={breakouts} tone="good" currentSeasonLabel={currentSeasonLabel} />
            <TrendGroup title="Declining" entries={declines} tone="bad" currentSeasonLabel={currentSeasonLabel} />
          </div>
        </>
      )}

      {/* 5) Market Watch - eine gemeinsame Karte statt drei unabhängiger
          Tabellen, mit Sparkline pro Zeile wo genug Historie vorhanden ist. */}
      {(topMarketValues.length > 0 || leagueMovers.ready || mvRisers.length > 0 || mvFallers.length > 0) && (
        <>
          <SectionHeader title="Market Watch" caption="Marktwerte laut nationalleague.ch." />
          <div className="market-watch mb">
            <div className="market-watch-cols">
              <div className="market-watch-col">
                <MarketList title="Höchste Marktwerte" empty="Noch keine Marktwerte." bare>
                  {topMarketValues.map((p) => {
                    const s = statById[p.id]
                    return (
                      <MarketRow key={p.id} player={p} team={teamMap[p.teamId]}>
                        <strong>{fmtChf(p.marketValue)}</strong>
                        {s?.gp > 0 && p.position !== 'G' && (
                          <span className="muted" style={{ fontSize: 11 }}> · {s.points} P · {(s.points / s.gp).toFixed(2)} P/GP</span>
                        )}
                      </MarketRow>
                    )
                  })}
                </MarketList>
              </div>
              <div className="market-watch-col">
                <MarketList title={leagueMovers.ready ? `Grösste Steigerungen (${MARKET_MOVERS_WINDOW_DAYS} T.)` : 'Steigende Marktwerte'} empty="Keine Steiger." bare>
                  {leagueMovers.ready
                    ? leagueMovers.risers.map(({ player, delta, deltaPct, latest }) => (
                        <MarketRow key={player.id} player={player} team={teamMap[player.teamId]}>
                          <strong className="good">+{fmtChf(delta)}</strong>
                          {deltaPct != null && <span className="muted" style={{ fontSize: 11 }}> ({deltaPct >= 0 ? '+' : ''}{(deltaPct * 100).toFixed(1)}%)</span>}
                          <span className="muted" style={{ fontSize: 11 }}> · {fmtChf(latest.marketValue)}</span>
                        </MarketRow>
                      ))
                    : mvRisers.map(({ player, team }) => (
                        <MarketRow key={player.id} player={player} team={team}>
                          <strong className="good">{fmtChf(player.marketValue)}</strong> <MarketValueTrend trend={player.marketValueTrend} />
                        </MarketRow>
                      ))}
                  {!leagueMovers.ready && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                      Echte {MARKET_MOVERS_WINDOW_DAYS}-Tage-Veränderung noch nicht verfügbar ({leagueMovers.count}/{leagueMovers.minPlayers} Spieler mit genug Verlaufsdaten) - bis dahin nur Richtung.
                    </div>
                  )}
                </MarketList>
              </div>
              <div className="market-watch-col">
                <MarketList title={leagueMovers.ready ? `Grösste Rückgänge (${MARKET_MOVERS_WINDOW_DAYS} T.)` : 'Fallende Marktwerte'} empty="Keine Faller." bare>
                  {leagueMovers.ready
                    ? leagueMovers.fallers.map(({ player, delta, deltaPct, latest }) => (
                        <MarketRow key={player.id} player={player} team={teamMap[player.teamId]}>
                          <strong className="bad">{fmtChf(delta)}</strong>
                          {deltaPct != null && <span className="muted" style={{ fontSize: 11 }}> ({(deltaPct * 100).toFixed(1)}%)</span>}
                          <span className="muted" style={{ fontSize: 11 }}> · {fmtChf(latest.marketValue)}</span>
                        </MarketRow>
                      ))
                    : mvFallers.map(({ player, team }) => (
                        <MarketRow key={player.id} player={player} team={team}>
                          <strong className="bad">{fmtChf(player.marketValue)}</strong> <MarketValueTrend trend={player.marketValueTrend} />
                        </MarketRow>
                      ))}
                </MarketList>
              </div>
            </div>
          </div>
        </>
      )}

      {/* 6) Spieler vergleichen */}
      <PlayerCompare
        data={data} statById={statById} playerHistoryData={playerHistoryData} baselines={baselines}
        skaterRatingBaselines={skaterRatingBaselines}
        currentSeasonLabel={currentSeasonLabel}
        a={compareA} b={compareB} setA={setCompareA} setB={setCompareB}
      />
    </>
  )
}

// League-Leader-Karte: Titel + bis zu 3 anklickbare Zeilen (Rang/Name/Wert).
function LeaderCard({ title, entries, formatValue }) {
  return (
    <div className="card leader-card">
      <div className="card-pad" style={{ paddingBottom: 8 }}>
        <div className="leader-title">{title}</div>
        {entries.length === 0 ? (
          <div className="muted" style={{ fontSize: 11.5 }}>Noch keine Daten</div>
        ) : entries.map((e, i) => (
          <Link key={e.player.id} to={`/players/${e.player.id}`} className="leader-item">
            <span className="leader-rank">{i + 1}</span>
            <span className="leader-name">{e.player.name}</span>
            <span className="leader-value">{formatValue(e.value)}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}

// Form & Entwicklung: kompakte Player-Cards statt grosser Tabellen. Zeigt
// IMMER absolute UND prozentuale Veränderung nebeneinander (eine grosse
// %-Zahl allein kann bei kleinen Basiswerten irreführen) sowie einen klaren
// "geringe Stichprobe"-Hinweis, wenn der Vergleichswert aus der noch
// laufenden aktuellen Saison stammt (per Definition weniger Spiele als eine
// abgeschlossene Saison) - reine Anzeige, classifyTrend()/trend-Werte
// unverändert aus playerHistory.js übernommen.
function TrendGroup({ title, entries, tone, currentSeasonLabel }) {
  return (
    <div className="card">
      <div className="card-pad" style={{ paddingBottom: 6 }}><div className="section-label" style={{ margin: 0 }}>{title}</div></div>
      {entries.length === 0 ? (
        <div className="card-pad muted" style={{ fontSize: 12.5, paddingTop: 0 }}>Keine {tone === 'good' ? 'Kandidaten' : 'Auffälligkeiten'}.</div>
      ) : (
        <div className="card-pad" style={{ paddingTop: 0 }}>
          {entries.map(({ player, team, trend, impact }) => {
            const abs = trend.latestPpg - trend.careerPpgExclLatest
            const pct = (trend.ratio - 1) * 100
            const smallSample = trend.latestSeason === currentSeasonLabel
            return (
              <div key={player.id} className="row" style={{ padding: '9px 0', borderBottom: '1px solid var(--border)', gap: 10, alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row gap-sm" style={{ flexWrap: 'wrap' }}>
                    <Link to={`/players/${player.id}`} style={{ fontWeight: 700 }}>{player.name}</Link>
                    {smallSample && <span className="chip" title="Basiert auf der noch laufenden Saison, nicht auf einer abgeschlossenen">geringe Stichprobe</span>}
                  </div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    Saison {trend.latestSeason} · {team ? team.short : '–'} · {POSITION_LABEL[player.position]} · Impact {impact ? impact.score.toFixed(1) : '–'}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flex: 'none' }}>
                  <div style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    <strong>{trend.latestPpg.toFixed(2)}</strong> <span className="muted">P/GP ← {trend.careerPpgExclLatest.toFixed(2)}</span>
                  </div>
                  <div className={tone} style={{ fontWeight: 800, fontSize: 13, whiteSpace: 'nowrap' }}>
                    {abs >= 0 ? '+' : ''}{abs.toFixed(2)} ({pct >= 0 ? '+' : ''}{pct.toFixed(0)}%)
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Kompakte Market-Analytics-Liste (Höchste Marktwerte / Steigungen / Rückgänge).
// `bare`: ohne eigene Card (für den Einsatz als Spalte innerhalb der
// gemeinsamen "Market Watch"-Karte, siehe .market-watch-col).
function MarketList({ title, empty, children, bare = false }) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children)
  const content = !hasChildren ? <div className="muted" style={{ fontSize: 12.5 }}>{empty}</div> : children
  if (bare) {
    return (
      <>
        <div className="section-label" style={{ margin: '0 0 6px' }}>{title}</div>
        {content}
      </>
    )
  }
  return (
    <div className="card">
      <div className="card-pad" style={{ paddingBottom: 6 }}><div className="section-label" style={{ margin: 0 }}>{title}</div></div>
      <div className="card-pad" style={{ paddingTop: 0 }}>{content}</div>
    </div>
  )
}
// Zeigt zusätzlich eine kleine Marktwert-Sparkline, wenn genug echte
// Historie vorhanden ist (player.marketValueHistory, siehe
// marketValueHistory.js::hasEnoughHistoryForChart) - sonst keine.
function MarketRow({ player, team, children }) {
  const showSpark = hasEnoughHistoryForChart(player.marketValueHistory)
  return (
    <div className="row spread" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)', gap: 10 }}>
      <span className="row gap-sm" style={{ minWidth: 0 }}>
        <Link to={`/players/${player.id}`} style={{ fontWeight: 600 }}>{player.name}</Link>
        {team && <TeamBadge team={team} short />}
      </span>
      <span className="row gap-sm" style={{ flex: 'none' }}>
        {showSpark && <Sparkline values={player.marketValueHistory.map((h) => h.marketValue)} />}
        <span className="num" style={{ flex: 'none', whiteSpace: 'nowrap' }}>{children}</span>
      </span>
    </div>
  )
}

// 6) Spieler vergleichen - eigene, immer sichtbare Sektion (kein verstecktes
// Toggle mehr) mit klarem "A vs. B"-Aufbau. Nur Feldspieler (Impact Score/
// SOG/TOI sind für Torhüter nicht definiert, siehe playerHistory.js).
function PlayerCompare({ data, statById, playerHistoryData, baselines, skaterRatingBaselines, currentSeasonLabel, a, b, setA, setB }) {
  const skaters = useMemo(
    () => [...data.players].filter((p) => p.position !== 'G').sort((x, y) => x.name.localeCompare(y.name)),
    [data.players]
  )
  const teamMap = useMemo(() => Object.fromEntries(data.teams.map((t) => [t.id, t])), [data.teams])

  const build = (playerId) => {
    const player = data.players.find((p) => p.id === playerId)
    if (!player) return null
    const stat = statById[playerId]
    const seasons = getPlayerSeasons(playerHistoryData, playerId)
    const impact = baselines ? computeImpactScore(seasons, POSITION_LABEL[player.position], baselines) : null
    // Player Rating (analytisch, unabhängig vom Prediction-Modell) - siehe
    // src/playerRating.js, KEINE Änderung an der Rating-Logik hier.
    const rating = calculatePlayerRating(player.id, data.games, {
      players: data.players, playerHistoryData, careerBaselines: baselines, skaterBaselines: skaterRatingBaselines,
    })
    return { player, team: teamMap[player.teamId], stat, impact, rating }
  }
  const A = a ? build(a) : null
  const B = b ? build(b) : null

  return (
    <>
      <SectionHeader title="Spieler vergleichen" caption="Zwei Feldspieler nebeneinander - nur Werte, die tatsächlich vorhanden sind." />
      <div className="card card-pad mb">
        {!(A && B) && (
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
            Vergleiche zwei Spieler anhand der tatsächlich verfügbaren Saison- und Leistungsdaten.
          </div>
        )}
        <div className="row gap-sm" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 200px' }}>
            <label className="field">Spieler A</label>
            <select value={a} onChange={(e) => setA(e.target.value)}>
              <option value="">– wählen –</option>
              {skaters.map((p) => <option key={p.id} value={p.id} disabled={p.id === b}>{p.name}</option>)}
            </select>
          </div>
          <div className="muted" style={{ fontWeight: 800, padding: '0 4px 10px', flex: 'none' }}>vs.</div>
          <div style={{ flex: '1 1 200px' }}>
            <label className="field">Spieler B</label>
            <select value={b} onChange={(e) => setB(e.target.value)}>
              <option value="">– wählen –</option>
              {skaters.map((p) => <option key={p.id} value={p.id} disabled={p.id === a}>{p.name}</option>)}
            </select>
          </div>
        </div>

        {A && B ? (
          <div className="table-wrap mt">
            <table>
              <thead>
                <tr>
                  <th className="left">Kennzahl</th>
                  <th className="num">{A.player.name}</th>
                  <th className="num">{B.player.name}</th>
                </tr>
              </thead>
              <tbody>
                <CompareRow label="Team" v1={A.team?.short} v2={B.team?.short} fmt={(v) => v ?? '–'} neutral />
                <CompareRow label="Position" v1={POSITION_LABEL[A.player.position]} v2={POSITION_LABEL[B.player.position]} fmt={(v) => v ?? '–'} neutral />
                <CompareRow label={`GP (${currentSeasonLabel || 'Saison'})`} v1={A.stat?.gp ?? 0} v2={B.stat?.gp ?? 0} fmt={(v) => v} />
                <CompareRow label="Tore" v1={A.stat?.goals ?? 0} v2={B.stat?.goals ?? 0} fmt={(v) => v} />
                <CompareRow label="Assists" v1={A.stat?.assists ?? 0} v2={B.stat?.assists ?? 0} fmt={(v) => v} />
                <CompareRow label="Punkte" v1={A.stat?.points ?? 0} v2={B.stat?.points ?? 0} fmt={(v) => v} />
                <CompareRow label="P/GP (Saison)" v1={A.stat?.gp > 0 ? A.stat.points / A.stat.gp : null} v2={B.stat?.gp > 0 ? B.stat.points / B.stat.gp : null} fmt={fmt2} />
                <CompareRow label="SOG" v1={A.stat?.sog} v2={B.stat?.sog} fmt={(v) => v} />
                <CompareRow label="+/–" v1={A.stat?.plusMinus ?? 0} v2={B.stat?.plusMinus ?? 0} fmt={plusMinusStr} />
                <CompareRow label="Impact Score (Karriere)" v1={A.impact?.score} v2={B.impact?.score} fmt={(v) => v.toFixed(1)} />
                <CompareRow label="Player Rating" v1={A.rating?.overall} v2={B.rating?.overall} fmt={(v) => v.toFixed(1)} />
                <CompareRow label="Marktwert" v1={A.player.marketValue} v2={B.player.marketValue} fmt={fmtChf} />
              </tbody>
            </table>
          </div>
        ) : (
          <div className="muted mt" style={{ fontSize: 12.5 }}>Beide Spieler auswählen für den Vergleich.</div>
        )}
      </div>
    </>
  )
}

// Vergleichszeile mit dezenter Hervorhebung des besseren Werts - identisches
// Muster wie CompareRow in src/pages/MatchupDetail.jsx/TeamDetail.jsx.
function CompareRow({ label, v1, v2, fmt = (v) => v, lowerIsBetter = false, neutral = false }) {
  const has1 = v1 != null, has2 = v2 != null
  let w1 = false, w2 = false
  if (!neutral && has1 && has2 && v1 !== v2 && typeof v1 === 'number' && typeof v2 === 'number') {
    const firstBetter = lowerIsBetter ? v1 < v2 : v1 > v2
    w1 = firstBetter
    w2 = !firstBetter
  }
  const cellStyle = (won) => (won ? { fontWeight: 800, color: 'var(--accent)' } : { fontWeight: 600 })
  return (
    <tr>
      <td className="left muted" style={{ fontSize: 12.5 }}>{label}</td>
      <td className="num" style={cellStyle(w1)}>{has1 ? fmt(v1) : '–'}</td>
      <td className="num" style={cellStyle(w2)}>{has2 ? fmt(v2) : '–'}</td>
    </tr>
  )
}
