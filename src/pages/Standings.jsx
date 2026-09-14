import { useData } from '../DataContext.jsx'
import { TeamBadge, useScrollFade } from '../components/ui.jsx'
import { PLAYOFF_FORMAT } from '../playoffSim.js'

// Trennlinien nach Rang 6 (direkt Top 6) und Rang 10 (Ende Play-in) - rein
// visuell aus der bereits bestehenden PLAYOFF_FORMAT-Konstante abgeleitet,
// keine neue/geänderte Logik.
function zoneBreakAfter(rank) {
  if (rank === PLAYOFF_FORMAT.directQuarterfinal[1]) return 'Direkt Top 6'
  if (rank === PLAYOFF_FORMAT.playIn[1]) return 'Ende Play-in'
  if (rank === PLAYOFF_FORMAT.seasonEnd[1]) return 'Saisonende'
  return null
}

export default function Standings() {
  const { data, derived } = useData()
  const rows = derived.standings
  const wrapRef = useScrollFade()

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Tabelle</h1>
          <div className="sub">Punkte: Sieg 3 · OT/PS-Sieg 2 · OT/PS-Niederlage 1 · Niederlage 0</div>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap pin-first" ref={wrapRef}>
          <table>
            <thead>
              <tr>
                <th className="left">Team</th>
                <th className="num" title="Spiele">SP</th>
                <th className="num" title="Siege">S</th>
                <th className="num" title="OT/PS-Siege">OTS</th>
                <th className="num" title="OT/PS-Niederlagen">OTN</th>
                <th className="num" title="Niederlagen">N</th>
                <th className="num" title="Tore">TF</th>
                <th className="num" title="Gegentore">TG</th>
                <th className="num" title="Tordifferenz">TD</th>
                <th className="num" title="Punkte">PKT</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const rank = i + 1
                const zone = zoneBreakAfter(rank)
                return (
                  <tr key={r.team.id} style={zone ? { borderBottom: '2px solid var(--border-strong)' } : undefined}>
                    <td className="left"><span className="rank" style={{ marginRight: 8 }}>{rank}</span><TeamBadge team={r.team} short /></td>
                    <td className="num">{r.gp}</td>
                    <td className="num">{r.w}</td>
                    <td className="num">{r.otw}</td>
                    <td className="num">{r.otl}</td>
                    <td className="num">{r.l}</td>
                    <td className="num">{r.gf}</td>
                    <td className="num">{r.ga}</td>
                    <td className="num" style={{ color: r.gd > 0 ? 'var(--good)' : r.gd < 0 ? 'var(--bad)' : 'inherit' }}>
                      {r.gd > 0 ? '+' + r.gd : r.gd}
                    </td>
                    <td className="num"><strong>{r.pts}</strong></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>Linie nach Rang 6 (direkt Top 6), Rang 10 (Ende Play-in) und Rang 12 (Saisonende).</div>
      {data.games.length === 0 && <p className="muted mt">Noch keine Spiele erfasst – die Tabelle füllt sich automatisch.</p>}
    </>
  )
}
