// ---------------------------------------------------------------------------
// Fantasy-Rangliste (/fantasy) - angenäherter Topscorers-Score, siehe
// src/fantasyScore.js. Liest ausschliesslich derived.playerStats (dieselbe
// konsolidierte Quelle wie /players, /goalies, Spieler-Detailseite) - keine
// eigene Aggregation, kein Eingriff in ELO/Prognose.
//
// VALUE-ANALYSE (Fantasy-Punkte vs. Marktwert): Torhüter-Fantasy-Punkte sind
// durch die Paraden-Gewichtung (x4) um ein Vielfaches höher als bei
// Feldspielern - ein positionsübergreifendes "Value"-Ranking würde deshalb
// nur aus Torhütern bestehen. Bargains/Überbewertet-Listen UND die
// Trendlinien werden daher konsequent GETRENNT je Position (F/D/G)
// berechnet (siehe byPosition unten).
// ---------------------------------------------------------------------------

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge, SortableTable } from '../components/ui.jsx'
import {
  computeFantasyScores, FANTASY_CATEGORIES_CONSIDERED, FANTASY_CATEGORIES_OMITTED,
  pointsPerMillionChf, fitValueTrendLine,
} from '../fantasyScore.js'
import { fmtChf } from '../stats.js'

const posLabel = { G: 'G', D: 'D', F: 'F' }
const POSITION_ORDER = ['F', 'D', 'G']
const POSITION_FULL_LABEL = { F: 'Stürmer', D: 'Verteidiger', G: 'Torhüter' }
// Kategorische Positionsfarben - dataviz-Skill: erste 3 Slots der Standard-
// palette (blau/orange/aqua), all-pairs-validiert (node
// scripts/validate_palette.js "#2a78d6,#eb6834,#1baf7a" --mode light --pairs
// all -> PASS, CVD-Mindestabstand 9.2, Normalsicht 24.0). Aqua liegt unter
// 3:1 Kontrast zur hellen Fläche -> Relief-Pflicht erfüllt durch sichtbare
// Legendenbeschriftung + die bestehende Ranglisten-Tabelle als Alternative.
const POSITION_COLOR = { F: '#2a78d6', D: '#eb6834', G: '#1baf7a' }

const MIN_GP_OPTIONS = [5, 10, 15, 20]

function normalizeSearch(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export default function Fantasy() {
  const { data, derived } = useData()
  const [mode, setMode] = useState('skater') // skater | goalie - wie /players, damit Torhüter die Default-Ansicht nicht überschwemmen
  const [teamFilter, setTeamFilter] = useState('all')
  const [posFilter, setPosFilter] = useState('all') // nur im skater-Modus relevant (Stürmer/Verteidiger)
  const [query, setQuery] = useState('')
  const [showLegend, setShowLegend] = useState(false)
  const [minGp, setMinGp] = useState(5)

  const teamMap = useMemo(() => Object.fromEntries(data.teams.map((t) => [t.id, t])), [data.teams])
  const scored = useMemo(() => computeFantasyScores(derived.playerStats), [derived.playerStats])

  // --- Hauptliste ---
  const isGoalieRow = (r) => r.player.position === 'G'
  let rows = scored.filter((r) => r.fantasy && r.gp >= minGp)
  rows = rows.filter((r) => (mode === 'goalie' ? isGoalieRow(r) : !isGoalieRow(r)))
  if (mode === 'skater' && posFilter !== 'all') rows = rows.filter((r) => r.player.position === posFilter)
  if (teamFilter !== 'all') rows = rows.filter((r) => r.player.teamId === teamFilter)

  const filtered = useMemo(() => {
    const q = normalizeSearch(query)
    if (!q) return rows
    return rows.filter((r) => {
      const teamName = normalizeSearch(teamMap[r.player.teamId]?.name)
      const teamShort = normalizeSearch(teamMap[r.player.teamId]?.short)
      return normalizeSearch(r.player.name).includes(q) || teamName.includes(q) || teamShort.includes(q)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, query, teamMap])

  const ranked = useMemo(() => {
    const arr = [...filtered].sort((a, b) => b.fantasy.total - a.fantasy.total)
    return arr.map((r, i) => ({ ...r, rank: i + 1 }))
  }, [filtered])

  // --- Value-Analyse: je Position (F/D/G) getrennt, unabhängig von den
  // Team-/Positions-/Suchfiltern der Hauptliste oben (die Value-Analyse
  // betrachtet immer die ganze Liga je Position) - nur der gemeinsame
  // Mindest-Spiele-Filter gilt überall. ---
  const byPosition = useMemo(() => {
    const out = {}
    for (const pos of POSITION_ORDER) {
      const pool = scored.filter((r) => r.fantasy && r.gp >= minGp && r.player.position === pos && r.player.marketValue != null)
      const trendLine = fitValueTrendLine(pool.map((r) => ({ x: r.player.marketValue, y: r.fantasy.total })))
      const withValue = pool.map((r) => {
        const pointsPerM = pointsPerMillionChf(r.fantasy.total, r.player.marketValue)
        const predicted = trendLine ? trendLine.predict(r.player.marketValue) : null
        const residual = predicted != null ? r.fantasy.total - predicted : null
        return { ...r, pointsPerM, predicted, residual }
      })
      const bargains = [...withValue].sort((a, b) => (b.residual ?? -Infinity) - (a.residual ?? -Infinity)).slice(0, 5)
      const overvalued = [...withValue].sort((a, b) => (a.residual ?? Infinity) - (b.residual ?? Infinity)).slice(0, 5)
      out[pos] = { pool: withValue, trendLine, bargains, overvalued }
    }
    return out
  }, [scored, minGp])
  const hasAnyValueData = POSITION_ORDER.some((p) => byPosition[p].pool.length >= 2)

  const nameCell = (r) => (
    <span className="row gap-sm">
      <Link to={`/players/${r.player.id}`}>{r.player.name}</Link>
      {r.player.number != null && r.player.number !== '' && <span className="muted">#{r.player.number}</span>}
    </span>
  )
  const teamCell = (r) => <TeamBadge team={teamMap[r.player.teamId]} short />
  const posCell = (r) => <span className="chip">{posLabel[r.player.position] || r.player.position}</span>
  const perMCell = (r) => {
    const v = pointsPerMillionChf(r.fantasy.total, r.player.marketValue)
    return v != null ? Math.round(v).toLocaleString('de-CH') : <span className="muted">–</span>
  }

  const columns = [
    { key: 'rank', label: '#', num: true, noSort: true, render: (r) => <span className="rank">{r.rank}</span> },
    { key: 'name', label: 'Spieler', left: true, noSort: true, render: nameCell },
    { key: 'team', label: 'Team', left: true, noSort: true, render: teamCell },
    ...(mode === 'skater' ? [{ key: 'pos', label: 'Pos.', left: true, noSort: true, render: posCell }] : []),
    { key: 'gp', label: 'GP', num: true, value: (r) => r.gp },
    { key: 'points', label: 'P', num: true, value: (r) => r.points, title: 'Tore + Assists (zur Einordnung)' },
    { key: 'total', label: 'Fantasy-Punkte', num: true, value: (r) => r.fantasy.total, render: (r) => <strong>{Math.round(r.fantasy.total)}</strong> },
    { key: 'perGame', label: 'Pkt/Spiel', num: true, value: (r) => r.fantasy.perGame ?? -1, render: (r) => (r.fantasy.perGame != null ? r.fantasy.perGame.toFixed(1) : '–') },
    { key: 'perM', label: 'Pkt/Mio CHF', num: true, title: 'Fantasy-Punkte pro 1 Mio CHF Marktwert', value: (r) => pointsPerMillionChf(r.fantasy.total, r.player.marketValue) ?? -1, render: perMCell },
  ]

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Fantasy</h1>
          <div className="sub">Angenäherter Topscorers-Score · Sortierbar per Klick auf die Spaltenköpfe · {ranked.length} {mode === 'goalie' ? 'Torhüter' : 'Feldspieler'}</div>
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
          {mode === 'skater' && (
            <select style={{ width: 'auto' }} value={posFilter} onChange={(e) => setPosFilter(e.target.value)}>
              <option value="all">Alle Feldspieler</option>
              <option value="F">Stürmer</option>
              <option value="D">Verteidiger</option>
            </select>
          )}
          <select style={{ width: 'auto' }} value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
            <option value="all">Alle Teams</option>
            {data.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select style={{ width: 'auto' }} value={minGp} onChange={(e) => setMinGp(Number(e.target.value))} title="Mindestanzahl Spiele">
            {MIN_GP_OPTIONS.map((n) => <option key={n} value={n}>≥ {n} Spiele</option>)}
          </select>
          <button className="btn ghost sm" onClick={() => setShowLegend((o) => !o)}>{showLegend ? 'Kategorien ausblenden' : 'Kategorien anzeigen'}</button>
        </div>
      </div>

      {showLegend && (
        <div className="grid grid-2 mb" style={{ gap: 14 }}>
          <div className="card card-pad">
            <div className="section-label">Berücksichtigt</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7 }}>
              {FANTASY_CATEGORIES_CONSIDERED.map((c) => (
                <li key={c.key}><strong>{c.label}</strong> <span className="muted">– {c.detail}</span></li>
              ))}
            </ul>
          </div>
          <div className="card card-pad">
            <div className="section-label">Nicht berücksichtigt (keine Daten)</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7 }}>
              {FANTASY_CATEGORIES_OMITTED.map((c) => (
                <li key={c.key}><strong>{c.label}</strong> <span className="muted">– {c.reason}</span></li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {ranked.length === 0 ? (
        <div className="empty">
          <div className="title">{query ? 'Keine Treffer' : 'Noch keine Werte'}</div>
          <div className="hint">{query ? 'Andere Suche versuchen.' : 'Sobald Spieler Saison-Stats haben, erscheint hier die Fantasy-Rangliste.'}</div>
        </div>
      ) : (
        <div className="card mb">
          <SortableTable columns={columns} rows={ranked} initialSort="total" initialDir="desc" rowKey={(r) => r.player.id} />
        </div>
      )}

      {/* Value-Analyse */}
      {hasAnyValueData && (
        <>
          <div className="page-head" style={{ marginTop: 22 }}>
            <div>
              <h2 style={{ margin: 0 }}>Value-Analyse: Fantasy-Punkte vs. Marktwert</h2>
              <div className="sub">Je Position getrennt (Torhüter-Punkte sind durch die Paraden-Gewichtung um ein Vielfaches höher) · ≥ {minGp} Spiele</div>
            </div>
          </div>

          <ValueScatter byPosition={byPosition} />

          {POSITION_ORDER.map((pos) => {
            const d = byPosition[pos]
            if (d.pool.length < 2) return null
            return (
              <div key={pos} className="mb">
                <div className="section-label" style={{ marginBottom: 8 }}>{POSITION_FULL_LABEL[pos]}</div>
                <div className="grid grid-2" style={{ gap: 14 }}>
                  <ValueTable title={`Schnäppchen (${POSITION_FULL_LABEL[pos]})`} entries={d.bargains} tone="good" teamMap={teamMap} />
                  <ValueTable title={`Überbewertet (${POSITION_FULL_LABEL[pos]})`} entries={d.overvalued} tone="bad" teamMap={teamMap} />
                </div>
              </div>
            )
          })}
        </>
      )}

      <div className="muted mt" style={{ fontSize: 11.5 }}>
        Angenäherter Topscorers-Score – siehe „Kategorien anzeigen" für berücksichtigte/fehlende Kategorien. Werte in src/fantasyScore.js konfigurierbar.
        Value-Kennzahlen basieren auf einer einfachen linearen Trendlinie (Fantasy-Punkte ~ Marktwert) je Position, kein Prognosemodell.
      </div>
    </>
  )
}

// Schnäppchen-/Überbewertet-Tabelle - identisches Muster wie
// BreakoutTable/MarketValueMoversTable in src/pages/PlayerRankings.jsx.
function ValueTable({ title, entries, tone, teamMap }) {
  return (
    <div className="card">
      <div className="card-pad" style={{ paddingBottom: 6 }}><div className="section-label" style={{ margin: 0 }}>{title}</div></div>
      {entries.length === 0 ? (
        <div className="card-pad muted" style={{ fontSize: 12.5, paddingTop: 0 }}>Keine Daten.</div>
      ) : (
        <div className="table-wrap" style={{ border: 'none' }}>
          <table>
            <thead>
              <tr><th className="left">Spieler</th><th className="left">Team</th><th className="num">Marktwert</th><th className="num">Fantasy-Pkt</th><th className="num">vs. erwartet</th></tr>
            </thead>
            <tbody>
              {entries.map((r) => (
                <tr key={r.player.id}>
                  <td className="left"><Link to={`/players/${r.player.id}`}>{r.player.name}</Link></td>
                  <td className="left"><TeamBadge team={teamMap[r.player.teamId]} short /></td>
                  <td className="num">{fmtChf(r.player.marketValue)}</td>
                  <td className="num"><strong>{Math.round(r.fantasy.total)}</strong></td>
                  <td className="num">
                    <strong className={r.residual > 0 ? tone : tone === 'good' ? 'bad' : 'good'}>
                      {r.residual == null ? '–' : (r.residual >= 0 ? '+' : '') + Math.round(r.residual)}
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

// Scatter Marktwert (x) vs. Fantasy-Punkte (y), eingefärbt nach Position, mit
// je Position einer eigenen Trendlinie in derselben Farbe (dieselbe Serie -
// keine 4. Kategorie). Handgebautes SVG nach dem Muster von
// GoalieChart/SkaterChart (src/pages/PlayerDetail.jsx), keine Chart-Bibliothek.
function ValueScatter({ byPosition }) {
  const W = 640, H = 380, pad = { l: 56, r: 16, t: 16, b: 40 }
  const allPoints = POSITION_ORDER.flatMap((pos) => byPosition[pos].pool.map((r) => ({ ...r, pos })))
  if (allPoints.length === 0) return null

  const maxX = Math.max(...allPoints.map((p) => p.player.marketValue)) * 1.05
  const minY = Math.min(0, ...allPoints.map((p) => p.fantasy.total))
  const maxY = Math.max(...allPoints.map((p) => p.fantasy.total)) * 1.05
  const x = (v) => pad.l + (v / maxX) * (W - pad.l - pad.r)
  const y = (v) => H - pad.b - ((v - minY) / (maxY - minY || 1)) * (H - pad.t - pad.b)

  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxX)
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => minY + f * (maxY - minY))

  return (
    <div className="card card-pad mb">
      <div style={{ overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 480, maxWidth: 720 }}>
          {yTicks.map((v) => (
            <g key={'y' + v}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="0.5" />
              <text x={pad.l - 8} y={y(v) + 3} fontSize="9" fill="var(--text-dim)" textAnchor="end">{Math.round(v)}</text>
            </g>
          ))}
          {xTicks.map((v) => (
            <g key={'x' + v}>
              <text x={x(v)} y={H - pad.b + 16} fontSize="9" fill="var(--text-dim)" textAnchor="middle">{(v / 1000).toFixed(0)}k</text>
            </g>
          ))}
          <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--border-strong)" />
          <line x1={pad.l} x2={pad.l} y1={pad.t} y2={H - pad.b} stroke="var(--border-strong)" />
          <text x={(pad.l + W - pad.r) / 2} y={H - 4} fontSize="10" fill="var(--text-dim)" textAnchor="middle">Marktwert (CHF)</text>
          <text x={14} y={(pad.t + H - pad.b) / 2} fontSize="10" fill="var(--text-dim)" textAnchor="middle" transform={`rotate(-90 14 ${(pad.t + H - pad.b) / 2})`}>Fantasy-Punkte</text>

          {/* Trendlinien je Position, gestrichelt, in der jeweiligen Positionsfarbe */}
          {POSITION_ORDER.map((pos) => {
            const d = byPosition[pos]
            if (!d.trendLine || d.pool.length < 2) return null
            const xs = d.pool.map((r) => r.player.marketValue)
            const x0 = Math.min(...xs), x1 = Math.max(...xs)
            return (
              <line
                key={pos}
                x1={x(x0)} y1={y(d.trendLine.predict(x0))}
                x2={x(x1)} y2={y(d.trendLine.predict(x1))}
                stroke={POSITION_COLOR[pos]} strokeWidth="2" strokeDasharray="5 4" opacity="0.85"
              />
            )
          })}

          {/* Punkte */}
          {allPoints.map((p) => (
            <circle
              key={p.player.id} cx={x(p.player.marketValue)} cy={y(p.fantasy.total)} r="4.5"
              fill={POSITION_COLOR[p.pos]} stroke="var(--bg-elev)" strokeWidth="1"
            >
              <title>{`${p.player.name} (${POSITION_FULL_LABEL[p.pos]}) – ${fmtChf(p.player.marketValue)} CHF, ${Math.round(p.fantasy.total)} Fantasy-Pkt`}</title>
            </circle>
          ))}
        </svg>
      </div>
      <div className="row wrap gap-sm mt" style={{ gap: 16, fontSize: 12 }}>
        {POSITION_ORDER.map((pos) => (
          <span key={pos} className="row gap-sm">
            <span className="dot" style={{ background: POSITION_COLOR[pos] }} />
            {POSITION_FULL_LABEL[pos]}
          </span>
        ))}
        <span className="muted">Gestrichelte Linie = Trend je Position · deutlich darüber = Value, deutlich darunter = überbezahlt</span>
      </div>
    </div>
  )
}
