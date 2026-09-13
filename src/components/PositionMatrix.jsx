import { useState } from 'react'
import { TeamBadge, Delta } from './ui.jsx'

// Sequentielle Heatmap-Rampe (eine Farbe, hell -> dunkel; siehe dataviz-Skill
// "Sequential = one hue, light->dark"), aus der bestehenden App-Akzentfarbe
// (--accent #e11d48 / --accent-strong #c81742) abgeleitet statt einer neuen
// Chart-Farbfamilie - die App hat kein Dark Mode, daher keine zweite Rampe
// nötig. Lightness fällt monoton von ~97% (fast surface) auf ~24%; die
// Textfarbe schaltet je Zelle zwischen dunkel/hell um (siehe heatColor).
const HEAT_STOPS = [
  { p: 0.00, rgb: [253, 242, 245] },
  { p: 0.15, rgb: [251, 220, 228] },
  { p: 0.35, rgb: [245, 184, 201] },
  { p: 0.55, rgb: [236, 138, 168] },
  { p: 0.72, rgb: [225, 86, 131] },
  { p: 0.88, rgb: [200, 23, 66] },
  { p: 1.00, rgb: [122, 12, 42] },
]

function heatColor(pct) {
  const p = Math.max(0, Math.min(1, pct))
  let lo = HEAT_STOPS[0]
  let hi = HEAT_STOPS[HEAT_STOPS.length - 1]
  for (let i = 0; i < HEAT_STOPS.length - 1; i++) {
    if (p >= HEAT_STOPS[i].p && p <= HEAT_STOPS[i + 1].p) { lo = HEAT_STOPS[i]; hi = HEAT_STOPS[i + 1]; break }
  }
  const span = hi.p - lo.p || 1
  const t = (p - lo.p) / span
  const [r, g, b] = lo.rgb.map((c, i) => Math.round(c + (hi.rgb[i] - c) * t))
  const relLuma = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return { bg: `rgb(${r},${g},${b})`, fg: relLuma > 0.6 ? 'var(--text)' : '#fff' }
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
  if (!rows.length) return null

  const rankCount = Object.keys(rows[0].rankDistribution).length
  const ranks = Array.from({ length: rankCount }, (_, i) => i + 1)
  const sorted = [...rows].sort((a, b) => a.avgRank - b.avgRank)
  const compareById = compare ? new Map(compare.rows.map((r) => [r.teamId, r])) : null

  return (
    <div className="card mb">
      <div className="card-pad row spread" style={{ paddingBottom: 10 }}>
        <div className="section-label" style={{ margin: 0 }}>Positions-Matrix</div>
        <div className="pill-tabs">
          <button className={mode === 'table' ? 'active' : ''} onClick={() => setMode('table')}>Tabelle</button>
          <button className={mode === 'bars' ? 'active' : ''} onClick={() => setMode('bars')}>Bars</button>
        </div>
      </div>
      <div className="table-wrap">
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
                  const { bg, fg } = heatColor(pct)
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
