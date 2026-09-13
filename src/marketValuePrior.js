// ---------------------------------------------------------------------------
// Marktwert-Prior für den ELO-Startwert: statt alle Teams pauschal bei
// `eloStart` beginnen zu lassen, wird der Startwert pro Team aus der Summe
// der Kader-Marktwerte (player.marketValue, NL-API-Saison-Sync - siehe
// server/sync.js) abgeleitet. Teurere Kader starten über `eloStart`,
// günstigere darunter - ligaweit so zentriert, dass der Durchschnitt aller
// Team-Startwerte exakt `eloStart` bleibt.
//
// Berechnung (bewusst einfach/nachvollziehbar, kein Statistik-Modell):
//   1. teamSum   = Summe player.marketValue aller Spieler dieses Teams (nur
//                  Spieler mit bekanntem Marktwert - kein Wert erfunden).
//   2. avg       = Ligadurchschnitt aller teamSum-Werte.
//   3. maxAbsDev = grösste absolute Abweichung |teamSum - avg| EINES
//                  einzelnen Teams vom Durchschnitt.
//   4. offset    = (teamSum - avg) / maxAbsDev * priorSpread
//                  -> das Team mit der grössten Abweichung vom Durchschnitt
//                  bekommt GENAU ±priorSpread, alle anderen Teams linear
//                  proportional dazwischen (lineare Min-Max-Skalierung,
//                  keine z-Score/Normalverteilungs-Annahme nötig).
//   5. startElo  = eloStart + offset
//
// Reines Startwert-Setting: `computeElo()` (src/elo.js) selbst ist dabei
// UNVERÄNDERT - der Prior wird nur als `initialRatings`-Argument übergeben
// (derselbe Mechanismus wie der bestehende historische Pre-Season-ELO, siehe
// src/preseasonElo.js). Jede laufende ELO-Aktualisierung aus echten
// Spielergebnissen (inkl. der per-Spiel-Boxscore-Daten aus dem SIHF-Sync)
// bleibt davon komplett unberührt.
//
// Fallback: fehlen Marktwerte komplett (z.B. NL-API-Sync noch nie gelaufen)
// oder sind alle Team-Summen identisch (maxAbsDev = 0), liefert
// computeMarketValuePrior() `null` - der Aufrufer fällt dann sauber auf den
// bisherigen Prior (historisches Archiv) bzw. den flachen `eloStart` zurück,
// nichts wird erfunden.
// ---------------------------------------------------------------------------

export const DEFAULT_PRIOR_SPREAD = 120

export function computeMarketValuePrior(teams, players, eloStart, priorSpread) {
  const sums = {}
  teams.forEach((t) => { sums[t.id] = 0 })

  let hasAnyValue = false
  for (const p of players || []) {
    if (p.marketValue == null || !(p.teamId in sums)) continue
    sums[p.teamId] += p.marketValue
    hasAnyValue = true
  }
  if (!hasAnyValue) return null

  const values = Object.values(sums)
  const avg = values.reduce((a, b) => a + b, 0) / values.length
  const maxAbsDeviation = Math.max(...values.map((v) => Math.abs(v - avg)))
  if (maxAbsDeviation === 0) return null

  const out = {}
  teams.forEach((t) => {
    const deviation = sums[t.id] - avg
    out[t.id] = eloStart + (deviation / maxAbsDeviation) * priorSpread
  })
  return out
}

// Rohe Team-Marktwert-Summen (für die Settings-/Verifikations-Anzeige) - kein
// Prior, nur die Zwischenwerte aus Schritt 1 oben, damit sich der Startwert
// pro Team nachvollziehen lässt.
export function computeTeamMarketValueSums(teams, players) {
  const sums = {}
  teams.forEach((t) => { sums[t.id] = 0 })
  for (const p of players || []) {
    if (p.marketValue == null || !(p.teamId in sums)) continue
    sums[p.teamId] += p.marketValue
  }
  return sums
}
