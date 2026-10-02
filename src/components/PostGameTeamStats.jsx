import { SectionHeader } from './ui.jsx'

function fmtPct1(v) { return v == null ? '–' : v.toFixed(1) + '%' }

// Nach-Spiel-Teamvergleich (Game Center, src/gameCenter.js::getPostGameTeamStats) -
// gleiches Bar-Vergleichsmuster wie LiveStatistics.jsx, hier mit echten
// Post-Game-Werten aus nlTeamStatsHome/Away statt Demo-Daten. Zeigt eine
// Zeile nur, wenn der Wert für BEIDE Teams vorhanden ist - keine 0-Erfindung.
function Row({ label, home, away, homeColor, awayColor, fmt = (v) => v }) {
  if (home == null && away == null) return null
  const h = home ?? 0
  const a = away ?? 0
  const total = h + a
  const homePct = total > 0 ? (h / total) * 100 : 50
  return (
    <tr>
      <td className="num" style={{ fontWeight: 700 }}>{home != null ? fmt(home) : '–'}</td>
      <td className="left">
        <div className="live-stat-label">{label}</div>
        <div className="live-stat-bar-track">
          <div style={{ width: `${homePct}%`, background: homeColor }} />
          <div style={{ width: `${100 - homePct}%`, background: awayColor }} />
        </div>
      </td>
      <td className="num" style={{ fontWeight: 700 }}>{away != null ? fmt(away) : '–'}</td>
    </tr>
  )
}

export default function PostGameTeamStats({ homeTeam, awayTeam, teamStats }) {
  if (!teamStats || !homeTeam || !awayTeam) return null
  const { home: h, away: a, sogDiff, goalDiff } = teamStats

  return (
    <div className="card card-pad mb">
      <SectionHeader title="Team Statistics" caption="Nach dem Spiel" />
      <div className="table-wrap" style={{ border: 'none' }}>
        <table className="live-stats-table">
          <thead>
            <tr>
              <th className="num" style={{ color: homeTeam.color }}>{homeTeam.short}</th>
              <th></th>
              <th className="num" style={{ color: awayTeam.color }}>{awayTeam.short}</th>
            </tr>
          </thead>
          <tbody>
            <Row label="Schüsse aufs Tor (SOG)" home={h.sog} away={a.sog} homeColor={homeTeam.color} awayColor={awayTeam.color} />
            <Row label="Tore/SOG-Verhältnis" home={h.sogPercentage} away={a.sogPercentage} homeColor={homeTeam.color} awayColor={awayTeam.color} fmt={fmtPct1} />
            <Row label="Powerplay %" home={h.ppPercentage} away={a.ppPercentage} homeColor={homeTeam.color} awayColor={awayTeam.color} fmt={fmtPct1} />
            <Row label="Penalty Kill %" home={h.pkPercentage} away={a.pkPercentage} homeColor={homeTeam.color} awayColor={awayTeam.color} fmt={fmtPct1} />
            <Row label="Bullyquote" home={h.foPercentage} away={a.foPercentage} homeColor={homeTeam.color} awayColor={awayTeam.color} fmt={fmtPct1} />
            <Row label="Strafminuten" home={h.pim} away={a.pim} homeColor={homeTeam.color} awayColor={awayTeam.color} />
          </tbody>
        </table>
      </div>
      <div className="row gap-sm wrap mt" style={{ fontSize: 12.5 }}>
        <span className="chip">SOG-Differenz {sogDiff != null ? (sogDiff > 0 ? `+${sogDiff}` : sogDiff) + ` ${homeTeam.short}` : '–'}</span>
        <span className="chip">Tor-Differenz {goalDiff != null ? (goalDiff > 0 ? `+${goalDiff}` : goalDiff) + ` ${homeTeam.short}` : '–'}</span>
      </div>
    </div>
  )
}
