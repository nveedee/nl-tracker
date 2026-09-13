// ---------------------------------------------------------------------------
// Marktwert-Verlauf: reine Auswertungsfunktionen über player.marketValueHistory
// (server/sync.js, additiv befüllt - siehe dort). Kein Prognosemodell, keine
// erfundenen Werte - wenn zu wenig Historie vorhanden ist, wird das explizit
// gemeldet statt einen einzelnen Punkt als Kurve/Trend darzustellen.
// ---------------------------------------------------------------------------

// Ab wie vielen unterschiedlichen Tagen ein Verlauf sinnvoll als Kurve
// darstellbar ist (2 Punkte = technisch eine Linie, aber wenig aussagekräftig -
// 3 ist die ehrliche Untergrenze für "es zeichnet sich etwas ab").
export const MIN_ENTRIES_FOR_CHART = 3

export function hasEnoughHistoryForChart(history) {
  return Array.isArray(history) && history.length >= MIN_ENTRIES_FOR_CHART
}

// Findet den Verlaufs-Eintrag, der am nächsten (aber nicht später) an einem
// Zieldatum liegt - `history` ist chronologisch aufsteigend sortiert
// (server/sync.js hängt immer ans Ende an).
function findBaselineEntry(history, targetIso) {
  let candidate = history[0]
  for (const h of history) {
    if (h.date <= targetIso) candidate = h
    else break
  }
  return candidate
}

// Veränderung über die letzten `days` Tage, ausgehend vom jüngsten Eintrag.
// null, wenn die Historie keine echte Zeitspanne abdeckt (nur 1 Tag) - dann
// gibt es nichts zu berichten, kein künstlicher 0%-Wert.
export function computeMarketValueChange(history, days = 14) {
  if (!Array.isArray(history) || history.length < 2) return null
  const latest = history[history.length - 1]
  const latestDate = new Date(latest.date + 'T00:00:00Z')
  const targetDate = new Date(latestDate)
  targetDate.setUTCDate(targetDate.getUTCDate() - days)
  const targetIso = targetDate.toISOString().slice(0, 10)

  const baseline = findBaselineEntry(history, targetIso)
  if (baseline.date === latest.date) return null // keine Zeitspanne abgedeckt

  const delta = latest.marketValue - baseline.marketValue
  const deltaPct = baseline.marketValue > 0 ? delta / baseline.marketValue : null
  const daysSpanned = Math.round((latestDate - new Date(baseline.date + 'T00:00:00Z')) / 86400000)
  return { latest, baseline, delta, deltaPct, daysSpanned }
}

// Liga-Ansicht "grösste Steiger/Faller (letzte N Tage)": pro Spieler mit
// genügend Historie die Veränderung berechnen, sortiert nach Betrag. Gibt
// `{ ready, risers, fallers }` zurück - `ready:false`, solange nicht
// mindestens `minPlayers` Spieler eine auswertbare Zeitspanne haben (ehrliche
// "sammelt noch Daten"-Anzeige statt einer Liste aus 1-2 Zufallstreffern).
export function computeLeagueMarketMovers(players, days = 14, { limit = 5, minPlayers = 5 } = {}) {
  const changes = []
  for (const p of players || []) {
    const change = computeMarketValueChange(p.marketValueHistory, days)
    if (change) changes.push({ player: p, ...change })
  }
  if (changes.length < minPlayers) return { ready: false, count: changes.length, minPlayers, risers: [], fallers: [] }

  const risers = [...changes].filter((c) => c.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, limit)
  const fallers = [...changes].filter((c) => c.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, limit)
  return { ready: true, count: changes.length, risers, fallers }
}
