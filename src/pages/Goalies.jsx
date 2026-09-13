import { useState, useMemo } from 'react'
import { useData } from '../DataContext.jsx'
import { fmtPct, fmtNum } from '../stats.js'

export default function Goalies() {
  const { data, derived } = useData()
  const [filterTeam, setFilterTeam] = useState('')
  const [sortBy, setSortBy] = useState('gp')
  const [sortDesc, setSortDesc] = useState(true)

  // Aus der konsolidierten Quelle (src/stats.js::computePlayerStats) - dieselben
  // Saison-Totale (bevorzugt NL-API, sonst Boxscore) wie Spieler-Ranking/
  // Dashboard/Spieler-Detail, keine eigene, abweichende Aggregation mehr.
  const goalies = useMemo(() => {
    if (!derived?.playerStats) return []
    return derived.playerStats
      .filter((s) => s.player.position === 'G' && s.gp > 0)
      .map((s) => ({ ...s, team: data.teams.find((t) => t.id === s.player.teamId) }))
      .filter((g) => !filterTeam || g.team?.id === filterTeam)
  }, [derived, data.teams, filterTeam])

  const sorted = useMemo(() => {
    const key = sortBy
    return [...goalies].sort((a, b) => {
      let aVal = key === 'svPct' ? (a.savePct ?? -1) : a[key]
      let bVal = key === 'svPct' ? (b.savePct ?? -1) : b[key]
      const cmp = aVal > bVal ? 1 : aVal < bVal ? -1 : 0
      return sortDesc ? -cmp : cmp
    })
  }, [goalies, sortBy, sortDesc])

  const handleSort = (col) => {
    if (sortBy === col) {
      setSortDesc(!sortDesc)
    } else {
      setSortBy(col)
      setSortDesc(true)
    }
  }

  const teams = data?.teams || []
  const teamsByGoalie = new Set(goalies.map((g) => g.team?.id).filter(Boolean))

  const sortInd = (col) => (sortBy === col ? (sortDesc ? '▼' : '▲') : '')

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Torhüter</h1>
        </div>
        <select style={{ width: 'auto' }} value={filterTeam} onChange={(e) => setFilterTeam(e.target.value)}>
          <option value="">Alle Teams ({sorted.length})</option>
          {teams
            .filter((t) => teamsByGoalie.has(t.id))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({goalies.filter((g) => g.team?.id === t.id).length})
              </option>
            ))}
        </select>
      </div>

      {sorted.length === 0 ? (
        <div className="empty">
          <div className="title">Keine Torhüter-Statistiken verfügbar</div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="left">Torhüter</th>
                  <th className="num sortable" onClick={() => handleSort('gp')}>SP <span className="sort-ind">{sortInd('gp')}</span></th>
                  <th className="num sortable" onClick={() => handleSort('wins')}>S <span className="sort-ind">{sortInd('wins')}</span></th>
                  <th className="num sortable" onClick={() => handleSort('losses')}>N <span className="sort-ind">{sortInd('losses')}</span></th>
                  <th className="num sortable" onClick={() => handleSort('svPct')}>SV% <span className="sort-ind">{sortInd('svPct')}</span></th>
                  <th className="num sortable" onClick={() => handleSort('gaa')}>GTS <span className="sort-ind">{sortInd('gaa')}</span></th>
                  <th className="num sortable" onClick={() => handleSort('shutouts')}>SO <span className="sort-ind">{sortInd('shutouts')}</span></th>
                  <th className="num sortable" onClick={() => handleSort('saves')}>Paraden <span className="sort-ind">{sortInd('saves')}</span></th>
                  <th className="num sortable" onClick={() => handleSort('goalsAgainst')}>GA <span className="sort-ind">{sortInd('goalsAgainst')}</span></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((g) => (
                  <tr key={g.player.id}>
                    <td className="left">
                      <span className="row gap-sm">
                        {g.team && <span className="dot" style={{ background: g.team.color }} />}
                        <span>
                          {g.player.name}
                          {g.team && <span className="muted" style={{ marginLeft: 6, fontSize: 11.5 }}>{g.team.short}</span>}
                        </span>
                      </span>
                    </td>
                    <td className="num">{g.gp}</td>
                    <td className="num">{g.wins}</td>
                    <td className="num">{g.losses}</td>
                    <td className="num"><strong>{fmtPct(g.savePct)}</strong></td>
                    <td className="num">{fmtNum(g.gaa, 2)}</td>
                    <td className="num">{g.shutouts}</td>
                    <td className="num">{g.saves}</td>
                    <td className="num">{g.goalsAgainst}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}
