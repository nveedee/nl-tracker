import { Link, useNavigate } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge, Empty } from '../components/ui.jsx'
import { homeWinProbability } from '../elo.js'
import { applyRestAdjustment, computeRestAdjustment, DEFAULT_BACK_TO_BACK_PENALTY } from '../restDays.js'

export default function Schedule() {
  const { data, derived } = useData()
  const navigate = useNavigate()
  const homeAdv = data.settings.eloHomeAdvantage
  const ratings = derived.elo.ratings
  const start = data.settings.eloStart
  const restDaysEnabled = data.settings?.restDaysEnabled !== false
  const backToBackPenalty = data.settings?.backToBackPenalty ?? DEFAULT_BACK_TO_BACK_PENALTY

  const upcoming = data.games
    .filter((g) => g.status === 'scheduled')
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time || '').localeCompare(b.time || '')))

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Spielplan</h1>
          <div className="sub">{upcoming.length} kommende Spiele · Prognose auf Basis der aktuellen ELO-Werte</div>
        </div>
      </div>

      {upcoming.length === 0 ? (
        <Empty
          title="Keine offenen Spiele im Spielplan"
          hint="Alle erfassten Spiele haben bereits ein Resultat."
        />
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="left">Datum</th>
                  <th className="left">Heim</th>
                  <th className="left">Prognose</th>
                  <th className="left">Auswärts</th>
                  <th className="num"></th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map((g) => {
                  const h = data.teams.find((t) => t.id === g.homeTeamId)
                  const a = data.teams.find((t) => t.id === g.awayTeamId)
                  const rh = ratings[g.homeTeamId] ?? start
                  const ra = ratings[g.awayTeamId] ?? start
                  const rawPHome = homeWinProbability(rh, ra, homeAdv)
                  const restAdjustment = restDaysEnabled ? computeRestAdjustment(g, data.games, backToBackPenalty) : 0
                  const pHome = restAdjustment !== 0 ? applyRestAdjustment(rawPHome, g, data.games, backToBackPenalty) : rawPHome
                  const pctHome = Math.round(pHome * 100)
                  const pctAway = 100 - pctHome
                  return (
                    <tr key={g.id} onClick={() => navigate(`/matchup/${g.id}`)} style={{ cursor: 'pointer' }}>
                      <td className="left muted">{g.date}{g.time ? ` · ${g.time}` : ''}</td>
                      <td className="left" onClick={(e) => e.stopPropagation()}><TeamBadge team={h} /></td>
                      <td className="left">
                        <span className="row gap-sm" style={{ fontFamily: 'var(--mono)' }}>
                          <strong style={{ color: pctHome >= pctAway ? 'var(--good)' : 'var(--text-dim)' }}>{h?.short} {pctHome}%</strong>
                          <span className="muted">–</span>
                          <strong style={{ color: pctAway > pctHome ? 'var(--good)' : 'var(--text-dim)' }}>{pctAway}% {a?.short}</strong>
                          {restAdjustment !== 0 && (
                            <span className="muted" style={{ fontSize: 10.5 }} title={`Back-to-back-Anpassung berücksichtigt (${restAdjustment > 0 ? h?.short : a?.short} ausgeruht)`}>B2B</span>
                          )}
                        </span>
                      </td>
                      <td className="left" onClick={(e) => e.stopPropagation()}><TeamBadge team={a} /></td>
                      <td className="num"><Link className="btn ghost sm" to={`/matchup/${g.id}`} onClick={(e) => e.stopPropagation()}>Matchup</Link></td>
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
