// ---------------------------------------------------------------------------
// UI-KONZEPT: Live-Statistiken als kompakte Vergleichstabelle (wie
// Teamvergleich/Head-to-Head auf derselben Seite) statt grosser Karten mit
// Balken. Ausschliesslich Eishockey-Kennzahlen (SOG, Schüsse, Bullys,
// Powerplay, Strafminuten) - KEINE Fussball-Statistiken (Ballbesitz/
// Corners/Offside, laut Machbarkeitsanalyse im Eishockey nicht anwendbar).
// Rein präsentational, erwartet ein flaches `stats`-Objekt (siehe
// src/liveDemoData.js).
// ---------------------------------------------------------------------------
function Row({ label, home, away, homeColor, awayColor }) {
  const total = (home || 0) + (away || 0)
  const homePct = total > 0 ? (home / total) * 100 : 50
  return (
    <tr>
      <td className="num" style={{ fontWeight: 700 }}>{home}</td>
      <td className="left">
        <div className="live-stat-label">{label}</div>
        <div className="live-stat-bar-track">
          <div style={{ width: `${homePct}%`, background: homeColor }} />
          <div style={{ width: `${100 - homePct}%`, background: awayColor }} />
        </div>
      </td>
      <td className="num" style={{ fontWeight: 700 }}>{away}</td>
    </tr>
  )
}

export default function LiveStatistics({ homeTeam, awayTeam, stats }) {
  return (
    <div className="card card-pad live-section">
      <div className="row spread live-section-head">
        <h2 style={{ fontSize: 13 }}>Live Statistics</h2>
        <span className="chip" style={{ color: 'var(--text-dim)', fontSize: 10 }}>Demo-Daten</span>
      </div>
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
            <Row label="SOG" home={stats.sogHome} away={stats.sogAway} homeColor={homeTeam.color} awayColor={awayTeam.color} />
            <Row label="Schüsse total" home={stats.shotsHome} away={stats.shotsAway} homeColor={homeTeam.color} awayColor={awayTeam.color} />
            <Row label="Bullys gewonnen" home={stats.faceoffsWonHome} away={stats.faceoffsWonAway} homeColor={homeTeam.color} awayColor={awayTeam.color} />
            <tr>
              <td className="num" style={{ fontWeight: 700 }}>{stats.ppGoalsHome}/{stats.ppHome}</td>
              <td className="left"><div className="live-stat-label">Powerplay (Tore/Chancen)</div></td>
              <td className="num" style={{ fontWeight: 700 }}>{stats.ppGoalsAway}/{stats.ppAway}</td>
            </tr>
            <Row label="Strafminuten" home={stats.pimHome} away={stats.pimAway} homeColor={homeTeam.color} awayColor={awayTeam.color} />
          </tbody>
        </table>
      </div>
    </div>
  )
}
