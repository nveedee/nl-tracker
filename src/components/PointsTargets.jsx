import { useMemo } from 'react'
import { TeamBadge, SectionHeader } from './ui.jsx'
import { computePointsTargets, POINTS_CONFIDENCE_LEVELS, POINTS_TARGET_CATEGORIES } from '../playoffSim.js'

// "X Punkte = sicher": kleinste Punktzahl, ab der ein Team (bedingt auf einen
// finalen Punktestand ±2, siehe computePointsTargets()) das jeweilige Ziel in
// 50/75/90/99% der Läufe erreicht (bzw. bei "Play-out vermeiden" nicht in den
// Play-out rutscht). "–" wenn keine simulierte Punktzahl die Konfidenz erreicht.
export default function PointsTargets({ baseResults }) {
  const targets = useMemo(() => computePointsTargets(baseResults), [baseResults])
  if (!targets.length) return null

  return (
    <div className="grid grid-3 mb" style={{ gap: 14 }}>
      {POINTS_TARGET_CATEGORIES.map((cat) => (
        <div className="card" key={cat.key}>
          <div className="card-pad" style={{ paddingBottom: 8 }}>
            <SectionHeader title={cat.label} caption="Punktzahl, ab der das Ziel bei diesem Punktestand erreicht wird." />
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="left">Team</th>
                  {POINTS_CONFIDENCE_LEVELS.map((l) => <th key={l} className="num">{Math.round(l * 100)}%</th>)}
                </tr>
              </thead>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.team.id}>
                    <td className="left"><TeamBadge team={t.team} short /></td>
                    {POINTS_CONFIDENCE_LEVELS.map((l) => (
                      <td key={l} className="num">
                        {t.targets[cat.key][l] != null ? t.targets[cat.key][l] : <span className="muted">–</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}
