import { useState } from 'react'
import { TeamBadge } from './ui.jsx'

function fmtToi(sec) {
  if (sec == null) return '–'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
function fmtPlusMinus(v) {
  if (v == null) return '–'
  return v > 0 ? `+${v}` : `${v}`
}

const SKATER_COLUMNS = [
  { key: 'points', label: 'Pkt' },
  { key: 'goals', label: 'T' },
  { key: 'assists', label: 'A' },
  { key: 'sog', label: 'SOG' },
  { key: 'toiSec', label: 'TOI' },
  { key: 'plusMinus', label: '+/-' },
]

// Spieler-Boxscore eines Teams für dieses Spiel (Game Center,
// src/gameCenter.js::getSkaterBoxscore/getGoalieBoxscore) - sortierbar nach
// Punkte/Tore/SOG/TOI (clientseitig, keine neue Kennzahl, nur Sortierung
// bereits vorhandener Werte, siehe Auftrag Punkt 4).
export default function PlayerBoxscore({ team, skaters, goalies }) {
  const [sortKey, setSortKey] = useState('points')
  const [sortDir, setSortDir] = useState('desc')

  const hasData = (skaters && skaters.length > 0) || (goalies && goalies.length > 0)

  const sortedSkaters = [...(skaters || [])].sort((a, b) => {
    const va = a[sortKey] ?? -Infinity
    const vb = b[sortKey] ?? -Infinity
    return sortDir === 'desc' ? vb - va : va - vb
  })

  function toggleSort(key) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  return (
    <div style={{ minWidth: 0 }}>
      <div className="row gap-sm" style={{ marginBottom: 8 }}><TeamBadge team={team} link={false} /></div>
      {!hasData ? (
        <div className="muted" style={{ fontSize: 13 }}>Keine Spielerstatistiken für dieses Team erfasst.</div>
      ) : (
        <>
          {skaters.length > 0 && skaters.every((s) => s.points == null) && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Tore/Assists für dieses Spiel unvollständig – nicht verfügbar.</div>
          )}
          {skaters.length > 0 && (
            <div className="table-wrap" style={{ marginBottom: 10, overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th className="left">Spieler</th>
                    {SKATER_COLUMNS.map((c) => (
                      <th
                        key={c.key}
                        className="num"
                        style={{ cursor: 'pointer', userSelect: 'none', fontWeight: sortKey === c.key ? 800 : 600 }}
                        onClick={() => toggleSort(c.key)}
                        title="Sortieren"
                      >
                        {c.label}{sortKey === c.key ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedSkaters.map((s) => (
                    <tr key={s.playerId}>
                      <td className="left" style={{ fontSize: 13 }}>{s.number != null ? `#${s.number} ` : ''}{s.name}</td>
                      <td className="num" style={{ fontWeight: 700 }}>{s.points ?? '–'}</td>
                      <td className="num">{s.goals ?? '–'}</td>
                      <td className="num">{s.assists ?? '–'}</td>
                      <td className="num">{s.sog ?? '–'}</td>
                      <td className="num" style={{ fontFamily: 'var(--mono)' }}>{fmtToi(s.toiSec)}</td>
                      <td className="num">{fmtPlusMinus(s.plusMinus)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {goalies.length > 0 && (
            <div className="table-wrap" style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th className="left">Torhüter</th>
                    <th className="num">Paraden</th>
                    <th className="num">Gegentore</th>
                    <th className="num">SV%</th>
                  </tr>
                </thead>
                <tbody>
                  {goalies.map((g) => (
                    <tr key={g.playerId}>
                      <td className="left muted" style={{ fontSize: 13 }}>
                        {g.number != null ? `#${g.number} ` : ''}{g.name}
                        {g.shutout && <span className="chip" style={{ marginLeft: 6 }}>SO</span>}
                        {g.decision && <span className="chip" style={{ marginLeft: 6 }}>{g.decision}</span>}
                      </td>
                      <td className="num">{g.saves}{g.shots != null ? `/${g.shots}` : ''}</td>
                      <td className="num">{g.goalsAgainst}</td>
                      <td className="num">{g.savePercentage != null ? g.savePercentage.toFixed(1) + '%' : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
