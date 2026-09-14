import { useState, useMemo } from 'react'
import { getBaselineHistory, getBaselineRow } from '../baselineStore.js'

const METRICS = [
  { key: 'pChampion', label: 'Meister-%' },
  { key: 'pTop6', label: 'Direkt Top 6-%' },
  { key: 'pPlayoffs', label: 'Playoffs-%' },
  { key: 'pPlayIn', label: 'Play-in-%' },
  { key: 'pPlayout1314', label: 'Play-out 13/14-%' },
  { key: 'pLigaQualifikation', label: 'Ligaqualifikation-%' },
]

const W = 780, H = 300, PAD_L = 34, PAD_R = 12, PAD_T = 12, PAD_B = 26

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })
}

// Ein Datenpunkt pro Spieltag (Tages-Baseline, src/baselineStore.js), eine
// Linie pro Team, wählbare Kennzahl. Farben = die bereits app-weit für jedes
// Team verwendete team.color (TeamBadge-Punkte etc.) statt einer neuen
// Kategorie-Palette - bei 14 Serien wäre eine feste 8er-Palette ohnehin nicht
// ausreichend/konsistent zuordenbar (siehe dataviz-Skill: "fold into small
// multiples" ist hier keine Option, da alle 14 Teams gleichzeitig relevant
// sind); stattdessen Hover-Highlight über die Legende, um einzelne Linien
// aus dem "Spaghetti" herauszuheben. Kein Crosshair/Tooltip pro Punkt (bewusst
// vereinfacht) - Werte sind über die Bracket-Karten/Positions-Matrix mit
// exakten Zahlen einsehbar, dieser Chart zeigt den TREND.
export default function SeasonEvolution({ teams }) {
  const [metric, setMetric] = useState('pChampion')
  const [hoverTeam, setHoverTeam] = useState(null)
  const history = useMemo(() => getBaselineHistory(), [])

  if (history.length < 2) {
    return (
      <div className="card card-pad mb">
        <div className="section-label">Season-Evolution</div>
        <div className="muted" style={{ fontSize: 12.5 }}>
          Noch zu wenig Historie ({history.length} {history.length === 1 ? 'Spieltag' : 'Spieltage'}) für ein Diagramm -
          baut sich täglich mit der ersten Simulation des Tages auf. Nicht rückwirkend verfügbar, die Historie beginnt erst ab jetzt.
        </div>
      </div>
    )
  }

  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const xFor = (i) => PAD_L + (history.length === 1 ? 0 : (innerW * i) / (history.length - 1))
  const yFor = (v) => PAD_T + innerH - v * innerH

  const lines = teams.map((t) => {
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
      <div className="row spread wrap" style={{ marginBottom: 4, gap: 10 }}>
        <div className="section-label" style={{ margin: 0 }}>Season-Evolution</div>
        <select value={metric} onChange={(e) => setMetric(e.target.value)} style={{ width: 'auto' }}>
          {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      </div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
        Ein Datenpunkt pro Spieltag (erste Simulation des Tages) · {history.length} Spieltage erfasst · nicht rückwirkend, Historie beginnt ab jetzt
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={PAD_L} x2={W - PAD_R} y1={yFor(f)} y2={yFor(f)} stroke="var(--border)" strokeWidth="1" />
            <text x={PAD_L - 6} y={yFor(f) + 3} textAnchor="end" fontSize="10" fill="var(--text-faint)">{Math.round(f * 100)}%</text>
          </g>
        ))}
        {history.map((h, i) => (
          (i === 0 || i === history.length - 1 || i === Math.floor(history.length / 2)) && (
            <text key={h.date} x={xFor(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--text-faint)">{fmtDate(h.date)}</text>
          )
        ))}
        {lines.map(({ team, segments }) => (
          <g key={team.id} opacity={hoverTeam && hoverTeam !== team.id ? 0.12 : 1}>
            {segments.map((seg, si) => (
              <path
                key={si}
                d={'M ' + seg.map((p) => p.join(',')).join(' L ')}
                fill="none"
                stroke={team.color}
                strokeWidth={hoverTeam === team.id ? 3 : 1.75}
              />
            ))}
          </g>
        ))}
      </svg>
      <div className="row wrap gap-sm" style={{ marginTop: 10 }}>
        {teams.map((t) => (
          <span
            key={t.id}
            className="chip"
            style={{ cursor: 'pointer', opacity: hoverTeam && hoverTeam !== t.id ? 0.5 : 1 }}
            onMouseEnter={() => setHoverTeam(t.id)}
            onMouseLeave={() => setHoverTeam(null)}
          >
            <span className="dot" style={{ background: t.color }} />{t.short}
          </span>
        ))}
      </div>
    </div>
  )
}
