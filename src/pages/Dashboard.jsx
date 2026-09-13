import { Link } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge, Empty } from '../components/ui.jsx'
import { isFinalGame } from '../stats.js'

export default function Dashboard() {
  const { data, derived } = useData()
  const { standings, playerStats, elo } = derived
  const games = data.games

  const topScorers = [...playerStats]
    .filter((p) => p.gp > 0)
    .sort((a, b) => b.points - a.points || b.goals - a.goals)
    .slice(0, 5)

  const playedGames = games.filter(isFinalGame)
  const upcoming = games.filter((g) => !isFinalGame(g)).sort((a, b) => (a.date > b.date ? 1 : -1))
  const showUpcoming = playedGames.length === 0
  const recent = showUpcoming
    ? upcoming.slice(0, 6)
    : [...playedGames].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 6)
  const scheduledCount = games.filter((g) => g.status === 'scheduled').length

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{data.settings.seasonName}</h1>
        </div>
        <Link className="btn primary" to="/games/new">Spiel erfassen</Link>
      </div>

      <div className="stat-strip">
        <div className="stat"><strong>{data.teams.length}</strong><span>Teams</span></div>
        <div className="stat"><strong>{data.players.length}</strong><span>Spieler</span></div>
        <div className="stat"><strong>{playedGames.length}</strong><span>Spiele</span></div>
        <div className="stat"><strong>{playedGames.reduce((s, g) => s + g.homeGoals + g.awayGoals, 0)}</strong><span>Tore</span></div>
      </div>

      {games.length === 0 ? (
        <Empty
          title="Noch keine Spiele erfasst"
          hint={'Lege zuerst die Kader unter „Teams & Kader" an und erfasse dann dein erstes Spiel.'}
          action={<Link className="btn primary" to="/games/new">Erstes Spiel erfassen</Link>}
        />
      ) : (
        <div className="grid grid-2">
          <div className="card card-pad">
            <div className="row spread mb">
              <h2>Tabelle</h2>
              <Link className="btn ghost sm" to="/standings">Alle →</Link>
            </div>
            {standings.slice(0, 6).map((r, i) => (
              <div key={r.team.id} className="row spread" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                <span className="row gap-sm"><span className="rank">{i + 1}</span><TeamBadge team={r.team} /></span>
                <span className="num" style={{ fontFamily: 'var(--mono)' }}>{r.pts} <span className="muted">Pkt</span></span>
              </div>
            ))}
          </div>

          <div className="card card-pad">
            <div className="row spread mb">
              <h2>ELO-Ranking</h2>
              <Link className="btn ghost sm" to="/elo">Alle →</Link>
            </div>
            {elo.ranking.slice(0, 6).map((r, i) => (
              <div key={r.team.id} className="row spread" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                <span className="row gap-sm"><span className="rank">{i + 1}</span><TeamBadge team={r.team} /></span>
                <span className="num" style={{ fontFamily: 'var(--mono)' }}>{r.rating}</span>
              </div>
            ))}
          </div>

          <div className="card card-pad">
            <div className="row spread mb">
              <h2>Playoff Odds</h2>
              <Link className="btn ghost sm" to="/playoff-odds">Öffnen →</Link>
            </div>
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
              Monte-Carlo-Simulation der Resttabelle auf Basis von ELO, Offensive/Defensive und Form.
              {scheduledCount > 0 ? ` ${scheduledCount} offene Spiele im Spielplan.` : ' Keine offenen Spiele im Spielplan.'}
            </div>
          </div>

          <div className="card card-pad">
            <div className="row spread mb">
              <h2>Topskorer</h2>
              <Link className="btn ghost sm" to="/players">Alle →</Link>
            </div>
            {topScorers.length === 0 && <div className="muted">Noch keine Spieler-Stats.</div>}
            {topScorers.map((p, i) => (
              <div key={p.player.id} className="row spread" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                <span className="row gap-sm">
                  <span className="rank">{i + 1}</span>
                  <Link to={`/players/${p.player.id}`}>{p.player.name}</Link>
                </span>
                <span className="num" style={{ fontFamily: 'var(--mono)' }}>
                  {p.points} P <span className="muted">({p.goals}+{p.assists})</span>
                </span>
              </div>
            ))}
          </div>

          <div className="card card-pad" style={{ gridColumn: '1 / -1' }}>
            <div className="row spread mb">
              <h2>{showUpcoming ? 'Nächste Spiele' : 'Letzte Spiele'}</h2>
              <Link className="btn ghost sm" to={showUpcoming ? '/schedule' : '/games'}>Alle →</Link>
            </div>
            {recent.length === 0 ? (
              <div className="muted">Noch keine Spiele im Spielplan.</div>
            ) : (
              <div className="grid grid-3">
                {recent.map((g) => {
                  const h = data.teams.find((t) => t.id === g.homeTeamId)
                  const a = data.teams.find((t) => t.id === g.awayTeamId)
                  const gamePlayed = isFinalGame(g)
                  return (
                    <Link key={g.id} to={`/matchup/${g.id}`} className="card card-pad" style={{ display: 'block' }}>
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {g.date}{g.time ? ` · ${g.time}` : ''}{gamePlayed && g.decision !== 'REG' ? ` · ${g.decision}` : ''}
                      </div>
                      <div className="row spread mt">
                        <TeamBadge team={h} short link={false} />
                        {gamePlayed
                          ? <strong style={{ fontFamily: 'var(--mono)' }}>{g.homeGoals}:{g.awayGoals}</strong>
                          : <span className="muted" style={{ fontFamily: 'var(--mono)' }}>–:–</span>}
                        <TeamBadge team={a} short link={false} />
                      </div>
                    </Link>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
