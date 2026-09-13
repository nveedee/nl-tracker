// ---------------------------------------------------------------------------
// Pre-Season-ELO: überträgt das Saisonend-ELO der letzten historischen
// Archiv-Saison als Startrating in die laufende Saison (statt alle Teams
// pauschal bei eloStart beginnen zu lassen).
//
// Validiert per leak-freiem Walk-Forward-Backtest über 9 Saisons
// (server/scripts/backtest-preseason-h2h.js, Bericht siehe Konversation):
// robuste Verbesserung ggü. dem bisherigen "Reset auf 1500"-Verhalten
// (Core LogLoss 0.6639 -> 0.6564..0.6577 je nach Regressionsstufe, stabil in
// 7/7 Nicht-Corona-Saisons, grösster Effekt in den ersten 10-30% der Saison
// und danach - wie erwartet - vom laufenden ELO zunehmend überholt).
// Getestete Regressionsstufen (0/10/20/25/30/40/50%) waren im Bereich
// 0-30% statistisch nicht unterscheidbar (LogLoss-Spanne 0.0003) - deshalb
// bewusst KEIN neuer, separat getunter Parameter: wiederverwendet wird die
// bereits produktiv validierte `ELO_CONFIG.seasonEndRegression` (25%), die
// exakt in diesem Bereich liegt.
//
// H2H-Kontext wurde im selben Backtest ausdrücklich NICHT robust genug
// befunden (kein stabiler Zusatznutzen ggü. Pre-Season-ELO+SOG, Effekt in
// nur 4/7 Saisons positiv, bestes Feature mit gegenläufigem/instabilem
// Vorzeichen) und deshalb NICHT übernommen.
//
// Datenquelle: public/preseason-elo.json - ein statischer, einmalig per
// server/scripts/generate-preseason-elo.js generierter Export (Saisonend-
// ELO jedes Teams nach der letzten historischen Archiv-Saison, berechnet mit
// der UNVERÄNDERTEN, produktiven computeElo()-Funktion). Enthält keine
// Information aus der laufenden Saison (streng leak-frei).
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import { ELO_CONFIG } from './elo.js'

let cache = null
export function usePreseasonElo() {
  const [data, setData] = useState(cache)
  useEffect(() => {
    if (cache) { setData(cache); return }
    let cancelled = false
    fetch('/preseason-elo.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then((json) => { cache = json; if (!cancelled) setData(json) })
      .catch(() => { if (!cancelled) setData({}) })
    return () => { cancelled = true }
  }, [])
  return data // null = lädt noch, {} = keine Daten verfügbar
}

// Regressiert das archivierte Saisonend-ELO Richtung eloStart - identische
// Formel wie der reguläre Saisonübergang in computeElo() (src/elo.js), nur
// hier einmalig beim Übertrag aus dem Archiv in die laufende Saison
// angewendet. `eloStart` als Parameter, damit ein individuell in den
// Settings überschriebener Startwert (settings.eloStart) konsistent bleibt.
export function computePreseasonRatings(seasonEndRatings, eloStart = ELO_CONFIG.eloStart) {
  if (!seasonEndRatings) return null
  const regression = ELO_CONFIG.seasonEndRegression
  const out = {}
  for (const [teamId, rating] of Object.entries(seasonEndRatings)) {
    out[teamId] = eloStart + (rating - eloStart) * (1 - regression)
  }
  return out
}
