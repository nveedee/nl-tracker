import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TeamBadge, SectionHeader, Expander } from './ui.jsx'

function fmtPct(v) { return (v * 100).toFixed(0) + '%' }
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('de-CH', { weekday: 'short', day: '2-digit', month: '2-digit' })
}

// Kompakte "Warum?"-Zeile pro Karte - ausschliesslich aus den bereits
// mitgelieferten Feldern (eloHome/eloAway, pHomeWin/pAwayWin) abgeleitet,
// keine neue Modelllogik (vgl. buildWhyText in MatchupDetail.jsx für die
// ausführliche Variante auf der Detailseite). Nur ELO-Differenz und
// Heimvorteil, weil das die einzigen Faktoren sind, die auf dieser Karte
// zuverlässig vorhanden sind (Form/Power Ranking werden hier nicht geladen).
function buildForecastWhy(f) {
  if (f.eloHome == null || f.eloAway == null) return null
  const homeLeads = f.pHomeWin >= f.pAwayWin
  const leadTeam = homeLeads ? f.homeTeam : f.awayTeam
  const leadElo = Math.round(homeLeads ? f.eloHome : f.eloAway)
  const otherElo = Math.round(homeLeads ? f.eloAway : f.eloHome)
  const reasons = []
  if (leadElo > otherElo && leadElo - otherElo >= 5) reasons.push(`höherem ELO (${leadElo} vs. ${otherElo})`)
  if (homeLeads) reasons.push('Heimvorteil')
  if (reasons.length === 0) return null
  return `${leadTeam.short} vorne dank ${reasons.join(' und ')}`
}

const DEFAULT_LIMIT = 10

// Heimsieg-/Auswärtssieg-% (aus ELO + Heimvorteil) und P(Entscheidung n.V.)
// für die kommenden Spiele - identische Teamstärke-Basis wie die Monte-
// Carlo-Simulation (src/playoffSim.js::computeMatchForecasts), nur
// geschlossen statt simuliert ausgewertet. Klick öffnet die bereits
// bestehende Matchup-Detailseite (/matchup/:gameId, MatchupDetail.jsx).
// Als Karten-Liste statt Tabelle - vermeidet horizontales Scrollen auf dem
// Handy (kein Team pro Zeile, "sticky first column" passt hier nicht).
//
// Zusätzliche Kennzahlen-Zeile (Expected Goals/OT/SO/ELO) ist OPTIONAL - nur
// sichtbar, wenn der Aufrufer die entsprechenden Felder mitliefert
// (expHomeGoals/expAwayGoals/eloHome/eloAway/pOT/pSO). Diese Werte kommen
// unverändert aus computeFixtures()/dem bereits vorhandenen OT-Anteil
// (src/liveProbability.js::OT_SHARE_OF_TIES, identisch zu playoffSim.js
// CALIBRATION.otShareOfTies) - siehe PlayoffOdds.jsx/Dashboard.jsx, wo diese
// Felder angereichert werden. Kein neuer Modellwert, nur zusätzlich
// angezeigt. `restNote` (optional, String): Back-to-back-Hinweistext, aus
// der bestehenden src/restDays.js-Anpassung abgeleitet (identisch zu
// Schedule.jsx/MatchupDetail.jsx) - nur ein Chip, keine neue Berechnung.
export default function MatchForecast({ forecasts, title = 'Per-Match-Forecast', caption = 'Heimsieg-/Auswärtssieg-Chance aus ELO + Heimvorteil für die kommenden Spiele.', limit = DEFAULT_LIMIT, showCount = true }) {
  const [expanded, setExpanded] = useState(false)
  const navigate = useNavigate()
  if (!forecasts.length) return null

  const visible = expanded ? forecasts : forecasts.slice(0, limit)
  const hasExtras = visible.some((f) => f.expHomeGoals != null)

  return (
    <div className="card mb">
      <div className="card-pad" style={{ paddingBottom: 8 }}>
        <SectionHeader
          title={title}
          caption={caption}
          action={showCount ? <span className="muted" style={{ fontSize: 11.5 }}>{forecasts.length} offen</span> : null}
        />
      </div>
      <div className="match-list">
        {visible.map((f) => {
          const why = buildForecastWhy(f)
          return (
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
              {hasExtras && f.expHomeGoals != null && (
                <div className="match-extra">
                  <span><span className="muted">xG</span> {f.expHomeGoals.toFixed(1)}–{f.expAwayGoals.toFixed(1)}</span>
                  <span><span className="muted">OT</span> {fmtPct(f.pOT)}</span>
                  <span><span className="muted">SO</span> {fmtPct(f.pSO)}</span>
                  {f.eloHome != null && <span><span className="muted">ELO</span> {Math.round(f.eloHome)}–{Math.round(f.eloAway)}</span>}
                  {f.restNote && <span title={f.restNote}><span className="muted">B2B</span></span>}
                </div>
              )}
              {why && <div className="match-why muted">{why}</div>}
            </button>
          )
        })}
      </div>
      <Expander total={forecasts.length} initialCount={limit} expanded={expanded} onExpand={() => setExpanded(true)} moreLabel={`Alle ${forecasts.length} offenen Spiele anzeigen`} />
    </div>
  )
}
