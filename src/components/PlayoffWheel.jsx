import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { SectionHeader } from './ui.jsx'
import { buildWheelLayout, sectorPath, polarToCartesian, RING_LEVELS } from '../wheelGeometry.js'

// Playoff Probability Wheel (MoneyPuck-artige radiale Visualisierung):
// EIN gemeinsamer Kreis statt Balkentabelle - jedes Team bekommt einen
// eigenen radialen Sektor, dessen WINKELBREITE proportional zu seiner
// P(Viertelfinal) ist (stärkere Teams = breiterer Sektor, normalisiert auf
// 360° über alle Teams - siehe wheelGeometry.js/buildWheelLayout()).
//
// WICHTIG (Rendering, nicht Geometrie): jeder Teamsektor zeichnet ZUERST
// eine durchgehende neutrale Hintergrundfläche bis zum ÄUSSEREN Rand
// (maxRadius) - dadurch bleibt der GESAMTE Kreis immer vollständig
// (wie eine Zielscheibe), statt dass ein Team mit niedriger Wahrschein-
// lichkeit wie ein kurzer, aus dem Zentrum "herausragender Balken" wirkt.
// Erst darüber liegen die vier kumulativen Playoff-Stufen (Viertelfinal/
// Halbfinal/Final/Meister) als klar getrennte, zunehmend gesättigtere
// RINGE derselben Teamfarbe (mit dünner Trennlinie zwischen den Stufen,
// damit sie wie eigenständige konzentrische Bänder wirken statt wie ein
// weicher Farbverlauf). Das Zentrum trägt zusätzlich einen neutralen
// "Meister"-Hub (Pokal-Symbol) als visuellen Nabe der ganzen Grafik.
// WINKEL = normierte P(QF) relativ zu allen Teams, RADIUS = direkte
// P(je Runde) dieses Teams (siehe wheelGeometry.js/.test.js für die
// Herleitung/Invarianten - hier unverändert, nur das Rendering ist neu).
const SIZE = 340
const CENTER = SIZE / 2
const MAX_RADIUS = 106
const LOGO_RADIUS = MAX_RADIUS + 27
const LOGO_R_MAX = 15.5
const HUB_R = 11
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
// Teamfarbe für alle vier Stufen, nur die Opazität unterscheidet sie. Bewusst
// grössere Sprünge zwischen den Stufen (statt einer weichen Rampe) - jede
// Stufe soll als eigenständiges Ring-Band erkennbar sein, kein Verlauf.
const STAGES = [
  { key: 'pPlayoffs', label: 'Viertelfinal', short: 'VF', opacity: 0.28 },
  { key: 'pSemifinal', label: 'Halbfinal', short: 'HF', opacity: 0.55 },
  { key: 'pFinal', label: 'Final', short: 'F', opacity: 0.8 },
  { key: 'pChampion', label: 'Meister', short: 'M', opacity: 1 },
]
const RADIUS_KEY = { pPlayoffs: 'rQF', pSemifinal: 'rSF', pFinal: 'rFinal', pChampion: 'rCup' }
// Radiale Position der vier Runden-Labels, GENAU AUF der 12-Uhr-Achse
// (oberer Bereich, innerhalb des Kreises - nicht in einer Ecke ausserhalb).
// Rein dekorative Referenzradien auf der gemeinsamen 0-100%-Skala (wie die
// %-Ringe selbst) - unabhängig von jedem einzelnen Team-Sektor, verändert
// keine Geometrie (startAngle/endAngle/rQF/... bleiben unberührt). Absteigend
// aussen (Viertelfinal, nahe maxRadius) -> innen (Meister, knapp über dem Hub).
const RING_LABEL_RADIUS = { pPlayoffs: 0.91, pSemifinal: 0.67, pFinal: 0.43, pChampion: 0.19 }

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
                {/* Durchgehende neutrale Trackfläche bis zum äusseren Rand -
                    der Sektor wirkt dadurch immer als VOLLSTÄNDIGES
                    Ziel-scheiben-Segment, nie als kurzer, im Nichts
                    endender "Balken". Die vier Stufen darüber sind reine
                    Datenschicht, die Trackfläche nur die neutrale Basis. */}
                <path
                  className="wheel-sector-track"
                  d={sectorPath(CENTER, CENTER, MAX_RADIUS, entry.startAngle, entry.endAngle)}
                />
                {STAGES.map((s) => (
                  <path
                    key={s.key}
                    className="wheel-sector-stage"
                    d={sectorPath(CENTER, CENTER, entry[RADIUS_KEY[s.key]], entry.startAngle, entry.endAngle)}
                    fill={entry.team.color}
                    opacity={s.opacity}
                  />
                ))}
              </g>
            )
          })}

          {/* Dezente Prozent-Skala (25/50/75/100%) - über den Teamflächen,
              damit sie auf der jetzt durchgehend gefüllten Fläche sichtbar bleibt. */}
          <g className="wheel-rings">
            {RING_LEVELS.map((lvl) => (
              <circle key={lvl} cx={CENTER} cy={CENTER} r={lvl * MAX_RADIUS} />
            ))}
          </g>
          <g className="wheel-ring-labels">
            {RING_LEVELS.map((lvl) => (
              <text key={lvl} x={CENTER + 3} y={CENTER - lvl * MAX_RADIUS + 2.5}>{Math.round(lvl * 100)}%</text>
            ))}
          </g>

          {/* Runden-Labels DIREKT IN der Kreisgrafik (nicht ausserhalb, nicht
              in einer Ecke) - stehen aufrecht am oberen Bereich der jeweils
              zugehörigen Ebene, auf derselben radialen 0-100%-Skala wie die
              %-Ringe. Reines Text-Overlay - beeinflusst keinerlei Geometrie
              (startAngle/endAngle/rQF/rSF/rFinal/rCup unverändert). Text
              bekommt einen Hintergrund-farbenen "Halo" (paint-order:stroke,
              siehe CSS), damit er unabhängig von der jeweils darunter
              liegenden Teamfarbe lesbar bleibt. */}
          <g className="wheel-round-labels" aria-hidden="true">
            {STAGES.map((s) => {
              const y = CENTER - RING_LABEL_RADIUS[s.key] * MAX_RADIUS
              return (
                <g key={s.key}>
                  <text x={CENTER} y={y}>{s.label.toUpperCase()}</text>
                  <line x1={CENTER - 15} x2={CENTER + 15} y1={y + 4} y2={y + 4} />
                </g>
              )
            })}
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

          {/* Zentraler Meister-/Cup-Hub - die visuelle Nabe des Wheels
              (MoneyPuck-artig: Zentrum = Meister). Rein dekorativ/neutral
              (nicht teamfarbig), liegt über der Konvergenzstelle aller
              Sektoren im Zentrum. */}
          <g className="wheel-hub" aria-hidden="true">
            <circle cx={CENTER} cy={CENTER} r={HUB_R} />
            <text x={CENTER} y={CENTER} dy={1}>🏆</text>
          </g>
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
