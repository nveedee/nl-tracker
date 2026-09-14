// ---------------------------------------------------------------------------
// Fantasy-Rangliste (/fantasy) - angenäherter Topscorers-Score, siehe
// src/fantasyScore.js. Liest ausschliesslich derived.playerStats (dieselbe
// konsolidierte Quelle wie /players, /goalies, Spieler-Detailseite) - keine
// eigene Aggregation, kein Eingriff in ELO/Prognose.
// ---------------------------------------------------------------------------

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge, SortableTable } from '../components/ui.jsx'
import { computeFantasyScores, FANTASY_CATEGORIES_CONSIDERED, FANTASY_CATEGORIES_OMITTED } from '../fantasyScore.js'

const posLabel = { G: 'G', D: 'D', F: 'F' }

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

  const nameCell = (r) => (
    <span className="row gap-sm">
      <Link to={`/players/${r.player.id}`}>{r.player.name}</Link>
      {r.player.number != null && r.player.number !== '' && <span className="muted">#{r.player.number}</span>}
    </span>
  )
  const teamCell = (r) => <TeamBadge team={teamMap[r.player.teamId]} short />
  const posCell = (r) => <span className="chip">{posLabel[r.player.position] || r.player.position}</span>

  const columns = [
    { key: 'rank', label: '#', num: true, noSort: true, render: (r) => <span className="rank">{r.rank}</span> },
    { key: 'name', label: 'Spieler', left: true, noSort: true, render: nameCell },
    { key: 'team', label: 'Team', left: true, noSort: true, render: teamCell },
    ...(mode === 'skater' ? [{ key: 'pos', label: 'Pos.', left: true, noSort: true, render: posCell }] : []),
    { key: 'gp', label: 'GP', num: true, value: (r) => r.gp },
    { key: 'points', label: 'P', num: true, value: (r) => r.points, title: 'Tore + Assists (zur Einordnung)' },
    { key: 'total', label: 'Fantasy-Punkte', num: true, value: (r) => r.fantasy.total, render: (r) => <strong>{Math.round(r.fantasy.total)}</strong> },
    { key: 'perGame', label: 'Pkt/Spiel', num: true, value: (r) => r.fantasy.perGame ?? -1, render: (r) => (r.fantasy.perGame != null ? r.fantasy.perGame.toFixed(1) : '–') },
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

      <div className="muted mt" style={{ fontSize: 11.5 }}>
        Angenäherter Topscorers-Score – siehe „Kategorien anzeigen" für berücksichtigte/fehlende Kategorien. Werte in src/fantasyScore.js konfigurierbar.
      </div>
    </>
  )
}
