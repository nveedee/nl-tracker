import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge, SortableTable, MarketValueTrend } from '../components/ui.jsx'
import { fmtPct, fmtNum, plusMinusStr, fmtChf } from '../stats.js'
import {
  usePlayerHistory, usePositionBaselines, getPlayerSeasons, classifyTrend, isBreakout, isDeclining,
  buildCurrentSeasonRecord, computeImpactScore, careerSummary, yoyDevelopment, POSITION_LABEL,
} from '../playerHistory.js'
import { computeLeagueMarketMovers } from '../marketValueHistory.js'

const MARKET_MOVERS_WINDOW_DAYS = 14

const posLabel = { G: 'G', D: 'D', F: 'F' }
const MIN_GP_OPTIONS = [0, 5, 10, 20]

function normalizeSearch(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export default function PlayerRankings() {
  const { data, derived } = useData()
  const playerHistoryData = usePlayerHistory()
  const baselines = usePositionBaselines()
  const [mode, setMode] = useState('skater') // skater | goalie
  const [teamFilter, setTeamFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [minGp, setMinGp] = useState(5) // Abschnitt 6: Mindestspiele gegen Kleinstichproben-Verzerrung
  const [compareOpen, setCompareOpen] = useState(false)
  const [compareA, setCompareA] = useState('')
  const [compareB, setCompareB] = useState('')

  const currentSeasonLabel = data.settings?.seasonName?.match(/\d{4}\/\d{2}/)?.[0] || null
  const statById = useMemo(() => Object.fromEntries(derived.playerStats.map((s) => [s.player.id, s])), [derived.playerStats])

  // Breakout/Decline: rein aus der Trend-Klassifikation (src/playerHistory.js
  // ::classifyTrend) abgeleitet, keine subjektive Bewertung. Bezieht seit dem
  // Player Tracker auch die LAUFENDE Saison 2026/27 mit ein (via
  // buildCurrentSeasonRecord aus bereits abgeschlossenen Spielen - kein
  // Leakage), damit ein aktueller Breakout/Decline erkannt wird, sobald genug
  // Spiele dieser Saison vorliegen (siehe TREND_MIN_LATEST_GP dort). Nur
  // Spieler mit insgesamt >=3 gespielten Saisons werden klassifiziert - ein
  // Rookie ohne Historie taucht hier nie auf.
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

  // Top-Steiger/Top-Faller nach Marktwert-Trend (NL-API liefert nur Richtung
  // -1/0/1, keine Delta-Höhe - daher innerhalb von steigend/fallend nach
  // aktuellem Marktwert sortiert statt eine nicht vorhandene Veränderungs-
  // Höhe zu erfinden).
  const { mvRisers, mvFallers } = useMemo(() => {
    const teamMap2 = Object.fromEntries(data.teams.map((t) => [t.id, t]))
    const withMv = data.players.filter((p) => p.marketValue != null && p.marketValueTrend != null)
    const build = (trend) => withMv
      .filter((p) => p.marketValueTrend === trend)
      .sort((a, b) => b.marketValue - a.marketValue)
      .slice(0, 5)
      .map((p) => ({ player: p, team: teamMap2[p.teamId] }))
    return { mvRisers: build(1), mvFallers: build(-1) }
  }, [data.players, data.teams])
  const hasMarketValues = mvRisers.length > 0 || mvFallers.length > 0

  // Grösste Steiger/Faller nach TATSÄCHLICHER Marktwert-Veränderung der
  // letzten N Tage (player.marketValueHistory, server/sync.js) - im
  // Unterschied zu mvRisers/mvFallers oben (nur Richtung, sortiert nach
  // aktuellem Wert) hier die echte CHF-Differenz. Erst sinnvoll, sobald
  // genug Spieler eine auswertbare Zeitspanne haben (computeLeagueMarketMovers
  // meldet das ehrlich über `ready`).
  const leagueMovers = useMemo(
    () => computeLeagueMarketMovers(data.players, MARKET_MOVERS_WINDOW_DAYS),
    [data.players]
  )

  const teamMap = Object.fromEntries(data.teams.map((t) => [t.id, t]))
  let rows = derived.playerStats.filter((p) => p.gp > 0)
  if (teamFilter !== 'all') rows = rows.filter((p) => p.player.teamId === teamFilter)

  const isGoalie = (p) => p.player.position === 'G'
  rows = rows.filter((p) => (mode === 'goalie' ? isGoalie(p) : !isGoalie(p)))
  // Mindestspiele-Filter (Abschnitt 6): verhindert, dass Spieler mit sehr
  // wenigen Einsätzen die Top-Ranglisten (P/GP, Impact, Veränderung) dominieren.
  if (minGp > 0) rows = rows.filter((p) => p.gp >= minGp)

  // Performante Client-Suche: bei ~409 Spielern ist ein einfacher, per Query
  // memoizierter Substring-Filter über Name+Team völlig ausreichend, keine
  // zusätzliche Indexstruktur nötig. Akzent-unempfindlich (z.B. "Ambri" muss
  // "HC Ambrì-Piotta" treffen, "Gotteron" muss "Fribourg-Gottéron" treffen).
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
  // vorsortiert, damit die Rang-Spalte eine stabile, nachvollziehbare
  // Kaderrangliste zeigt (SortableTable sortiert die ANZEIGE unabhängig
  // davon per Spaltenklick weiter).
  const ranked = useMemo(() => {
    const arr = [...filtered].sort((a, b) =>
      mode === 'goalie' ? (b.savePct ?? -1) - (a.savePct ?? -1) : b.points - a.points || b.goals - a.goals
    )
    // Impact Score einmal pro Zeile vorberechnet (nicht in jedem
    // Sort/Render-Durchlauf neu, siehe Performance-Vorgabe) - '–' falls
    // Baselines/Historie noch nicht geladen oder zu wenig Karrieredaten.
    return arr.map((r, i) => ({
      ...r, rank: i + 1,
      impact: (mode === 'skater' && baselines && playerHistoryData)
        ? computeImpactScore(getPlayerSeasons(playerHistoryData, r.player.id), POSITION_LABEL[r.player.position], baselines)
        : null,
    }))
  }, [filtered, mode, baselines, playerHistoryData])

  const nameCell = (r) => (
    <span className="row gap-sm">
      <Link to={`/players/${r.player.id}`}>{r.player.name}</Link>
      {r.player.number != null && r.player.number !== '' && <span className="muted">#{r.player.number}</span>}
    </span>
  )
  const teamCell = (r) => <TeamBadge team={teamMap[r.player.teamId]} short />
  const posCell = (r) => <span className="chip">{posLabel[r.player.position] || r.player.position}{r.player.positionDetail ? ` · ${r.player.positionDetail}` : ''}</span>

  // Marktwert (NL-API, server/sync.js): eigene Spalte für beide Modi, sortierbar.
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
    { key: 'plusMinus', label: '+/–', num: true, value: (r) => r.plusMinus,
      render: (r) => <span style={{ color: r.plusMinus > 0 ? 'var(--good)' : r.plusMinus < 0 ? 'var(--bad)' : 'inherit' }}>{plusMinusStr(r.plusMinus)}</span> },
    { key: 'pim', label: 'SM', num: true },
    { key: 'impact', label: 'Impact', num: true, title: 'Positions-relatives Karriere-Perzentil (0-100)',
      value: (r) => r.impact?.score ?? -1, render: (r) => r.impact ? r.impact.score.toFixed(1) : <span className="muted">–</span> },
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
    marketValueCol,
  ]

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Spieler-Ranking</h1>
          <div className="sub">Sortierbar per Klick auf die Spaltenköpfe · {ranked.length} {mode === 'goalie' ? 'Torhüter' : 'Feldspieler'}</div>
        </div>
        <div className="row gap-sm wrap">
          <input
            type="text" placeholder="Spieler oder Team suchen…" value={query}
            onChange={(e) => setQuery(e.target.value)} style={{ width: 220 }}
          />
          <div className="pill-tabs">
            <button className={mode === 'skater' ? 'active' : ''} onClick={() => setMode('skater')}>Feldspieler</button>
            <button className={mode === 'goalie' ? 'active' : ''} onClick={() => setMode('goalie')}>Torhüter</button>
          </div>
          <select style={{ width: 'auto' }} value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
            <option value="all">Alle Teams</option>
            {data.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select style={{ width: 'auto' }} value={minGp} onChange={(e) => setMinGp(Number(e.target.value))} title="Mindestanzahl Spiele">
            {MIN_GP_OPTIONS.map((n) => <option key={n} value={n}>{n === 0 ? 'Alle Spiele' : `≥ ${n} Spiele`}</option>)}
          </select>
          <button className="btn ghost sm" onClick={() => setCompareOpen((o) => !o)}>{compareOpen ? 'Vergleich schliessen' : 'Spieler vergleichen'}</button>
        </div>
      </div>

      {compareOpen && (
        <PlayerCompare
          data={data} statById={statById} playerHistoryData={playerHistoryData} baselines={baselines}
          currentSeasonLabel={currentSeasonLabel}
          a={compareA} b={compareB} setA={setCompareA} setB={setCompareB}
        />
      )}

      {(breakouts.length > 0 || declines.length > 0) && (
        <div className="grid grid-2 mb" style={{ gap: 14 }}>
          <BreakoutTable title="Breakout Candidates" entries={breakouts} tone="good" />
          <BreakoutTable title="Declining Players" entries={declines} tone="bad" />
        </div>
      )}

      {hasMarketValues && (
        <div className="grid grid-2 mb" style={{ gap: 14 }}>
          <MarketValueMoversTable title="Top-Steiger (Marktwert)" entries={mvRisers} tone="good" />
          <MarketValueMoversTable title="Top-Faller (Marktwert)" entries={mvFallers} tone="bad" />
        </div>
      )}

      {/* Grösste Steiger/Faller nach echter Marktwert-Veränderung (letzte N
          Tage, aus dem seit server/sync.js gesammelten Verlauf) - getrennt
          von den obigen, richtungsbasierten Karten. */}
      {leagueMovers.ready ? (
        <div className="grid grid-2 mb" style={{ gap: 14 }}>
          <MarketValueChangeTable title={`Grösste Steiger (${MARKET_MOVERS_WINDOW_DAYS} Tage)`} entries={leagueMovers.risers} tone="good" teamMap={teamMap} />
          <MarketValueChangeTable title={`Grösste Faller (${MARKET_MOVERS_WINDOW_DAYS} Tage)`} entries={leagueMovers.fallers} tone="bad" teamMap={teamMap} />
        </div>
      ) : (
        <div className="card card-pad mb muted" style={{ fontSize: 12.5 }}>
          Grösste Steiger/Faller ({MARKET_MOVERS_WINDOW_DAYS} Tage): sammelt Verlaufsdaten – aussagekräftig, sobald mehr Spieler eine
          auswertbare Zeitspanne haben ({leagueMovers.count}/{leagueMovers.minPlayers}).
        </div>
      )}

      {ranked.length === 0 ? (
        <div className="empty">
          <div className="title">{query ? 'Keine Treffer' : 'Noch keine Werte'}</div>
          <div className="hint">{query ? 'Andere Suche versuchen.' : 'Erfasse Spiele mit Spieler-Stats, dann erscheinen hier die Ranglisten.'}</div>
        </div>
      ) : (
        <div className="card">
          <SortableTable
            columns={mode === 'goalie' ? goalieCols : skaterCols}
            rows={ranked}
            initialSort={mode === 'goalie' ? 'savePct' : 'points'}
            initialDir="desc"
            rowKey={(r) => r.player.id}
          />
        </div>
      )}
    </>
  )
}

function fmt2(v) { return v == null ? '–' : v.toFixed(2) }
function fmtSec(v) {
  if (v == null) return '–'
  const m = Math.floor(v / 60), s = Math.round(v % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// Spieler-Vergleich (Abschnitt 7) - bewusst als kompakter, ausklappbarer
// Bereich auf /players statt einer eigenen Route/Seite: die benötigten Daten
// (aktuelle Saison, Historie, Impact Score) sind hier bereits geladen, eine
// separate Seite würde nur Duplikation bedeuten. Nur Feldspieler (Impact
// Score/SOG/TOI sind für Torhüter nicht definiert, siehe playerHistory.js).
function PlayerCompare({ data, statById, playerHistoryData, baselines, currentSeasonLabel, a, b, setA, setB }) {
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
    const current = buildCurrentSeasonRecord(stat, player, currentSeasonLabel)
    const career = careerSummary(seasons)
    const impact = baselines ? computeImpactScore(seasons, POSITION_LABEL[player.position], baselines) : null
    const yoy = yoyDevelopment(current ? [...seasons, current] : seasons)
    return { player, team: teamMap[player.teamId], stat, career, impact, yoy, ageGroup: playerHistoryData?.players?.[playerId]?.ageGroup ?? null }
  }
  const A = a ? build(a) : null
  const B = b ? build(b) : null

  return (
    <div className="card card-pad mb">
      <h2 className="mb">Spieler vergleichen</h2>
      <div className="form-row mb">
        <div>
          <label className="field">Spieler A</label>
          <select value={a} onChange={(e) => setA(e.target.value)}>
            <option value="">– wählen –</option>
            {skaters.map((p) => <option key={p.id} value={p.id} disabled={p.id === b}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="field">Spieler B</label>
          <select value={b} onChange={(e) => setB(e.target.value)}>
            <option value="">– wählen –</option>
            {skaters.map((p) => <option key={p.id} value={p.id} disabled={p.id === a}>{p.name}</option>)}
          </select>
        </div>
      </div>

      {A && B && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="left">Kennzahl</th>
                <th className="num">{A.player.name}</th>
                <th className="num">{B.player.name}</th>
              </tr>
            </thead>
            <tbody>
              <CompareRow label="Team" v1={A.team?.short} v2={B.team?.short} fmt={(v) => v ?? '–'} />
              <CompareRow label="Position" v1={POSITION_LABEL[A.player.position]} v2={POSITION_LABEL[B.player.position]} fmt={(v) => v ?? '–'} />
              <CompareRow label="Geburtsjahr" v1={A.ageGroup} v2={B.ageGroup} neutral fmt={(v) => v ?? '–'} />
              <CompareRow label={`GP (${currentSeasonLabel || 'Saison'})`} v1={A.stat?.gp ?? 0} v2={B.stat?.gp ?? 0} fmt={(v) => v} />
              <CompareRow label="Tore" v1={A.stat?.goals ?? 0} v2={B.stat?.goals ?? 0} fmt={(v) => v} />
              <CompareRow label="Assists" v1={A.stat?.assists ?? 0} v2={B.stat?.assists ?? 0} fmt={(v) => v} />
              <CompareRow label="Punkte" v1={A.stat?.points ?? 0} v2={B.stat?.points ?? 0} fmt={(v) => v} />
              <CompareRow label="P/GP (Saison)" v1={A.stat?.gp > 0 ? A.stat.points / A.stat.gp : null} v2={B.stat?.gp > 0 ? B.stat.points / B.stat.gp : null} fmt={fmt2} />
              <CompareRow label="SOG/GP" v1={A.stat?.sogpg} v2={B.stat?.sogpg} fmt={fmt2} />
              <CompareRow label="TOI/GP" v1={A.stat?.toipg} v2={B.stat?.toipg} fmt={fmtSec} />
              <CompareRow label="+/–" v1={A.stat?.plusMinus ?? 0} v2={B.stat?.plusMinus ?? 0} fmt={plusMinusStr} />
              <CompareRow label="Impact Score (Karriere)" v1={A.impact?.score} v2={B.impact?.score} fmt={(v) => v.toFixed(1)} />
              <CompareRow label="Karriere P/GP" v1={A.career?.careerPpg} v2={B.career?.careerPpg} fmt={fmt2} />
              <CompareRow
                label="Saison vs. Vorjahr"
                v1={A.yoy?.pctChange} v2={B.yoy?.pctChange}
                fmt={(v) => (v >= 0 ? '+' : '') + v.toFixed(0) + '%'}
              />
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Vergleichszeile mit dezenter Hervorhebung des besseren Werts - identisches
// Muster wie CompareRow in src/pages/MatchupDetail.jsx (Teamvergleich).
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

// Kompakte Breakout-/Decline-Tabelle - Spieler/Team/P-GP/Ø davor/Veränderung/
// Impact Score, rein aus classifyTrend() abgeleitet (siehe playerHistory.js).
function BreakoutTable({ title, entries, tone }) {
  return (
    <div className="card">
      <div className="card-pad" style={{ paddingBottom: 6 }}><div className="section-label" style={{ margin: 0 }}>{title}</div></div>
      {entries.length === 0 ? (
        <div className="card-pad muted" style={{ fontSize: 12.5, paddingTop: 0 }}>Keine {tone === 'good' ? 'Kandidaten' : 'Auffälligkeiten'}.</div>
      ) : (
        <div className="table-wrap" style={{ border: 'none' }}>
          <table>
            <thead>
              <tr>
                <th className="left">Spieler</th><th className="left">Team</th>
                <th className="num">P/GP</th><th className="num">Ø davor</th>
                <th className="num">Veränd.</th><th className="num">Impact</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(({ player, team, trend, impact }) => (
                <tr key={player.id}>
                  <td className="left"><Link to={`/players/${player.id}`}>{player.name}</Link></td>
                  <td className="left">{team ? <TeamBadge team={team} short /> : <span className="muted">–</span>}</td>
                  <td className="num">{trend.latestPpg.toFixed(2)}</td>
                  <td className="num muted">{trend.careerPpgExclLatest.toFixed(2)}</td>
                  <td className="num"><strong className={tone}>{trend.ratio >= 1 ? '+' : ''}{Math.round((trend.ratio - 1) * 100)}%</strong></td>
                  <td className="num">{impact ? impact.score.toFixed(1) : <span className="muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Grösste Steiger/Faller nach der ECHTEN Marktwert-Veränderung über das
// gewählte Zeitfenster (player.marketValueHistory, server/sync.js) - im
// Unterschied zu MarketValueMoversTable oben mit tatsächlicher CHF-/%-Höhe,
// nicht nur Richtung.
function MarketValueChangeTable({ title, entries, tone }) {
  return (
    <div className="card">
      <div className="card-pad" style={{ paddingBottom: 6 }}><div className="section-label" style={{ margin: 0 }}>{title}</div></div>
      {entries.length === 0 ? (
        <div className="card-pad muted" style={{ fontSize: 12.5, paddingTop: 0 }}>Keine {tone === 'good' ? 'Steiger' : 'Faller'} in diesem Zeitraum.</div>
      ) : (
        <div className="table-wrap" style={{ border: 'none' }}>
          <table>
            <thead>
              <tr><th className="left">Spieler</th><th className="left">Team</th><th className="num">Marktwert</th><th className="num">Veränderung</th></tr>
            </thead>
            <tbody>
              {entries.map(({ player, delta, deltaPct, latest }) => (
                <tr key={player.id}>
                  <td className="left"><Link to={`/players/${player.id}`}>{player.name}</Link></td>
                  <td className="left">{player.teamId ? <TeamBadge team={{ id: player.teamId }} short /> : <span className="muted">–</span>}</td>
                  <td className="num">{fmtChf(latest.marketValue)}</td>
                  <td className="num">
                    <strong className={tone}>
                      {delta >= 0 ? '+' : ''}{fmtChf(delta)}
                      {deltaPct != null && <span className="muted" style={{ fontWeight: 600 }}> ({deltaPct >= 0 ? '+' : ''}{(deltaPct * 100).toFixed(1)}%)</span>}
                    </strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Top-Steiger/-Faller nach Marktwert-Trend (marketValueTrend, NL-API) - die
// API liefert nur die Richtung, keine Delta-Höhe, daher innerhalb von
// steigend/fallend nach aktuellem Marktwert sortiert (siehe PlayerRankings
// oben) statt eine nicht vorhandene Veränderungs-Höhe zu erfinden.
function MarketValueMoversTable({ title, entries, tone }) {
  return (
    <div className="card">
      <div className="card-pad" style={{ paddingBottom: 6 }}><div className="section-label" style={{ margin: 0 }}>{title}</div></div>
      {entries.length === 0 ? (
        <div className="card-pad muted" style={{ fontSize: 12.5, paddingTop: 0 }}>Keine {tone === 'good' ? 'Steiger' : 'Faller'}.</div>
      ) : (
        <div className="table-wrap" style={{ border: 'none' }}>
          <table>
            <thead>
              <tr><th className="left">Spieler</th><th className="left">Team</th><th className="num">Marktwert</th></tr>
            </thead>
            <tbody>
              {entries.map(({ player, team }) => (
                <tr key={player.id}>
                  <td className="left"><Link to={`/players/${player.id}`}>{player.name}</Link></td>
                  <td className="left">{team ? <TeamBadge team={team} short /> : <span className="muted">–</span>}</td>
                  <td className="num">
                    <span className="row gap-sm" style={{ justifyContent: 'flex-end' }}>
                      <strong className={tone}>{fmtChf(player.marketValue)}</strong>
                      <MarketValueTrend trend={player.marketValueTrend} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
