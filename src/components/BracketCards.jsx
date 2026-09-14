import { useState } from 'react'
import { TeamBadge, ProbBar, Delta, Expander } from './ui.jsx'
import { getBaselineRow, deltaPp } from '../baselineStore.js'

const METRICS = [
  { key: 'pChampion', label: 'Meister', caption: 'Wer holt den Titel', color: 'var(--bracket-champion)' },
  { key: 'pTop6', label: 'Direkt Top 6', caption: 'Direkt im Viertelfinal, kein Play-in nötig', color: 'var(--bracket-top6)' },
  { key: 'pPlayoffs', label: 'Playoffs', caption: 'Viertelfinal erreicht (Top 6 + Play-in-Sieger)', color: 'var(--bracket-playoffs)' },
  { key: 'pPlayIn', label: 'Play-in', caption: 'Rang 7-10, kämpft um die letzten 2 VF-Plätze', color: 'var(--bracket-playin)' },
  { key: 'pPlayout1314', label: 'Play-out 13/14', caption: 'Rang 13/14, Abstiegs-Playoff', color: 'var(--bracket-playout)' },
  { key: 'pLigaQualifikation', label: 'Ligaqualifikation', caption: 'Play-out verloren, muss gegen Swiss-League-Meister', color: 'var(--bracket-ligaqual)' },
]

const INITIAL_COUNT = 6

function BracketCard({ metric, rows, compare }) {
  const [expanded, setExpanded] = useState(false)
  const sorted = [...rows].sort((a, b) => b[metric.key] - a[metric.key])
  const visible = expanded ? sorted : sorted.slice(0, INITIAL_COUNT)

  return (
    <div className="card" key={metric.key}>
      <div className="card-pad" style={{ paddingBottom: 8 }}>
        <div className="row gap-sm" style={{ marginBottom: 2 }}>
          <span className="dot" style={{ background: metric.color }} />
          <span style={{ fontWeight: 800, fontSize: 13.5 }}>{metric.label}</span>
        </div>
        <div className="muted" style={{ fontSize: 11.5 }}>{metric.caption}</div>
      </div>
      <div className="bracket-card-list card-pad" style={{ paddingTop: 0 }}>
        {visible.map((row) => {
          const compareRow = getBaselineRow(compare, row.team.id)
          const pp = deltaPp(row[metric.key], compareRow, metric.key)
          return (
            <div key={row.team.id} className="row" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)', gap: 10 }}>
              <div style={{ width: 76, flex: 'none' }}><TeamBadge team={row.team} short /></div>
              <div style={{ flex: 1 }}><ProbBar value={row[metric.key]} color={metric.color} /></div>
              <Delta pp={pp} />
            </div>
          )
        })}
      </div>
      <Expander total={sorted.length} initialCount={INITIAL_COUNT} expanded={expanded} onExpand={() => setExpanded(true)} />
    </div>
  )
}

// Eine Karte je Bracket-Ausgang, Teams je Karte absteigend nach %, mit
// ProbBar + ▲▼-DeltaBadge. `compare` (optional): { rows: [...] } - entweder
// die letzte gespeicherte Tages-Baseline (src/baselineStore.js) oder, im
// WHAT-IF-SIMULATOR, die aktuelle unbedingte Projektion (toComparisonSnapshot()).
export default function BracketCards({ rows, compare }) {
  return (
    <div className="grid grid-3 mb" style={{ gap: 14 }}>
      {METRICS.map((m) => <BracketCard key={m.key} metric={m} rows={rows} compare={compare} />)}
    </div>
  )
}
