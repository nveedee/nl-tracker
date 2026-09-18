// ---------------------------------------------------------------------------
// UI-KONZEPT: Kompakter Live-Match-Header - LIVE-Badge, Team-Icons, Score,
// Drittel/Spielzeit. Bewusst flach/dicht statt grosser Card-Fläche (siehe
// Football-MD-Referenz: Score ist der visuelle Mittelpunkt, kein grosses
// Hero-Layout). Rein präsentational, `live` hat die Form aus
// src/liveDemoData.js.
// ---------------------------------------------------------------------------
import { useState } from 'react'
import { getTeamLogoPath } from '../teamLogos.js'

// Zeigt das zentrale Team-Logo (src/teamLogos.js) innerhalb des bestehenden
// .live-team-mark-Kreises, sobald eine Logo-Datei vorhanden ist. Fällt
// exakt auf das bisherige Aussehen zurück (Farbrand + Kürzel), solange kein
// Logo hinterlegt ist ODER die Datei (noch) fehlt (onError) - kein kaputtes
// Bild-Icon.
function TeamMark({ team }) {
  const [failed, setFailed] = useState(false)
  const path = getTeamLogoPath(team.id)
  if (path && !failed) {
    return (
      <img
        src={path} alt="" width={26} height={26} loading="lazy" decoding="async"
        className="live-team-mark" style={{ objectFit: 'contain', border: 'none', background: 'transparent', padding: 0 }}
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <span className="live-team-mark" style={{ borderColor: team.color }}>
      {team.short}
    </span>
  )
}

// `probability` (optional, {pHome, pAway}) - zeigt zusätzlich die aktuelle
// Live-Win-Probability an (Dashboard "Live jetzt", siehe Dashboard.jsx).
// Ohne diesen Prop verhält sich die Komponente exakt wie bisher (MatchupDetail/
// GameReplayView/DevLiveReplay übergeben ihn nicht) - rein additiv, keine
// neue Live-Logik, `probability` kommt unverändert aus buildRealLiveMatch()
// (src/liveGameClient.js).
export default function LiveMatchHeader({ homeTeam, awayTeam, live, badgeLabel, badgeStatic = false, probability }) {
  const { status, score } = live
  const label = badgeLabel || (live.isDemo ? 'LIVE DEMO' : 'LIVE')
  return (
    <div className="card live-header">
      <div className="live-header-top">
        <span className="live-badge">{!badgeStatic && <span className="live-dot" />}{label}</span>
        <span className="live-period-text">{status.periodLabel}</span>
        {status.clock && <span className="live-clock">{status.clock}</span>}
      </div>
      <div className="live-header-teams">
        <div className="live-header-side">
          <TeamMark team={homeTeam} />
          <span className="live-header-name">{homeTeam.name}</span>
        </div>
        <div className="live-header-score">{score.home} : {score.away}</div>
        <div className="live-header-side away">
          <span className="live-header-name">{awayTeam.name}</span>
          <TeamMark team={awayTeam} />
        </div>
      </div>
      {probability && (
        <div className="live-header-prob">
          <div className="bar-track" style={{ height: 5 }}>
            <div className="bar-fill" style={{ width: `${Math.round(probability.pHome * 100)}%` }} />
          </div>
          <div className="live-header-prob-labels">
            <span>{homeTeam.short} {Math.round(probability.pHome * 100)}%</span>
            <span>{Math.round(probability.pAway * 100)}% {awayTeam.short}</span>
          </div>
        </div>
      )}
    </div>
  )
}
