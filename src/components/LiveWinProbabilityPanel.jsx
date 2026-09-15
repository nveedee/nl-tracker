// ---------------------------------------------------------------------------
// UI-KONZEPT: Live Win/Draw/Loss Probability - Chart-first mit interaktivem
// Hover/Crosshair. Zeigt beim Bewegen der Maus (Desktop) bzw. per Tap
// (Touch) den NÄCHSTGELEGENEN echten historischen Probability-Snapshot aus
// `probabilityHistory` - niemals eine interpolierte oder erfundene Zahl, und
// niemals die aktuelle ("Jetzt") Probability anstelle des historischen Werts
// (siehe LIVE_PROBABILITY_ANALYSIS.md, Abschnitt "Live Probability Timeline").
//
// `probabilityHistory`: [{ elapsedSeconds, gameTime, homeGoals, awayGoals,
// homeWin, drawAfter60, awayWin, eventType, event? }, ...] - identische
// Struktur, die eine künftige echte SIHF-Live-Anbindung liefern würde (siehe
// src/liveDemoData.js) - keine UI-spezifische Sonderstruktur.
//
// Lokaler Hover-State (useState in dieser Komponente) - Mousemove löst KEIN
// Re-Render der übrigen Seite aus, nur dieser Komponente selbst.
// ---------------------------------------------------------------------------
import { useCallback, useRef, useState } from 'react'

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
function buildPolyline(history, key, maxMinute) {
  return history.map((p) => `${xForMinute(p.elapsedSeconds / 60, maxMinute).toFixed(1)},${yForPct(p[key]).toFixed(1)}`).join(' ')
}
// Nächstgelegenen historischen Snapshot zu einer Ziel-Spielminute finden -
// KEINE Interpolation (Abschnitt 5 der Aufgabenstellung).
function nearestSnapshotIndex(history, minute) {
  const targetSeconds = minute * 60
  let best = 0
  let bestDiff = Infinity
  for (let i = 0; i < history.length; i++) {
    const diff = Math.abs(history[i].elapsedSeconds - targetSeconds)
    if (diff < bestDiff) { bestDiff = diff; best = i }
  }
  return best
}

function ProbTile({ label, value, color }) {
  return (
    <div className="live-prob-tile">
      <div className="live-prob-tile-label" style={{ color }}>{label}</div>
      <div className="live-prob-tile-value">{Math.round(value * 100)}%</div>
    </div>
  )
}

const EVENT_ICON = { GOAL: '⚪', PENALTY: '⏱' }

export default function LiveWinProbabilityPanel({ homeTeam, awayTeam, probability, probabilityHistory, events, periodMarkers, maxMinute, isLive = true }) {
  const drawColor = 'var(--text-faint)'
  const goals = events.filter((e) => e.type === 'goal')
  const currentMinute = probabilityHistory[probabilityHistory.length - 1].elapsedSeconds / 60

  const wrapRef = useRef(null)
  const [hoverIdx, setHoverIdx] = useState(null) // folgt der Maus (Desktop), löscht sich bei mouseleave
  const [pinnedIdx, setPinnedIdx] = useState(null) // per Klick/Tap gesetzt, bleibt bestehen (Touch: einziger Zugang zum Tooltip)
  const activeIdx = hoverIdx ?? pinnedIdx

  const minuteFromClientX = useCallback((clientX) => {
    const el = wrapRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const relX = Math.max(0, Math.min(rect.width, clientX - rect.left))
    const xViewBox = (relX / rect.width) * CHART_W
    const usable = CHART_W - PAD_L - PAD_R
    return ((xViewBox - PAD_L) / usable) * maxMinute
  }, [maxMinute])

  const handleMove = useCallback((e) => {
    const idx = nearestSnapshotIndex(probabilityHistory, minuteFromClientX(e.clientX))
    setHoverIdx((cur) => (cur === idx ? cur : idx))
  }, [probabilityHistory, minuteFromClientX])
  const handleLeave = useCallback(() => setHoverIdx(null), [])
  const handleClick = useCallback((e) => {
    const idx = nearestSnapshotIndex(probabilityHistory, minuteFromClientX(e.clientX))
    setPinnedIdx(idx)
  }, [probabilityHistory, minuteFromClientX])

  const active = activeIdx != null ? probabilityHistory[activeIdx] : null
  const activeMinute = active ? active.elapsedSeconds / 60 : null
  const activeX = active ? (xForMinute(activeMinute, maxMinute) / CHART_W) * 100 : null

  return (
    <div className="card live-prob-panel">
      <div className="row spread live-prob-head">
        <div className="section-label" style={{ marginBottom: 0 }}>Live Win Probability</div>
        <span className="chip" style={{ color: 'var(--text-dim)', fontSize: 10 }}>UI-Konzept · Demo-Daten</span>
      </div>

      {/* "Jetzt" - IMMER der letzte Snapshot, unabhängig vom Hover/Pin. */}
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

      <div
        className="live-chart-wrap"
        ref={wrapRef}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        onClick={handleClick}
      >
        <svg className="live-chart" viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none">
          {Y_TICKS.map((t) => (
            <g key={t}>
              <line x1={PAD_L} x2={CHART_W - PAD_R} y1={yForPct(t / 100)} y2={yForPct(t / 100)} className="live-chart-grid-line" />
              <text x={PAD_L - 5} y={yForPct(t / 100) + 3} className="live-chart-y-label">{t}%</text>
            </g>
          ))}

          {periodMarkers.map((m) => (
            <line key={m} x1={xForMinute(m, maxMinute)} x2={xForMinute(m, maxMinute)} y1={PAD_TOP} y2={CHART_H - PAD_BOTTOM} className="live-chart-period-line" />
          ))}
          {periodMarkers.slice(0, -1).map((m, i) => {
            const next = periodMarkers[i + 1]
            const mid = xForMinute((m + Math.min(next, maxMinute)) / 2, maxMinute)
            return <text key={'lbl' + m} x={mid} y={CHART_H - 6} className="live-chart-period-label">{i < 3 ? `${i + 1}. Drittel` : 'OT'}</text>
          })}

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

          <line x1={xForMinute(currentMinute, maxMinute)} x2={xForMinute(currentMinute, maxMinute)} y1={PAD_TOP} y2={CHART_H - PAD_BOTTOM} className="live-chart-now-line" />

          <polyline points={buildPolyline(probabilityHistory, 'drawAfter60', maxMinute)} className="live-chart-line draw" />
          <polyline points={buildPolyline(probabilityHistory, 'awayWin', maxMinute)} className="live-chart-line" style={{ stroke: awayTeam.color }} />
          <polyline points={buildPolyline(probabilityHistory, 'homeWin', maxMinute)} className="live-chart-line" style={{ stroke: homeTeam.color }} />

          {/* Statische "Jetzt"-Punkte auf Draw/Away - der Home-Punkt (unten)
              trägt zusätzlich den pulsierenden LIVE-Marker (Abschnitt 9 der
              Aufgabenstellung: gemeinsamer vertikaler NOW-Marker über alle
              drei Linien + ein hervorgehobener Punkt für den aktuellen
              Zustand). Position IMMER aus dem letzten echten Snapshot
              (probabilityHistory[length-1]), nie an eine feste Minute
              gebunden - wandert bei jedem neuen Snapshot automatisch mit. */}
          {['drawAfter60', 'awayWin'].map((key) => (
            <circle
              key={key}
              cx={xForMinute(currentMinute, maxMinute)}
              cy={yForPct(probabilityHistory[probabilityHistory.length - 1][key])}
              r={key === 'drawAfter60' ? 2 : 3}
              className="live-chart-now-dot"
              style={{ fill: key === 'awayWin' ? awayTeam.color : drawColor }}
            />
          ))}

          {(() => {
            const nowX = xForMinute(currentMinute, maxMinute)
            const nowY = yForPct(probabilityHistory[probabilityHistory.length - 1].homeWin)
            return (
              <g className={isLive ? 'live-now-marker live-pulsing' : 'live-now-marker'}>
                {isLive && <circle cx={nowX} cy={nowY} r={4} className="live-now-pulse-ring" style={{ stroke: homeTeam.color }} />}
                <circle cx={nowX} cy={nowY} r={3.5} className="live-now-core" style={{ fill: homeTeam.color }} />
                {isLive && (
                  <text x={nowX + 7} y={nowY - 7} className="live-now-label">LIVE</text>
                )}
              </g>
            )
          })()}

          {goals.map((e, i) => {
            const snap = probabilityHistory[nearestSnapshotIndex(probabilityHistory, e.minute)]
            return (
              <circle
                key={'gm' + i}
                cx={xForMinute(e.minute, maxMinute)}
                cy={yForPct(snap[e.side === 'home' ? 'homeWin' : 'awayWin'])}
                r={5}
                className="live-chart-goal-marker"
                style={{ fill: e.side === 'home' ? homeTeam.color : awayTeam.color }}
              />
            )
          })}

          {/* Hover-/Tap-Crosshair - zeigt den nächstgelegenen ECHTEN Snapshot,
              nie eine interpolierte Zahl (siehe nearestSnapshotIndex()). */}
          {active && (
            <g className="live-chart-crosshair">
              <line x1={xForMinute(activeMinute, maxMinute)} x2={xForMinute(activeMinute, maxMinute)} y1={PAD_TOP} y2={CHART_H - PAD_BOTTOM} />
              {['homeWin', 'drawAfter60', 'awayWin'].map((key) => (
                <circle
                  key={'hover-' + key}
                  cx={xForMinute(activeMinute, maxMinute)}
                  cy={yForPct(active[key])}
                  r={key === 'drawAfter60' ? 3 : 4}
                  style={{ fill: key === 'homeWin' ? homeTeam.color : key === 'awayWin' ? awayTeam.color : drawColor }}
                />
              ))}
            </g>
          )}
        </svg>

        <div className="live-chart-now-tag" style={{ left: `${(xForMinute(currentMinute, maxMinute) / CHART_W) * 100}%` }}>
          <span className="live-chart-now-tag-label">Jetzt</span>
          <span className="live-chart-now-tag-value">{Math.round(currentMinute)}′</span>
        </div>

        {active && (
          <div
            className="live-chart-tooltip"
            style={{
              left: `${activeX}%`,
              transform: activeX > 65 ? 'translateX(-100%)' : activeX < 8 ? 'translateX(0)' : 'translateX(-50%)',
            }}
          >
            <div className="live-chart-tooltip-time">
              {active.gameTime}
              {active.event && (
                <span className="live-chart-tooltip-event">
                  {EVENT_ICON[active.eventType] || ''} {active.event.side === 'home' ? homeTeam.short : awayTeam.short}
                </span>
              )}
            </div>
            <div className="live-chart-tooltip-row"><span className="dot" style={{ background: homeTeam.color }} />{homeTeam.short}<b>{(active.homeWin * 100).toFixed(1)}%</b></div>
            <div className="live-chart-tooltip-row"><span className="dot" style={{ background: drawColor }} />Unentschieden<b>{(active.drawAfter60 * 100).toFixed(1)}%</b></div>
            <div className="live-chart-tooltip-row"><span className="dot" style={{ background: awayTeam.color }} />{awayTeam.short}<b>{(active.awayWin * 100).toFixed(1)}%</b></div>
            <div className="live-chart-tooltip-score">Score <b>{active.homeGoals} : {active.awayGoals}</b></div>
          </div>
        )}
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
