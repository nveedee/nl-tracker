import { SectionHeader } from './ui.jsx'
import {
  GOAL_DIST_BUCKET_COUNT, distributionLabel, maxDistributionValue, cellIntensity,
} from '../scorelineMatrix.js'

const INDICES = Array.from({ length: GOAL_DIST_BUCKET_COUNT }, (_, i) => i)

function fmtPct(prob) {
  const pct = prob * 100
  if (pct <= 0) return '0%'
  if (pct < 0.05) return '<0.1%'
  return pct.toFixed(1) + '%'
}

// Goal Probabilities by Team (%) - P(Team erzielt genau h Tore), 0..5,6+
// (Hockey-typisch höher aufgelöst als die Scoreline-Matrix, siehe Auftrag).
// Kleine horizontale Bars statt Tabellenzahlen, Teamfarbe pro Spalte, keine
// eigene Wahrscheinlichkeitsberechnung - `homeDistribution`/
// `awayDistribution` kommen 1:1 aus scorelineMatrix.js::buildGoalDistribution(),
// gespeist von denselben Läufen wie Scoreline-Matrix/Expected Goals.
export default function GoalProbabilities({ homeTeam, awayTeam, homeDistribution, awayDistribution }) {
  if (!homeDistribution || !awayDistribution || !homeTeam || !awayTeam) return null
  if (homeDistribution.totalRuns === 0 || awayDistribution.totalRuns === 0) return null

  const homeMax = maxDistributionValue(homeDistribution.distribution)
  const awayMax = maxDistributionValue(awayDistribution.distribution)

  return (
    <div className="card card-pad mb">
      <SectionHeader title="Goal Probabilities by Team (%)" caption="Wahrscheinlichkeit für genau X Tore" />
      <div className="gp-head">
        <span />
        <span className="gp-head-team" style={{ color: homeTeam.color }}>{homeTeam.short}</span>
        <span className="gp-head-team" style={{ color: awayTeam.color }}>{awayTeam.short}</span>
      </div>
      {INDICES.map((i) => {
        const hp = homeDistribution.distribution[i]
        const ap = awayDistribution.distribution[i]
        return (
          <div className="gp-row" key={i}>
            <span className="gp-bucket">{distributionLabel(i)}</span>
            <span className="gp-bar-cell" title={`${homeTeam.name}: ${(hp * 100).toFixed(2)}%`}>
              <span className="gp-bar-track">
                <span className="gp-bar-fill" style={{ width: `${cellIntensity(hp, homeMax) * 100}%`, background: homeTeam.color }} />
              </span>
              <span className="gp-pct">{fmtPct(hp)}</span>
            </span>
            <span className="gp-bar-cell" title={`${awayTeam.name}: ${(ap * 100).toFixed(2)}%`}>
              <span className="gp-bar-track">
                <span className="gp-bar-fill" style={{ width: `${cellIntensity(ap, awayMax) * 100}%`, background: awayTeam.color }} />
              </span>
              <span className="gp-pct">{fmtPct(ap)}</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}
