import { useState, useMemo, useEffect } from 'react'
import { getBaselineHistory, getBaselineRow } from '../baselineStore.js'
import { SectionHeader } from './ui.jsx'

const METRICS = [
  { key: 'pChampion', label: 'Meister-%' },
  { key: 'pTop6', label: 'Direkt Top 6-%' },
  { key: 'pPlayoffs', label: 'Playoffs-%' },
  { key: 'pPlayIn', label: 'Play-in-%' },
  { key: 'pPlayout1314', label: 'Play-out 13/14-%' },
  { key: 'pLigaQualifikation', label: 'Ligaqualifikation-%' },
]

const DEFAULT_TOP_N = 5
const W = 780, H = 260, PAD_L = 32, PAD_R = 10, PAD_T = 10, PAD_B = 22

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })
}

// Ein Datenpunkt pro Spieltag (Tages-Baseline, src/baselineStore.js), eine
// Linie pro Team, wählbare Kennzahl. Farben = die bereits app-weite
// team.color (TeamBadge-Punkte etc.) statt einer neuen Kategorie-Palette -
// bei 14 Serien wäre eine feste 8er-Palette ohnehin nicht ausreichend. Um das
// "Spaghetti" auf dem Handy vermeidbar zu machen: standardmässig nur die
// Top-N-Teams nach aktuellem Wert der gewählten Kennzahl, alle anderen per
// Tap auf ihren Legenden-Chip zuschaltbar (Chip = Toggle, nicht nur Hover -
// funktioniert damit auch ohne Maus). Kein Crosshair/Tooltip pro Punkt
// (bewusst vereinfacht) - exakte Werte stehen in den Bracket-Karten/der
// Positions-Matrix, dieser Chart zeigt den TREND.
export default function SeasonEvolution({ teams }) {
  const [metric, setMetric] = useState('pChampion')
  const [visible, setVisible] = useState(null) // Set<teamId> | null (= noch nicht initialisiert)
  const history = useMemo(() => getBaselineHistory(), [])

  const lastValueByTeam = useMemo(() => {
    if (history.length === 0) return new Map()
    const last = history[history.length - 1]
    return new Map(teams.map((t) => [t.id, getBaselineRow(last, t.id)?.[metric] ?? -1]))
  }, [teams, history, metric])

  // Bei Kennzahl-Wechsel auf die neuen Top-N zurücksetzen - "interessant" ist
  // metrikabhängig (Top6-Favoriten sind nicht dieselben wie Ligaqualifikations-Kandidaten).
  useEffect(() => {
    const topN = [...lastValueByTeam.entries()].sort((a, b) => b[1] - a[1]).slice(0, DEFAULT_TOP_N).map(([id]) => id)
    setVisible(new Set(topN))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metric])

  if (history.length < 2) {
    return (
      <div className="card card-pad mb">
        <SectionHeader title="Season-Evolution" caption="Bracket-Wahrscheinlichkeiten je Team über die Spieltage." />
        <div className="muted" style={{ fontSize: 12.5 }}>
          Noch zu wenig Historie ({history.length} {history.length === 1 ? 'Spieltag' : 'Spieltage'}) für ein Diagramm -
          baut sich täglich mit der ersten Simulation des Tages auf. Nicht rückwirkend verfügbar, die Historie beginnt erst ab jetzt.
        </div>
      </div>
    )
  }
  if (!visible) return null // erster Render vor dem Top-N-Effect

  const toggleTeam = (id) => {
    setVisible((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const xFor = (i) => PAD_L + (history.length === 1 ? 0 : (innerW * i) / (history.length - 1))
  const yFor = (v) => PAD_T + innerH - v * innerH

  const lines = teams.filter((t) => visible.has(t.id)).map((t) => {
    const points = history.map((h, i) => {
      const row = getBaselineRow(h, t.id)
      return row && row[metric] != null ? [xFor(i), yFor(row[metric])] : null
    })
    // Nur zusammenhängende bekannte Punkte verbinden (z.B. falls ein Team
    // später zum Datenmodell hinzukam - keine erfundene Interpolation).
    const segments = []
    let current = []
    for (const p of points) {
      if (p) current.push(p)
      else { if (current.length > 1) segments.push(current); current = [] }
    }
    if (current.length > 1) segments.push(current)
    return { team: t, segments }
  })

  return (
    <div className="card card-pad mb">
      <SectionHeader
        title="Season-Evolution"
        caption={`Ein Datenpunkt pro Spieltag · ${history.length} erfasst · nicht rückwirkend, Historie beginnt ab jetzt`}
        action={
          <select value={metric} onChange={(e) => setMetric(e.target.value)} style={{ width: 'auto' }}>
            {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        }
      />
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', marginTop: 8 }}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD_L} x2={W - PAD_R} y1={yFor(f)} y2={yFor(f)} stroke="var(--border)" strokeWidth="1" />
            <text x={PAD_L - 6} y={yFor(f) + 3} textAnchor="end" fontSize="10" fill="var(--text-faint)">{Math.round(f * 100)}%</text>
          </g>
        ))}
        {history.map((h, i) => (
          (i === 0 || i === history.length - 1) && (
            <text key={h.date} x={xFor(i)} y={H - 6} textAnchor={i === 0 ? 'start' : 'end'} fontSize="10" fill="var(--text-faint)">{fmtDate(h.date)}</text>
          )
        ))}
        {lines.map(({ team, segments }) => (
          <g key={team.id}>
            {segments.map((seg, si) => (
              <path key={si} d={'M ' + seg.map((p) => p.join(',')).join(' L ')} fill="none" stroke={team.color} strokeWidth="2" />
            ))}
          </g>
        ))}
      </svg>
      <div className="row wrap gap-sm" style={{ marginTop: 12 }}>
        {teams.map((t) => {
          const on = visible.has(t.id)
          return (
            <button
              key={t.id}
              className="chip"
              style={{ cursor: 'pointer', border: '1px solid ' + (on ? t.color : 'var(--border)'), opacity: on ? 1 : 0.55 }}
              onClick={() => toggleTeam(t.id)}
            >
              <span className="dot" style={{ background: t.color }} />{t.short}
            </button>
          )
        })}
      </div>
    </div>
  )
}
