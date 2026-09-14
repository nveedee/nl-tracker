// ---------------------------------------------------------------------------
// Reine Geometrie-/Layout-Berechnung für das "Playoff Probability Wheel"
// (src/components/PlayoffWheel.jsx) - bewusst ohne React/JSX, damit sie
// unabhängig vom DOM per node:test geprüft werden kann (siehe
// wheelGeometry.test.js). Kennt weder die Monte-Carlo-Engine (playoffSim.js)
// noch den zentralen Ergebnis-Store (simResultsContext.jsx) - nimmt nur
// bereits aggregierte Wahrscheinlichkeiten entgegen.
// ---------------------------------------------------------------------------

// Konzentrische Ring-Skala (Anteil von maxRadius) für die dezente 0-100%-Achse.
export const RING_LEVELS = [0.25, 0.5, 0.75, 1]

function clamp01(v) {
  if (v == null || Number.isNaN(v)) return 0
  return Math.max(0, Math.min(1, v))
}

// Grad -> kartesische Koordinaten. 0° = 3-Uhr-Position, im Uhrzeigersinn
// (Standard-SVG-Winkelkonvention) - der Aufrufer verschiebt den Nullpunkt
// selbst um -90°, damit Team 0 oben (12 Uhr) beginnt.
export function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

// SVG-Pfad für einen Kreissektor ("Tortenstück") von der Mitte (cx,cy) bis
// Radius r, zwischen startAngle/endAngle (Grad). r<=0 liefert einen validen,
// aber unsichtbaren Pfad (Punkt) statt eines leeren/fehlerhaften Strings -
// Teams mit 0% Wahrscheinlichkeit dürfen keinen Rendering-Fehler auslösen.
export function sectorPath(cx, cy, r, startAngle, endAngle) {
  if (r <= 0) return `M ${cx} ${cy} Z`
  const start = polarToCartesian(cx, cy, r, startAngle)
  const end = polarToCartesian(cx, cy, r, endAngle)
  const largeArc = endAngle - startAngle > 180 ? 1 : 0
  return `M ${cx} ${cy} L ${start.x.toFixed(2)} ${start.y.toFixed(2)} ` +
    `A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)} Z`
}

// Visueller Mindestwinkel (Grad): garantiert, dass ein Team mit 0% oder
// sehr kleiner P(QF) im Wheel trotzdem sichtbar/antippbar bleibt. Betrifft
// AUSSCHLIESSLICH die Darstellung (angleWidth/startAngle/endAngle) - die
// tatsächliche Wahrscheinlichkeit (pPlayoffs, rQF, ...) bleibt davon
// vollkommen unberührt. Jeder Layout-Eintrag trägt zusätzlich das Flag
// `isVisualMinimum`, damit diese Unterscheidung auch für Konsumenten
// (und Tests) explizit nachvollziehbar bleibt statt implizit zu verschwimmen.
//
// Bewusst 10° (nicht kleiner): der ungünstigste Fall sind ZWEI benachbarte
// Mindestwinkel-Teams direkt nebeneinander (z.B. mehrere Teams ohne
// realistische Playoff-Chance in Tabellenreihenfolge) - der Abstand
// zwischen ihren Logo-Mittelpunkten entspricht dann exakt diesem Winkel.
// Bei kleineren Werten (z.B. 3°) überlappen die Logos selbst nach dem
// adaptiven Schrumpfen in PlayoffWheel.jsx noch spürbar (siehe dortige
// Kommentare zu logoR/LOGO_R_MIN) - 10° hält sie bei der aktuellen
// LOGO_RADIUS zuverlässig auseinander (siehe Herleitung dort).
export const MIN_VISUAL_ANGLE_DEG = 10
// Lücke zwischen zwei Sektoren (rein optisch, Grad) - nie mehr als dieser
// Wert, aber auch nie mehr als ein fester Anteil des eigenen (ggf. sehr
// schmalen) Sektors, damit ein knapp über dem Mindestwinkel liegender
// Sektor nicht durch die Lücke selbst wieder auf 0 Breite kollabiert.
const RENDER_GAP_MAX_DEG = 3
const RENDER_GAP_FRACTION = 0.4

// Verteilt 360° NICHT gleichmässig auf die Teams, sondern PROPORTIONAL zu
// deren P(QF) (normalisiert, sodass die Summe exakt 360° ergibt):
//   angleWidth_i = 360° x P(QF)_i / Σ P(QF)_alle_Teams
// Gleiche P(QF) -> exakt gleicher Winkel; höhere P(QF) -> grösserer Winkel.
// Teams unterhalb von MIN_VISUAL_ANGLE_DEG bekommen diesen Mindestwinkel
// fix zugewiesen; der dadurch "reservierte" Winkel wird von den übrigen
// Teams abgezogen, bevor DEREN Anteile proportional auf den Rest verteilt
// werden - die Gesamtsumme aller Winkel bleibt dabei exakt 360°.
function computeProportionalAngleWidths(probabilities) {
  const n = probabilities.length
  if (n === 0) return []

  const total = probabilities.reduce((s, p) => s + p, 0)

  // Degenerierter Fall (keine Daten / alle 0%) - ohne jede Wahrscheinlichkeit
  // gibt es nichts zu normalisieren, gleichmässige Aufteilung ist der einzig
  // sinnvolle Fallback statt einer Division durch 0.
  if (total <= 0) return probabilities.map(() => ({ width: 360 / n, isVisualMinimum: false }))

  const raw = probabilities.map((p) => (360 * p) / total)
  const isFloor = raw.map((w) => w < MIN_VISUAL_ANGLE_DEG)
  const floorCount = isFloor.filter(Boolean).length

  // Praktisch irrelevanter Extremfall (z.B. sehr viele exakte 0%-Teams),
  // bei dem die reservierten Mindestwinkel allein schon >= 360° ergäben -
  // auch hier bleibt eine gleichmässige Aufteilung der einzig gültige Fallback.
  if (floorCount === 0) return raw.map((w) => ({ width: w, isVisualMinimum: false }))
  if (floorCount === n || floorCount * MIN_VISUAL_ANGLE_DEG >= 360) {
    return probabilities.map(() => ({ width: 360 / n, isVisualMinimum: false }))
  }

  const reserved = floorCount * MIN_VISUAL_ANGLE_DEG
  const remaining = 360 - reserved
  const remainingTotal = probabilities.reduce((s, p, i) => (isFloor[i] ? s : s + p), 0)

  return probabilities.map((p, i) => ({
    width: isFloor[i] ? MIN_VISUAL_ANGLE_DEG : (remaining * p) / remainingTotal,
    isVisualMinimum: isFloor[i],
  }))
}

// Baut das komplette Wheel-Layout: je Team ein Sektor, dessen WINKELBREITE
// proportional zu seiner P(QF) ist (siehe computeProportionalAngleWidths()
// oben), und dessen VIER radiale Reichweiten (Viertelfinal/Halbfinal/Final/
// Meister-Cup) weiterhin DIREKT (nicht normalisiert) der jeweiligen
// Wahrscheinlichkeit entsprechen - 50% ist immer 50% des maximalen Radius,
// unabhängig vom Winkel. Zwei unterschiedliche, bewusst getrennte
// Kodierungen derselben Datenquelle:
//   WINKELBREITE = normalisierte P(QF) relativ zu allen Teams
//   RADIUS       = direkte P(je Runde) dieses einen Teams
// `probsByTeamId`: Map<teamId, { pPlayoffs, pSemifinal, pFinal, pChampion }>.
export function buildWheelLayout(teams, probsByTeamId, { maxRadius = 100 } = {}) {
  const n = teams.length
  if (n === 0) return []

  const rows = teams.map((team) => {
    const row = probsByTeamId.get(team.id) || {}
    return {
      team,
      pPlayoffs: clamp01(row.pPlayoffs),
      pSemifinal: clamp01(row.pSemifinal),
      pFinal: clamp01(row.pFinal),
      pChampion: clamp01(row.pChampion),
    }
  })

  const angleInfo = computeProportionalAngleWidths(rows.map((r) => r.pPlayoffs))

  let cursor = -90 // 12-Uhr-Position, im Uhrzeigersinn - wie zuvor
  return rows.map((r, i) => {
    const { width: angleWidth, isVisualMinimum } = angleInfo[i]
    const allocStart = cursor
    const allocEnd = cursor + angleWidth
    cursor = allocEnd

    // Lücke wird symmetrisch aus der ALLOZIERTEN (proportionalen) Breite
    // herausgeschnitten - verändert nicht die Summe von 360° über alle
    // Teams (die bezieht sich auf angleWidth, nicht auf die gerenderte,
    // lückenbereinigte Breite).
    const gap = Math.min(RENDER_GAP_MAX_DEG, angleWidth * RENDER_GAP_FRACTION)
    const startAngle = allocStart + gap / 2
    const endAngle = allocEnd - gap / 2

    return {
      team: r.team,
      angleWidth,
      isVisualMinimum,
      startAngle,
      endAngle,
      midAngle: (startAngle + endAngle) / 2,
      pPlayoffs: r.pPlayoffs,
      pSemifinal: r.pSemifinal,
      pFinal: r.pFinal,
      pChampion: r.pChampion,
      rQF: r.pPlayoffs * maxRadius,
      rSF: r.pSemifinal * maxRadius,
      rFinal: r.pFinal * maxRadius,
      rCup: r.pChampion * maxRadius,
    }
  })
}
