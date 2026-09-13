import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TeamBadge } from './ui.jsx'

function fmtPct(v) { return (v * 100).toFixed(0) + '%' }
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('de-CH', { weekday: 'short', day: '2-digit', month: '2-digit' })
}

const DEFAULT_LIMIT = 10

// Heimsieg-/Auswärtssieg-% (aus ELO + Heimvorteil) und P(Entscheidung n.V.)
// für die kommenden Spiele - identische Teamstärke-Basis wie die Monte-
// Carlo-Simulation (src/playoffSim.js::computeMatchForecasts), nur
// geschlossen statt simuliert ausgewertet. Klick öffnet die bereits
// bestehende Matchup-Detailseite (/matchup/:gameId, MatchupDetail.jsx).
export default function MatchForecast({ forecasts }) {
  const [showAll, setShowAll] = useState(false)
  const navigate = useNavigate()
  if (!forecasts.length) return null

  const visible = showAll ? forecasts : forecasts.slice(0, DEFAULT_LIMIT)

  return (
    <div className="card mb">
      <div className="card-pad row spread" style={{ paddingBottom: 10 }}>
        <div className="section-label" style={{ margin: 0 }}>Per-Match-Forecast</div>
        <span className="muted" style={{ fontSize: 11.5 }}>{forecasts.length} offene Spiele</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="left">Datum</th>
              <th className="left">Heim</th>
              <th className="left"></th>
              <th className="left">Auswärts</th>
              <th className="left" style={{ minWidth: 160 }}>Heimsieg / Ausw.-Sieg</th>
              <th className="num">n.V./PS</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((f) => (
              <tr key={f.gameId} className="match-row" onClick={() => navigate(`/matchup/${f.gameId}`)}>
                <td className="left muted" style={{ fontSize: 12 }}>{fmtDate(f.date)}</td>
                <td className="left"><TeamBadge team={f.homeTeam} short /></td>
                <td className="left muted">–</td>
                <td className="left"><TeamBadge team={f.awayTeam} short /></td>
                <td className="left">
                  <div className="row gap-sm" style={{ alignItems: 'center' }}>
                    <div className="split-bar" style={{ flex: 1 }}>
                      <div className="home" style={{ width: `${f.pHomeWin * 100}%` }} />
                      <div className="away" style={{ width: `${f.pAwayWin * 100}%` }} />
                    </div>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, minWidth: 70, textAlign: 'right' }}>
                      {fmtPct(f.pHomeWin)} / {fmtPct(f.pAwayWin)}
                    </span>
                  </div>
                </td>
                <td className="num muted" style={{ fontSize: 11.5 }}>{fmtPct(f.pDecision)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!showAll && forecasts.length > DEFAULT_LIMIT && (
        <div className="card-pad" style={{ paddingTop: 10 }}>
          <button className="btn ghost sm" onClick={() => setShowAll(true)}>
            Alle {forecasts.length} offenen Spiele anzeigen
          </button>
        </div>
      )}
    </div>
  )
}
