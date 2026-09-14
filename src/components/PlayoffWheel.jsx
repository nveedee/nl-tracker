import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { SectionHeader } from './ui.jsx'
import { buildWheelLayout, sectorPath, polarToCartesian, RING_LEVELS } from '../wheelGeometry.js'

// Playoff Probability Wheel (MoneyPuck-artige radiale Visualisierung):
// EIN gemeinsamer Kreis statt Balkentabelle - jedes Team bekommt einen
// eigenen radialen Sektor, dessen WINKELBREITE proportional zu seiner
// P(Viertelfinal) ist (stärkere Teams = breiterer Sektor, normalisiert auf
// 360° über alle Teams - siehe wheelGeometry.js/buildWheelLayout()). Die
// vier kumulativen Playoff-Stufen (Viertelfinal/Halbfinal/Final/Meister)
// sind zusätzlich kürzere, stärker gesättigte RADIALE Zonen DERSELBEN
// Teamfarbe innerhalb desselben Sektors übereinandergelegt - das Zentrum
// repräsentiert so die Meister-Chance, der äussere Rand die Viertelfinal-
// Chance. Zwei unabhängige Kodierungen derselben Daten: WINKEL = normierte
// P(QF) relativ zu allen Teams, RADIUS = direkte P(je Runde) dieses Teams
// (siehe wheelGeometry.js/.test.js für die Herleitung/Invarianten). Reine
// Geometrie liegt in src/wheelGeometry.js (getestet, DOM-unabhängig) -
// diese Komponente ist nur noch Rendering + Hover/Tap-Interaktion.
const SIZE = 340
const CENTER = SIZE / 2
const MAX_RADIUS = 106
const LOGO_RADIUS = MAX_RADIUS + 27
const LOGO_R_MAX = 15.5
// Untere Grenze, mit MIN_VISUAL_ANGLE_DEG (wheelGeometry.js) abgestimmt:
// im ungünstigsten Fall (zwei Mindestwinkel-Teams direkt nebeneinander,
// Abstand = MIN_VISUAL_ANGLE_DEG) berechnet logoR unten von selbst einen
// Wert nahe diesem Minimum - LOGO_R_MIN dient nur als Absicherung nach
// unten, damit auch bei noch dichteren Konstellationen kein Text
// unleserlich klein wird (Logos dürfen sich dafür in extremen Rand-
// fällen minimal berühren, statt komplett zu verschwinden).
const LOGO_R_MIN = 9
const LOGO_FONT_MAX = 8.2

// Vier kumulative Stufen, aussen -> innen (grösster -> kleinster Radius).
// Deckkraft steigt nach innen (Meister am kräftigsten/dunkelsten) - dieselbe
// Teamfarbe für alle vier Stufen, nur die Opazität unterscheidet sie.
const STAGES = [
  { key: 'pPlayoffs', label: 'Viertelfinal', short: 'VF', opacity: 0.22 },
  { key: 'pSemifinal', label: 'Halbfinal', short: 'HF', opacity: 0.48 },
  { key: 'pFinal', label: 'Final', short: 'F', opacity: 0.74 },
  { key: 'pChampion', label: 'Meister', short: 'M', opacity: 1 },
]
const RADIUS_KEY = { pPlayoffs: 'rQF', pSemifinal: 'rSF', pFinal: 'rFinal', pChampion: 'rCup' }

function fmtPct(v) {
  if (v == null) return '–'
  const pct = v * 100
  return (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%'
}

export default function PlayoffWheel({ rows, updatedLabel }) {
  const [activeId, setActiveId] = useState(null)

  const teams = useMemo(() => rows.map((r) => r.team), [rows])
  const probsByTeamId = useMemo(() => new Map(rows.map((r) => [r.team.id, r])), [rows])
  // Winkelbreite je Team ist proportional zu P(QF) (normalisiert auf 360°
  // über alle Teams) - siehe wheelGeometry.js/buildWheelLayout(). Die
  // Sektor-Lücke wird dort automatisch pro Sektor berechnet.
  const layout = useMemo(
    () => buildWheelLayout(teams, probsByTeamId, { maxRadius: MAX_RADIUS }),
    [teams, probsByTeamId]
  )

  // Da die Sektorbreite jetzt proportional zur Wahrscheinlichkeit ist
  // (statt fix), können mehrere schwache Teams mit sehr kleinem Winkel
  // nebeneinander liegen - ihre Logos (fixer Radius am äusseren Rand)
  // würden sich sonst überlappen. Deshalb: Logogrösse an den ENGSTEN
  // tatsächlichen Winkelabstand zwischen zwei benachbarten Team-Mittelpunkten
  // anpassen (nie grösser als der gestalterische Standard, nie kleiner als
  // eine noch lesbare Mindestgrösse) - Schrift skaliert proportional mit.
  const logoR = useMemo(() => {
    if (layout.length < 2) return LOGO_R_MAX
    let minGapDeg = 360
    for (let i = 0; i < layout.length; i++) {
      const next = layout[(i + 1) % layout.length]
      let diff = next.midAngle - layout[i].midAngle
      if (diff <= 0) diff += 360
      minGapDeg = Math.min(minGapDeg, diff)
    }
    const minArcDistance = LOGO_RADIUS * (minGapDeg * Math.PI / 180)
    const maxDiameterFit = minArcDistance * 0.82 // etwas Luft zwischen benachbarten Logos
    return Math.max(LOGO_R_MIN, Math.min(LOGO_R_MAX, maxDiameterFit / 2))
  }, [layout])
  const logoFontSize = LOGO_FONT_MAX * (logoR / LOGO_R_MAX)

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
                  {`${entry.team.name} — ${STAGES.map((s) => `${s.label} ${fmtPct(entry[s.key])}`).join(', ')}`}
                </title>
                {STAGES.map((s) => (
                  <path
                    key={s.key}
                    d={sectorPath(CENTER, CENTER, entry[RADIUS_KEY[s.key]], entry.startAngle, entry.endAngle)}
                    fill={entry.team.color}
                    opacity={s.opacity}
                  />
                ))}
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
                    komfortabel (~44px Kantenlänge, Apple-HIG-Richtwert),
                    solange der verfügbare Winkelabstand das zulässt. */}
                <circle r={logoR + 6} fill="transparent" />
                <circle r={logoR} style={{ stroke: entry.team.color }} />
                <text dy={3} style={{ fontSize: logoFontSize }}>{entry.team.short}</text>
              </g>
            )
          })}
        </svg>
      </div>

      <div className="wheel-legend">
        {STAGES.map((s) => (
          <span key={s.key}><i className="wheel-legend-dot" style={{ opacity: s.opacity }} />{s.label}</span>
        ))}
      </div>

      <div className="wheel-info">
        {active ? (
          <>
            <div className="wheel-info-head">
              <span className="dot" style={{ background: active.team.color }} />
              <strong>{active.team.name}</strong>
            </div>
            <div className="wheel-info-rows">
              {STAGES.map((s) => (
                <span key={s.key}>{s.label} <b>{fmtPct(active[s.key])}</b></span>
              ))}
            </div>
            <Link className="btn ghost sm" to="/playoff-odds">Details →</Link>
          </>
        ) : (
          <span className="muted">Team antippen oder hovern für Details.</span>
        )}
      </div>

      {/* Barrierefreiheit: dieselben Daten als Text-Tabelle, permanent im DOM -
          Hover/Tap ist bewusst NICHT der einzige Weg an die Werte zu kommen
          (Screenreader/Tastatur-Nutzung ohne Zeiger). Visuell versteckt. */}
      <table className="sr-only">
        <caption>Playoff-Wahrscheinlichkeiten je Team und Runde</caption>
        <thead>
          <tr>
            <th scope="col">Team</th>
            {STAGES.map((s) => <th key={s.key} scope="col">{s.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {layout.map((entry) => (
            <tr key={entry.team.id}>
              <th scope="row">{entry.team.name}</th>
              {STAGES.map((s) => <td key={s.key}>{fmtPct(entry[s.key])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
