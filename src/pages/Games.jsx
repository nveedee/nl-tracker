import { Link, useNavigate } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge } from '../components/ui.jsx'
import { isFinalGame } from '../stats.js'

export default function Games() {
  const { data } = useData()
  const navigate = useNavigate()
  const teamMap = Object.fromEntries(data.teams.map((t) => [t.id, t]))
  const games = data.games
    .filter(isFinalGame)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Alle Spiele</h1>
          <div className="sub">{games.length} gespielt</div>
        </div>
        <div className="row gap-sm">
          <Link className="btn ghost" to="/schedule">Spielplan</Link>
          <Link className="btn primary" to="/games/new">Spiel erfassen</Link>
        </div>
      </div>

      {games.length === 0 ? (
        <div className="empty">
          <div className="title">Noch keine Spiele gespielt</div>
          <div className="hint">Kommende Spiele findest du im <Link to="/schedule">Spielplan</Link>.</div>
          <div style={{ marginTop: 14 }}><Link className="btn primary" to="/games/new">Erstes Spiel erfassen</Link></div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="left">Datum</th>
                  <th className="left">Heim</th>
                  <th className="num">Resultat</th>
                  <th className="left">Auswärts</th>
                  <th className="left">Modus</th>
                  <th className="num"></th>
                  <th className="num"></th>
                </tr>
              </thead>
              <tbody>
                {games.map((g) => {
                  const h = teamMap[g.homeTeamId], a = teamMap[g.awayTeamId]
                  const homeWon = g.homeGoals > g.awayGoals
                  return (
                    <tr key={g.id} onClick={() => navigate(`/matchup/${g.id}`)} style={{ cursor: 'pointer' }}>
                      <td className="left muted">{g.date}{g.time ? ` · ${g.time}` : ''}</td>
                      <td className="left" style={{ fontWeight: homeWon ? 700 : 400 }} onClick={(e) => e.stopPropagation()}><TeamBadge team={h} /></td>
                      <td className="num"><strong>{g.homeGoals} : {g.awayGoals}</strong></td>
                      <td className="left" style={{ fontWeight: !homeWon ? 700 : 400 }} onClick={(e) => e.stopPropagation()}><TeamBadge team={a} /></td>
                      <td className="left">{g.decision === 'REG' ? <span className="muted">–</span> : <span className="chip">{g.decision === 'OT' ? 'Overtime' : 'Penalty'}</span>}</td>
                      <td className="num"><Link className="btn ghost sm" to={`/matchup/${g.id}`} onClick={(e) => e.stopPropagation()}>Matchup</Link></td>
                      <td className="num"><Link className="btn ghost sm" to={`/games/${g.id}`} onClick={(e) => e.stopPropagation()}>Bearbeiten</Link></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}
