import { useEffect, useState } from 'react'
import { TeamBadge, Delta, SectionHeader, Legend, useScrollFade } from './ui.jsx'

const HEAT_STEPS = [0, 0.15, 0.35, 0.55, 0.72, 0.88, 1]

// Liest die 7 --heat-N-Variablen aus styles.css (Light- ODER Dark-Werte, je
// nach aktivem Farbschema) - so folgt die Heatmap automatisch dem Dark Mode
// (prefers-color-scheme), ohne die Rampe hier zu duplizieren. Wird einmal
// beim Mount gelesen und bei einem Farbschema-Wechsel neu gelesen.
function useHeatStops() {
  const [stops, setStops] = useState(null)
  useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement)
      setStops(HEAT_STEPS.map((p, i) => ({
        p,
        rgb: cs.getPropertyValue(`--heat-${i}`).trim().split(',').map((n) => parseInt(n, 10)),
      })))
    }
    read()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', read)
    return () => mq.removeEventListener('change', read)
  }, [])
  return stops
}

function heatColor(stops, pct) {
  const p = Math.max(0, Math.min(1, pct))
  let lo = stops[0]
  let hi = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) {
    if (p >= stops[i].p && p <= stops[i + 1].p) { lo = stops[i]; hi = stops[i + 1]; break }
  }
  const span = hi.p - lo.p || 1
  const t = (p - lo.p) / span
  const [r, g, b] = lo.rgb.map((c, i) => Math.round(c + (hi.rgb[i] - c) * t))
  const relLuma = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return { bg: `rgb(${r},${g},${b})`, fg: relLuma > 0.55 ? 'var(--text)' : '#fff' }
}

// Zeilen = Teams, Spalten = Rang 1..14, Zelle = P(finalRank=Spalte). Zwei
// Ansichten: "Tabelle" (Heatmap-Zahlen) und "Bars" (vertikale Mini-Balken je
// Zelle, eine feste Farbe - die Höhe trägt hier die Grösse, nicht zusätzlich
// die Farbintensität, um die Grösse nicht doppelt zu codieren).
// `compare` (optional): { rows: [{ teamId, avgRank }] } - z.B. via
// src/baselineStore.js::toComparisonSnapshot() aus der aktuellen unbedingten
// Projektion (WHAT-IF-SIMULATOR) oder der Tages-Baseline. Zeigt eine
// zusätzliche Δ-Spalte für Ø-Rang.
export default function PositionMatrix({ rows, runs, compare }) {
  const [mode, setMode] = useState('table')
  const stops = useHeatStops()
  const wrapRef = useScrollFade()
  if (!rows.length) return null

  const rankCount = Object.keys(rows[0].rankDistribution).length
  const ranks = Array.from({ length: rankCount }, (_, i) => i + 1)
  const sorted = [...rows].sort((a, b) => a.avgRank - b.avgRank)
  const compareById = compare ? new Map(compare.rows.map((r) => [r.teamId, r])) : null

  return (
    <div className="card mb">
      <div className="card-pad" style={{ paddingBottom: 10 }}>
        <SectionHeader
          title="Positions-Matrix"
          caption="Für jedes Team die Wahrscheinlichkeit, in genau diesem Rang die Saison zu beenden."
          action={
            <div className="pill-tabs">
              <button className={mode === 'table' ? 'active' : ''} onClick={() => setMode('table')}>Tabelle</button>
              <button className={mode === 'bars' ? 'active' : ''} onClick={() => setMode('bars')}>Bars</button>
            </div>
          }
        />
        {mode === 'table' && stops && (
          <Legend scale={{ fromLabel: '0%', toLabel: '100%', stops: stops.map((s) => `rgb(${s.rgb.join(',')})`) }} />
        )}
      </div>
      <div className="table-wrap pin-first" ref={wrapRef}>
        <table className="matrix-table">
          <thead>
            <tr>
              <th className="left">Team</th>
              {ranks.map((r) => <th key={r} className="num">{r}</th>)}
              <th className="num">Ø-Rang</th>
              {compare && <th className="num">Δ</th>}
              <th className="num">Median</th>
              <th className="num">σ</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const c = compareById?.get(row.team.id)
              const rankDelta = c ? row.avgRank - c.avgRank : null
              return (
              <tr key={row.team.id}>
                <td className="left"><TeamBadge team={row.team} short /></td>
                {ranks.map((r) => {
                  const pct = (row.rankDistribution[r] || 0) / runs
                  if (mode === 'bars') {
                    return (
                      <td key={r} className="matrix-bar-cell" title={`Rang ${r}: ${(pct * 100).toFixed(1)}%`}>
                        <div className="matrix-bar-track">
                          <div className="matrix-bar-fill" style={{ height: `${Math.min(pct * 100, 100)}%` }} />
                        </div>
                      </td>
                    )
                  }
                  const { bg, fg } = stops ? heatColor(stops, pct) : { bg: 'var(--bg-elev-2)', fg: 'var(--text)' }
                  return (
                    <td key={r} className="num matrix-cell" style={{ background: bg, color: fg }} title={`Rang ${r}: ${(pct * 100).toFixed(1)}%`}>
                      {pct > 0.005 ? Math.round(pct * 100) : ''}
                    </td>
                  )
                })}
                <td className="num">{row.avgRank.toFixed(1)}</td>
                {compare && <td className="num"><Delta pp={rankDelta} unit="" digits={2} /></td>}
                <td className="num">{row.medianRank}</td>
                <td className="num muted">{row.stdDevRank.toFixed(1)}</td>
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
