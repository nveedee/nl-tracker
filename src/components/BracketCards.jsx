import { TeamBadge, Delta } from './ui.jsx'
import { getBaselineRow, deltaPp } from '../baselineStore.js'

function fmtPct(v) { return v == null ? '–' : (v * 100).toFixed(1) + '%' }

const METRICS = [
  { key: 'pChampion', label: 'Meister' },
  { key: 'pTop6', label: 'Direkt Top 6' },
  { key: 'pPlayoffs', label: 'Playoffs (VF erreicht)' },
  { key: 'pPlayIn', label: 'Play-in' },
  { key: 'pPlayout1314', label: 'Play-out 13/14' },
  { key: 'pLigaQualifikation', label: 'Ligaqualifikation' },
]

// Eine Karte je Bracket-Ausgang, Teams je Karte absteigend nach %, mit
// ▲▼-Delta (Prozentpunkte). `compare` (optional): { rows: [...] } - entweder
// die letzte gespeicherte Tages-Baseline (src/baselineStore.js) oder, im
// WHAT-IF-SIMULATOR, die aktuelle unbedingte Projektion (toComparisonSnapshot()).
export default function BracketCards({ rows, compare }) {
  return (
    <div className="grid grid-3 mb" style={{ gap: 14 }}>
      {METRICS.map((m) => {
        const sorted = [...rows].sort((a, b) => b[m.key] - a[m.key])
        return (
          <div className="card card-pad" key={m.key}>
            <div className="section-label">{m.label}</div>
            <div className="bracket-card-list">
              {sorted.slice(0, 8).map((row) => {
                const compareRow = getBaselineRow(compare, row.team.id)
                const pp = deltaPp(row[m.key], compareRow, m.key)
                return (
                  <div key={row.team.id} className="row spread">
                    <TeamBadge team={row.team} short />
                    <span>
                      <strong style={{ fontFamily: 'var(--mono)' }}>{fmtPct(row[m.key])}</strong>
                      <Delta pp={pp} />
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
