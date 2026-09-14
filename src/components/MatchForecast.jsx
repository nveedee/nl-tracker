import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TeamBadge, SectionHeader, Expander } from './ui.jsx'

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
// Als Karten-Liste statt Tabelle - vermeidet horizontales Scrollen auf dem
// Handy (kein Team pro Zeile, "sticky first column" passt hier nicht).
export default function MatchForecast({ forecasts }) {
  const [expanded, setExpanded] = useState(false)
  const navigate = useNavigate()
  if (!forecasts.length) return null

  const visible = expanded ? forecasts : forecasts.slice(0, DEFAULT_LIMIT)

  return (
    <div className="card mb">
      <div className="card-pad" style={{ paddingBottom: 8 }}>
        <SectionHeader
          title="Per-Match-Forecast"
          caption="Heimsieg-/Auswärtssieg-Chance aus ELO + Heimvorteil für die kommenden Spiele."
          action={<span className="muted" style={{ fontSize: 11.5 }}>{forecasts.length} offen</span>}
        />
      </div>
      <div className="match-list">
        {visible.map((f) => (
          <button key={f.gameId} className="match-item" onClick={() => navigate(`/matchup/${f.gameId}`)}>
            <div className="match-meta">
              <span>{fmtDate(f.date)}</span>
              <span>n.V./PS {fmtPct(f.pDecision)}</span>
            </div>
            <div className="match-teams">
              <div className="side">
                <TeamBadge team={f.homeTeam} short />
                <span className="pct">{fmtPct(f.pHomeWin)}</span>
              </div>
              <div className="split-bar">
                <div className="home" style={{ width: `${f.pHomeWin * 100}%` }} />
                <div className="away" style={{ width: `${f.pAwayWin * 100}%` }} />
              </div>
              <div className="side away">
                <TeamBadge team={f.awayTeam} short />
                <span className="pct">{fmtPct(f.pAwayWin)}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
      <Expander total={forecasts.length} initialCount={DEFAULT_LIMIT} expanded={expanded} onExpand={() => setExpanded(true)} moreLabel={`Alle ${forecasts.length} offenen Spiele anzeigen`} />
    </div>
  )
}
