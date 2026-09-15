// ---------------------------------------------------------------------------
// UI-KONZEPT: Live Win/Draw/Loss Probability - Chart-first statt "3 grosse
// Prozentkarten". Kompakte inline Prozentzeile oben, darunter ein grosser,
// breiter Probability-Chart als zentrales Element (dünne Linien, dezentes
// Grid, Perioden-Achse, Tor-Marker direkt im Chart, aktuelle Spielposition
// markiert) - orientiert an dichten Sport-Analytics-Charts, nicht an
// Dashboard-Kacheln. Rein präsentational, bekommt fertige Daten als Props
// (siehe src/liveDemoData.js). Enthält KEINE Berechnungslogik.
// ---------------------------------------------------------------------------
const CHART_W = 800
const CHART_H = 220
const PAD_L = 30
const PAD_R = 10
const PAD_TOP = 10
const PAD_BOTTOM = 24
const Y_TICKS = [0, 25, 50, 75, 100]

function xForMinute(minute, maxMinute) {
  const usable = CHART_W - PAD_L - PAD_R
  return PAD_L + (Math.max(0, Math.min(minute, maxMinute)) / maxMinute) * usable
}
function yForPct(pct) {
  const usable = CHART_H - PAD_TOP - PAD_BOTTOM
  return PAD_TOP + (1 - Math.max(0, Math.min(1, pct))) * usable
}
function buildPolyline(timeline, key, maxMinute) {
  return timeline.map((p) => `${xForMinute(p.minute, maxMinute).toFixed(1)},${yForPct(p[key]).toFixed(1)}`).join(' ')
}
function valueAt(timeline, minute, key) {
  const exact = timeline.find((p) => p.minute === minute)
  if (exact) return exact[key]
  // Letzter bekannter Wert vor diesem Zeitpunkt (Treppenfunktion) - reicht für
  // die Marker-Positionierung im Demo-Chart.
  const before = [...timeline].reverse().find((p) => p.minute <= minute)
  return before ? before[key] : timeline[0][key]
}

export default function LiveWinProbabilityPanel({ homeTeam, awayTeam, probability, probabilityTimeline, events, periodMarkers, maxMinute }) {
  const drawColor = 'var(--text-faint)'
  const goals = events.filter((e) => e.type === 'goal')
  const currentMinute = probabilityTimeline[probabilityTimeline.length - 1].minute

  return (
    <div className="card live-prob-panel">
      <div className="row spread live-prob-head">
        <div className="section-label" style={{ marginBottom: 0 }}>Live Win Probability</div>
        <span className="chip" style={{ color: 'var(--text-dim)', fontSize: 10 }}>UI-Konzept · Demo-Daten</span>
      </div>

      {/* Kompakte inline Prozentzeile statt grosser Kacheln - Wert bleibt
          prominent (grössere Zahl), aber ohne eigene Box/Hintergrundfläche. */}
      <div className="live-prob-inline">
        <span className="live-prob-inline-item" style={{ color: homeTeam.color }}>
          <b>{Math.round(probability.pHome * 100)}%</b> {homeTeam.short}
        </span>
        <span className="live-prob-inline-item muted">
          {Math.round(probability.pDraw * 100)}% Unentschieden
        </span>
        <span className="live-prob-inline-item" style={{ color: awayTeam.color }}>
          {awayTeam.short} <b>{Math.round(probability.pAway * 100)}%</b>
        </span>
      </div>

      <div className="live-chart-wrap">
        <svg className="live-chart" viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none">
          {/* Y-Grid + Achsenbeschriftung */}
          {Y_TICKS.map((t) => (
            <g key={t}>
              <line x1={PAD_L} x2={CHART_W - PAD_R} y1={yForPct(t / 100)} y2={yForPct(t / 100)} className="live-chart-grid-line" />
              <text x={PAD_L - 5} y={yForPct(t / 100) + 3} className="live-chart-y-label">{t}%</text>
            </g>
          ))}

          {/* Perioden-Trennlinien + Labels (3x20' + OT, kein 90'-Raster) */}
          {periodMarkers.map((m) => (
            <line key={m} x1={xForMinute(m, maxMinute)} x2={xForMinute(m, maxMinute)} y1={PAD_TOP} y2={CHART_H - PAD_BOTTOM} className="live-chart-period-line" />
          ))}
          {periodMarkers.slice(0, -1).map((m, i) => {
            const next = periodMarkers[i + 1]
            const mid = xForMinute((m + Math.min(next, maxMinute)) / 2, maxMinute)
            return <text key={'lbl' + m} x={mid} y={CHART_H - 6} className="live-chart-period-label">{i < 3 ? `${i + 1}. Drittel` : 'OT'}</text>
          })}

          {/* Tor-Marker: vertikale Linie durch den ganzen Chart + kurzes
              Label - macht den Probability-Sprung direkt sichtbar. */}
          {goals.map((e, i) => {
            const x = xForMinute(e.minute, maxMinute)
            const color = e.side === 'home' ? homeTeam.color : awayTeam.color
            const shortLabel = `${e.minute}′ ${e.side === 'home' ? homeTeam.short : awayTeam.short}`
            return (
              <g key={i}>
                <line x1={x} x2={x} y1={PAD_TOP} y2={CHART_H - PAD_BOTTOM} className="live-chart-goal-line" style={{ stroke: color }} />
                <text x={x + 3} y={PAD_TOP + 8} className="live-chart-goal-label" style={{ fill: color }} transform={`rotate(-90 ${x + 3} ${PAD_TOP + 8})`}>{shortLabel}</text>
              </g>
            )
          })}

          {/* Aktuelle Spielposition */}
          <line x1={xForMinute(currentMinute, maxMinute)} x2={xForMinute(currentMinute, maxMinute)} y1={PAD_TOP} y2={CHART_H - PAD_BOTTOM} className="live-chart-now-line" />

          {/* Probability-Linien - dünn, keine grossen Flächen */}
          <polyline points={buildPolyline(probabilityTimeline, 'pDraw', maxMinute)} className="live-chart-line draw" />
          <polyline points={buildPolyline(probabilityTimeline, 'pAway', maxMinute)} className="live-chart-line" style={{ stroke: awayTeam.color }} />
          <polyline points={buildPolyline(probabilityTimeline, 'pHome', maxMinute)} className="live-chart-line" style={{ stroke: homeTeam.color }} />

          {/* Punkt "jetzt" auf jeder Linie */}
          {['pHome', 'pDraw', 'pAway'].map((key) => (
            <circle
              key={key}
              cx={xForMinute(currentMinute, maxMinute)}
              cy={yForPct(valueAt(probabilityTimeline, currentMinute, key))}
              r={key === 'pDraw' ? 2 : 3}
              className="live-chart-now-dot"
              style={{ fill: key === 'pHome' ? homeTeam.color : key === 'pAway' ? awayTeam.color : drawColor }}
            />
          ))}

          {/* Tor-Marker-Punkte auf der jeweiligen Linie */}
          {goals.map((e, i) => (
            <circle
              key={'gm' + i}
              cx={xForMinute(e.minute, maxMinute)}
              cy={yForPct(valueAt(probabilityTimeline, e.minute, e.side === 'home' ? 'pHome' : 'pAway'))}
              r={3}
              className="live-chart-goal-marker"
              style={{ fill: e.side === 'home' ? homeTeam.color : awayTeam.color }}
            />
          ))}
        </svg>
        <div className="live-chart-now-tag" style={{ left: `${(xForMinute(currentMinute, maxMinute) / CHART_W) * 100}%` }}>
          <span className="live-chart-now-tag-label">Jetzt</span>
          <span className="live-chart-now-tag-value">{currentMinute}′</span>
        </div>
      </div>

      <div className="legend live-chart-legend">
        <span className="swatch"><span className="sq" style={{ background: homeTeam.color }} /> {homeTeam.short}</span>
        <span className="swatch"><span className="sq" style={{ background: drawColor }} /> Unentschieden</span>
        <span className="swatch"><span className="sq" style={{ background: awayTeam.color }} /> {awayTeam.short}</span>
        <span className="swatch"><span className="sq" style={{ background: 'var(--text-dim)' }} /> Jetzt</span>
      </div>
    </div>
  )
}
