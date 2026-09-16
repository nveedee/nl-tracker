import { Link, useNavigate } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge, Empty, SectionHeader } from '../components/ui.jsx'
import { homeWinProbability } from '../elo.js'
import { applyRestAdjustment, computeRestAdjustment, DEFAULT_BACK_TO_BACK_PENALTY } from '../restDays.js'
import { isFinalGame } from '../stats.js'
import { getPregamePrediction } from '../pregamePrediction.js'

// Zentrale Spiele-Seite (/schedule) - vereint kommende Spiele (mit Prognose)
// und abgeschlossene Spiele/Ergebnisse (vormals die separate Seite /games,
// siehe App.jsx-Redirect). Beide Tabellen unverändert aus den jeweiligen
// Vorgänger-Implementierungen übernommen, nur zusammengeführt - keine neue
// Berechnung, keine neue Prognoselogik.
export default function Schedule() {
  const { data, derived } = useData()
  const navigate = useNavigate()
  const homeAdv = data.settings.eloHomeAdvantage
  const ratings = derived.elo.ratings
  const start = data.settings.eloStart
  const restDaysEnabled = data.settings?.restDaysEnabled !== false
  const backToBackPenalty = data.settings?.backToBackPenalty ?? DEFAULT_BACK_TO_BACK_PENALTY
  const teamMap = Object.fromEntries(data.teams.map((t) => [t.id, t]))

  const upcoming = data.games
    .filter((g) => g.status === 'scheduled')
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time || '').localeCompare(b.time || '')))

  const played = data.games
    .filter(isFinalGame)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  // Pre-Game-Prognose über die zentrale Single Source of Truth
  // (src/pregamePrediction.js) - Snapshot bevorzugt, sonst der geschlossene
  // ELO-Live-Fallback (z.B. für ein Spiel, das erst nach dem letzten
  // Sync-Lauf hinzugefügt wurde). Dieselbe Priorisierung wie auf Dashboard,
  // Season Projections, TeamDetail und MatchupDetail - kein Ort im
  // Frontend berechnet mehr eine eigene, potenziell abweichende Prognose.

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Spielplan</h1>
          <div className="sub">{upcoming.length} kommende Spiele · {played.length} gespielt</div>
        </div>
      </div>

      <SectionHeader
        title="Kommende Spiele"
        caption="Prognose aus dem gespeicherten Pre-Game-Snapshot (Fallback: aktuelle ELO-Werte)."
      />
      {upcoming.length === 0 ? (
        <Empty
          title="Keine offenen Spiele im Spielplan"
          hint="Alle erfassten Spiele haben bereits ein Resultat."
        />
      ) : (
        <div className="card mb">
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
                  // NUR für den B2B-Hinweis-Chip - unabhängig davon, ob die
                  // Prognose aus dem Snapshot oder live berechnet wird. Reine
                  // Anzeige-Information (wer ist ausgeruht), fliesst NICHT
                  // nochmal in die Prognose ein, wenn ein Snapshot verwendet
                  // wird - dessen Wert hat die B2B-Anpassung bereits
                  // eingerechnet (siehe server/scripts/predictions.js), eine
                  // erneute Anwendung hier wäre eine doppelte Anpassung.
                  const restAdjustmentForDisplay = restDaysEnabled ? computeRestAdjustment(g, data.games, backToBackPenalty) : 0
                  // Live-Fallback-Kandidat (nur verwendet, wenn kein Snapshot
                  // existiert) - identische Formel wie zuvor, jetzt hinter
                  // getPregamePrediction() konsolidiert.
                  const rh = ratings[g.homeTeamId] ?? start
                  const ra = ratings[g.awayTeamId] ?? start
                  const rawPHome = homeWinProbability(rh, ra, homeAdv)
                  const livePHome = restAdjustmentForDisplay !== 0 ? applyRestAdjustment(rawPHome, g, data.games, backToBackPenalty) : rawPHome
                  const prediction = getPregamePrediction(g.id, data.predictions, { gameId: g.id, pHomeWin: livePHome, pAwayWin: 1 - livePHome })
                  const pctHome = Math.round(prediction.pHomeWin * 100)
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

      <SectionHeader title="Ergebnisse" caption={`${played.length} abgeschlossene Spiele.`} />
      {played.length === 0 ? (
        <Empty
          title="Noch keine Spiele gespielt"
          hint="Sobald Resultate erfasst sind, erscheinen sie hier."
        />
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
                </tr>
              </thead>
              <tbody>
                {played.map((g) => {
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
