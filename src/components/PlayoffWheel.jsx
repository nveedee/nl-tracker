import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { SectionHeader } from './ui.jsx'
import { buildWheelLayout, sectorPath, polarToCartesian, RING_LEVELS } from '../wheelGeometry.js'

// Playoff Probability Wheel (MoneyPuck-artige radiale Visualisierung):
// EIN gemeinsamer Kreis statt Balkentabelle - jedes Team bekommt einen
// eigenen radialen Sektor (Tortenstück), dessen Reichweite die
// Viertelfinal-Wahrscheinlichkeit abbildet. Halbfinal/Final sind als
// zusätzliche, kürzere Zonen DERSELBEN Teamfarbe innerhalb desselben
// Sektors übereinandergelegt (höhere Deckkraft je weiter innen) - das
// Zentrum repräsentiert so die Final-Chance, der äussere Rand die
// Viertelfinal-Chance. Reine Geometrie liegt in src/wheelGeometry.js
// (getestet, DOM-unabhängig) - diese Komponente ist nur noch Rendering +
// Hover/Tap-Interaktion.
const SIZE = 340
const CENTER = SIZE / 2
const MAX_RADIUS = 106
const LOGO_RADIUS = MAX_RADIUS + 27
const LOGO_R = 15.5

function fmtPct(v) {
  if (v == null) return '–'
  const pct = v * 100
  return (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%'
}

export default function PlayoffWheel({ rows, updatedLabel }) {
  const [activeId, setActiveId] = useState(null)

  const teams = useMemo(() => rows.map((r) => r.team), [rows])
  const probsByTeamId = useMemo(() => new Map(rows.map((r) => [r.team.id, r])), [rows])
  // Bei vielen Teams (aktuell 14) etwas schmalere Lücke, damit jeder Sektor
  // trotzdem breit genug für eine gut lesbare Fläche bleibt.
  const gapDeg = teams.length > 10 ? 3 : 5
  const layout = useMemo(
    () => buildWheelLayout(teams, probsByTeamId, { maxRadius: MAX_RADIUS, gapDeg }),
    [teams, probsByTeamId, gapDeg]
  )

  const active = layout.find((e) => e.team.id === activeId) || null
  // Hover (Desktop) UND Tap (Mobile) setzen denselben State - bewusst kein
  // Toggle auf Klick: ein Klick folgt auf dem Desktop immer schon auf einen
  // vorherigen onMouseEnter (derselbe Team-State ist also bereits aktiv) -
  // ein Toggle würde die Auswahl dadurch sofort wieder auf null zurückklappen.
  // Verlassen wird der State nur, wenn der Zeiger das GESAMTE Wheel-SVG
  // verlässt (nicht pro Sektor) - sonst würde jeder Wechsel zwischen zwei
  // benachbarten Sektoren kurz "durchblinken".
  const select = (id) => setActiveId(id)

  return (
    <div className="playoff-wheel-card mb">
      <SectionHeader
        title="Playoff-Chancen"
        caption={`Wahrscheinlichkeit, die jeweilige Runde zu erreichen${updatedLabel ? ` · ${updatedLabel}` : ''}.`}
        action={<Link className="btn ghost sm" to="/playoff-odds">Alle →</Link>}
      />

      <div className="wheel-wrap">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="wheel-svg"
          role="img"
          aria-label="Playoff-Wahrscheinlichkeiten aller Teams als radiales Diagramm"
          onMouseLeave={() => setActiveId(null)}
        >
          <g className="wheel-rings">
            {RING_LEVELS.map((lvl) => (
              <circle key={lvl} cx={CENTER} cy={CENTER} r={lvl * MAX_RADIUS} />
            ))}
          </g>

          {layout.map((entry) => {
            const dim = activeId && entry.team.id !== activeId
            return (
              <g
                key={entry.team.id}
                className={`wheel-sector${dim ? ' dim' : ''}`}
                onMouseEnter={() => select(entry.team.id)}
                onClick={() => select(entry.team.id)}
              >
                <title>
                  {`${entry.team.name} — Viertelfinal ${fmtPct(entry.pPlayoffs)}, Halbfinal ${fmtPct(entry.pSemifinal)}, Final ${fmtPct(entry.pFinal)}`}
                </title>
                <path d={sectorPath(CENTER, CENTER, entry.rQF, entry.startAngle, entry.endAngle)} fill={entry.team.color} opacity={0.3} />
                <path d={sectorPath(CENTER, CENTER, entry.rSF, entry.startAngle, entry.endAngle)} fill={entry.team.color} opacity={0.62} />
                <path d={sectorPath(CENTER, CENTER, entry.rFinal, entry.startAngle, entry.endAngle)} fill={entry.team.color} opacity={1} />
              </g>
            )
          })}

          <g className="wheel-ring-labels">
            {RING_LEVELS.map((lvl) => (
              <text key={lvl} x={CENTER + 3} y={CENTER - lvl * MAX_RADIUS + 2.5}>{Math.round(lvl * 100)}%</text>
            ))}
          </g>

          {layout.map((entry) => {
            const pos = polarToCartesian(CENTER, CENTER, LOGO_RADIUS, entry.midAngle)
            const isActive = entry.team.id === activeId
            const dim = activeId && !isActive
            return (
              <g
                key={`logo-${entry.team.id}`}
                transform={`translate(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)})`}
                className={`wheel-logo${isActive ? ' active' : ''}${dim ? ' dim' : ''}`}
                onMouseEnter={() => select(entry.team.id)}
                onClick={() => select(entry.team.id)}
              >
                {/* Grösserer, unsichtbarer Trefferbereich - das sichtbare
                    Badge bleibt kompakt, der Tap-Bereich ist trotzdem
                    komfortabel (~44px Kantenlänge, Apple-HIG-Richtwert). */}
                <circle r={LOGO_R + 6} fill="transparent" />
                <circle r={LOGO_R} style={{ stroke: entry.team.color }} />
                <text dy={3}>{entry.team.short}</text>
              </g>
            )
          })}
        </svg>
      </div>

      <div className="wheel-legend">
        <span><i className="wheel-legend-dot" style={{ opacity: 0.3 }} />Viertelfinal</span>
        <span><i className="wheel-legend-dot" style={{ opacity: 0.62 }} />Halbfinal</span>
        <span><i className="wheel-legend-dot" style={{ opacity: 1 }} />Final</span>
      </div>

      <div className="wheel-info">
        {active ? (
          <>
            <div className="wheel-info-head">
              <span className="dot" style={{ background: active.team.color }} />
              <strong>{active.team.name}</strong>
            </div>
            <div className="wheel-info-rows">
              <span>Viertelfinal <b>{fmtPct(active.pPlayoffs)}</b></span>
              <span>Halbfinal <b>{fmtPct(active.pSemifinal)}</b></span>
              <span>Final <b>{fmtPct(active.pFinal)}</b></span>
            </div>
            <Link className="btn ghost sm" to="/playoff-odds">Details →</Link>
          </>
        ) : (
          <span className="muted">Team antippen oder hovern für Details.</span>
        )}
      </div>
    </div>
  )
}
