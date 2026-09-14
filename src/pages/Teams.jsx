import { Link } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge } from '../components/ui.jsx'

export default function Teams() {
  const { data } = useData()
  const counts = Object.fromEntries(data.teams.map((t) => [t.id, 0]))
  data.players.forEach((p) => { if (counts[p.teamId] != null) counts[p.teamId]++ })

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Teams & Kader</h1>
          <div className="sub">Klicke auf ein Team, um die Spieler zu verwalten</div>
        </div>
      </div>

      <div className="grid grid-3">
        {data.teams.map((t) => (
          <Link key={t.id} to={`/teams/${t.id}`} className="card card-pad" style={{ display: 'block' }}>
            <div className="row spread">
              <TeamBadge team={t} link={false} />
              <span className="chip">{counts[t.id]} Spieler</span>
            </div>
            <div className="bar-track mt"><div className="bar-fill" style={{ width: '100%', background: t.color, opacity: 0.5 }} /></div>
          </Link>
        ))}
      </div>
    </>
  )
}
