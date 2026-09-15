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

  // Prediction-Snapshots (server/scripts/predictions.js) sind die EINZIGE
  // gemeinsame Quelle mit MatchupDetail.jsx für die Pre-Game-Prognose eines
  // konkreten Spiels - ohne das wich hier eine eigene, abweichende
  // ELO-Live-Formel ggü. der dortigen Monte-Carlo-Simulation berechnet
  // (Ursache der Schedule/Matchup-Inkonsistenz). Existiert ein Snapshot,
  // gewinnt dessen eingefrorener Wert; ohne Snapshot bleibt der bisherige
  // Live-ELO-Fallback unverändert (z.B. für ein Spiel, das erst nach dem
  // letzten Sync-Lauf hinzugefügt wurde).
  const predictionByGameId = new Map((data.predictions || []).map((p) => [p.gameId, p]))

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Spielplan</h1>
          <div className="sub">{upcoming.length} kommende Spiele · Prognose aus dem gespeicherten Pre-Game-Snapshot (Fallback: aktuelle ELO-Werte)</div>
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
                  const snapshot = predictionByGameId.get(g.id)
                  // NUR für den B2B-Hinweis-Chip - unabhängig davon, ob die
                  // Prognose aus dem Snapshot oder live berechnet wird. Reine
                  // Anzeige-Information (wer ist ausgeruht), fliesst NICHT in
                  // pctHome/pctAway ein, wenn ein Snapshot verwendet wird -
                  // dessen Wert hat die B2B-Anpassung bereits eingerechnet
                  // (siehe server/scripts/predictions.js), eine erneute
                  // Anwendung hier wäre eine doppelte Anpassung.
                  const restAdjustmentForDisplay = restDaysEnabled ? computeRestAdjustment(g, data.games, backToBackPenalty) : 0
                  let pctHome, pctAway
                  if (snapshot) {
                    // Identisch zu MatchupDetail.jsx ("Pre-Game Prediction"):
                    // eingefrorener Snapshot-Wert, keine Neuberechnung.
                    pctHome = Math.round(snapshot.homeWinProbability * 100)
                    pctAway = 100 - pctHome
                  } else {
                    const rh = ratings[g.homeTeamId] ?? start
                    const ra = ratings[g.awayTeamId] ?? start
                    const rawPHome = homeWinProbability(rh, ra, homeAdv)
                    const pHome = restAdjustmentForDisplay !== 0 ? applyRestAdjustment(rawPHome, g, data.games, backToBackPenalty) : rawPHome
                    pctHome = Math.round(pHome * 100)
                    pctAway = 100 - pctHome
                  }
                  return (
                    <tr key={g.id} onClick={() => navigate(`/matchup/${g.id}`)} style={{ cursor: 'pointer' }}>
                      <td className="left muted">{g.date}{g.time ? ` · ${g.time}` : ''}</td>
                      <td className="left" onClick={(e) => e.stopPropagation()}><TeamBadge team={h} /></td>
                      <td className="left">
                        <span className="row gap-sm" style={{ fontFamily: 'var(--mono)' }}>
                          <strong style={{ color: pctHome >= pctAway ? 'var(--good)' : 'var(--text-dim)' }}>{h?.short} {pctHome}%</strong>
                          <span className="muted">–</span>
                          <strong style={{ color: pctAway > pctHome ? 'var(--good)' : 'var(--text-dim)' }}>{pctAway}% {a?.short}</strong>
                          {restAdjustmentForDisplay !== 0 && (
                            <span className="muted" style={{ fontSize: 10.5 }} title={`Back-to-back-Anpassung berücksichtigt (${restAdjustmentForDisplay > 0 ? h?.short : a?.short} ausgeruht)`}>B2B</span>
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
