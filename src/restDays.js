// ---------------------------------------------------------------------------
// Ruhetage/Back-to-back-Anpassung für die EINZELSPIEL-Prognose. Bewusst
// NICHT Teil von computeElo()/playoffSim.js (Saison-Simulation) - siehe
// Bericht: nur dort angewendet, wo ein konkretes Spiel mit echtem Datum
// individuell prognostiziert wird (MatchupDetail.jsx, Schedule.jsx,
// server/scripts/predictions.js).
//
// Ermittelt pro Team die Tage seit dem letzten Spiel VOR dem betrachteten
// Spieldatum - zählt sowohl bereits gespielte als auch bereits terminierte
// (noch nicht gespielte) Spiele als "Spieltag", da ein Team an einem
// terminierten Spieltag unabhängig vom Resultat im Einsatz war/sein wird.
// Ein Team gilt als "Back-to-back", wenn es am direkten Vortag (1 Tag
// Abstand) einen Spieltag hatte. Nur wenn GENAU eines der beiden Teams
// betroffen ist, wird die Heimsieg-Wahrscheinlichkeit um `penalty` Richtung
// des ausgeruhten Teams verschoben - sind beide oder keines betroffen, bleibt
// sie unverändert (kein einseitig ableitbarer Effekt).
// ---------------------------------------------------------------------------

export const DEFAULT_BACK_TO_BACK_PENALTY = 0.04

// Tage seit dem letzten Spiel dieses Teams VOR `beforeDate` (exklusiv) -
// null, wenn kein früheres Spiel bekannt ist (z.B. Saisonstart).
export function daysSinceLastGame(teamId, games, beforeDate) {
  let lastDate = null
  for (const g of games) {
    if (g.homeTeamId !== teamId && g.awayTeamId !== teamId) continue
    if (!g.date || g.date >= beforeDate) continue
    if (lastDate == null || g.date > lastDate) lastDate = g.date
  }
  if (lastDate == null) return null
  const ms = new Date(beforeDate) - new Date(lastDate)
  return Math.round(ms / 86400000)
}

// Vorzeichenbehaftete Anpassung der HEIMSIEG-Wahrscheinlichkeit (additiv, vor
// dem Clamping auf [0,1]) - positiv begünstigt das Heimteam (weil das
// Auswärtsteam im Back-to-back steckt), negativ benachteiligt es.
export function computeRestAdjustment(game, games, penalty = DEFAULT_BACK_TO_BACK_PENALTY) {
  if (!game?.date || !penalty) return 0
  const homeDays = daysSinceLastGame(game.homeTeamId, games, game.date)
  const awayDays = daysSinceLastGame(game.awayTeamId, games, game.date)
  const homeB2B = homeDays === 1
  const awayB2B = awayDays === 1
  if (homeB2B === awayB2B) return 0 // beide oder keines betroffen -> kein Effekt
  return homeB2B ? -penalty : penalty
}

// Wendet die Anpassung auf eine bestehende Heimsieg-Wahrscheinlichkeit an,
// geclamped auf [0.02, 0.98] (keine entarteten 0%/100%-Prognosen).
export function applyRestAdjustment(pHome, game, games, penalty) {
  const adj = computeRestAdjustment(game, games, penalty)
  if (adj === 0) return pHome
  return Math.min(0.98, Math.max(0.02, pHome + adj))
}
