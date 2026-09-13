import { useData } from '../DataContext.jsx'
import { TeamBadge } from '../components/ui.jsx'

export default function Standings() {
  const { data, derived } = useData()
  const rows = derived.standings

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Tabelle</h1>
          <div className="sub">Punkte: Sieg 3 · OT/PS-Sieg 2 · OT/PS-Niederlage 1 · Niederlage 0</div>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="left">#</th>
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
              {rows.map((r, i) => (
                <tr key={r.team.id}>
                  <td className="left rank">{i + 1}</td>
                  <td className="left"><TeamBadge team={r.team} /></td>
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
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {data.games.length === 0 && <p className="muted mt">Noch keine Spiele erfasst – die Tabelle füllt sich automatisch.</p>}
    </>
  )
}
