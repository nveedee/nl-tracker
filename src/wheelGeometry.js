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

// Verteilt `teams` gleichmässig über 360° (Start oben, im Uhrzeigersinn) und
// berechnet je Team die drei radialen Reichweiten (Viertelfinal/Halbfinal/
// Final) proportional zur jeweiligen Wahrscheinlichkeit - JEDE Runde auf
// ihrer eigenen 0-100%-Skala (nicht Teile eines 100%-Kuchens, siehe Auftrag).
// `probsByTeamId`: Map<teamId, { pPlayoffs, pSemifinal, pFinal }>.
export function buildWheelLayout(teams, probsByTeamId, { maxRadius = 100, gapDeg = 4 } = {}) {
  const n = teams.length
  if (n === 0) return []
  const slice = 360 / n

  return teams.map((team, i) => {
    const row = probsByTeamId.get(team.id) || {}
    const pPlayoffs = clamp01(row.pPlayoffs)
    const pSemifinal = clamp01(row.pSemifinal)
    const pFinal = clamp01(row.pFinal)
    const startAngle = -90 + i * slice + gapDeg / 2
    const endAngle = -90 + (i + 1) * slice - gapDeg / 2

    return {
      team,
      startAngle,
      endAngle,
      midAngle: (startAngle + endAngle) / 2,
      pPlayoffs,
      pSemifinal,
      pFinal,
      rQF: pPlayoffs * maxRadius,
      rSF: pSemifinal * maxRadius,
      rFinal: pFinal * maxRadius,
    }
  })
}
