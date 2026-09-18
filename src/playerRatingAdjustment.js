// ---------------------------------------------------------------------------
// Player-Rating -> ELO-Punkte-Adjustierung (Phase 1 der Prediction-
// Integration, siehe Analyse-/Plan-Bericht). Identisches Muster wie die
// bereits produktive SOG-zugelassen-Adjustierung
// (computeSogAllowedEloAdjustments in src/playoffSim.js): z-normalisierte
// Teamstärke, geclampt, mit Konfidenz-Rampe nach Stichprobengrösse, über
// LOGIT_TO_ELO in ELO-Punkte umgerechnet - KEINE neue Mathematik erfunden.
//
// WICHTIG (siehe Analyse-Bericht, Abschnitt 3):
// - Nur das AKTUELL AKTIVE Team-Roster ist verfügbar (`players`, per
//   `teamId` zugeordnet) - es gibt KEIN Dressed-Roster für geplante Spiele.
// - Nur Feldspieler (F+D) - KEINE Torhüter-Komponente (Backtest-Befund: der
//   Torhüter-Anteil war in der Lineup Strength eher kontraproduktiv).
// - KEINE Verletzungs-/Abwesenheits-/"tatsächlich eingesetzt"-Daten -
//   solche Felder existieren im Spieler-Schema nicht und werden hier nicht
//   erfunden. Das volle aktive F/D-Roster gilt als "voraussichtliche
//   Aufstellung" (dokumentierte Limitation, siehe Bericht).
// - Rating-Berechnung selbst (src/playerRating.js) bleibt UNVERÄNDERT -
//   dieses Modul konsumiert nur `overallZ` und mittelt/clampt/gewichtet auf
//   Team-Ebene, ändert nichts an der Rating-Logik selbst.
//
// Default-Gewicht ist 0 (deaktiviert) - bei weight=0 liefert
// computePlayerRatingEloAdjustments für jedes Team exakt 0, wodurch
// src/playoffSim.js mathematisch identisch zum bisherigen Verhalten bleibt
// (siehe src/playoffSim.test.js/src/playerRatingAdjustment.test.js).
// ---------------------------------------------------------------------------

import { calculatePlayerRating, buildSkaterRatingBaselines } from './playerRating.js'

// Identisch zu LOGIT_TO_ELO in src/playoffSim.js - bewusst hier lokal
// dupliziert statt importiert (kein Import von playoffSim.js hierher, um
// keinen Zirkelbezug playoffSim.js <-> playerRatingAdjustment.js zu
// riskieren; exakt dasselbe Vorgehen wie bei SOG_ADJUSTMENT/POWER_CONFIG in
// src/playoffSim.js/src/powerRankings.js, siehe dortiger Kommentar).
const LOGIT_TO_ELO = 400 / Math.LN10

// HEURISTISCHE INITIALKONFIGURATION (siehe Backtest-Berichte:
// server/scripts/backtest-player-rating-integration.js) - `weight: 0` hält
// die Funktion bis zum validierten Re-Backtest (Phase 3) vollständig
// deaktiviert. `weight` ist über `settings.playerRatingWeight` überschreibbar
// (siehe computePlayerRatingEloAdjustments()), exakt wie eloK/homeAdvantage
// bereits heute über `settings` überschreibbar sind.
export const PLAYER_RATING_ADJUSTMENT = {
  weight: 0,
  maxZScore: 2.5,
  minPlayersFullConfidence: 12,
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// Durchschnittlicher overallZ aller aktiven F/D-Spieler eines Teams mit
// vorhandenem Rating (null-Ratings werden übersprungen, NICHT als 0
// gezählt - ein Spieler ohne genug Datenbasis trägt weder positiv noch
// negativ bei, er fehlt einfach aus dem Mittelwert).
function teamFieldPlayerZ(teamId, players, pastGames, options, skaterBaselines) {
  const roster = (players || []).filter((p) => p.teamId === teamId && (p.position === 'F' || p.position === 'D'))
  let sum = 0, count = 0
  for (const p of roster) {
    const rating = calculatePlayerRating(p.id, pastGames, {
      players,
      playerHistoryData: options.playerHistoryData,
      asOfDate: options.asOfDate,
      skaterBaselines, // vorab EINMAL für die ganze Liga berechnet, siehe unten - vermeidet O(Spieler²) Baseline-Neubau
      careerBaselines: options.careerBaselines,
    })
    if (rating?.overallZ != null) { sum += rating.overallZ; count++ }
  }
  return count > 0 ? { z: sum / count, ratedCount: count } : { z: null, ratedCount: 0 }
}

// Pro Team ein additives ELO-Punkte-Delta (0, wenn kein Rating verfügbar
// oder `weight`=0) - GENAU EIN Aufruf pro `computeFixtures()`-Batch, nicht
// pro Fixture (identisches Performance-Muster wie
// computeSogAllowedEloAdjustments): die teure Liga-Baseline
// (buildSkaterRatingBaselines) wird HIER EINMAL für alle Teams/Spieler
// gemeinsam gebaut und an jeden calculatePlayerRating()-Aufruf
// durchgereicht, statt sie implizit pro Spieler neu zu berechnen.
//
// `games`: bereits auf abgeschlossene Spiele gefiltert (wie `finalGames` in
// computeFixtures()) - calculatePlayerRating() filtert intern zusätzlich
// nach `asOfDate` (Default: heute), daher auch bei versehentlich
// mitgegebenen `scheduled`-Spielen kein Leck (die werden ohnehin nur nach
// `status==='final'` berücksichtigt, siehe src/playerRating.js::gamesBeforeDate).
export function computePlayerRatingEloAdjustments(teams, games, players, options = {}) {
  const adjustments = {}
  teams.forEach((t) => { adjustments[t.id] = 0 })

  const weight = options.weight ?? PLAYER_RATING_ADJUSTMENT.weight
  if (!weight || weight <= 0) return adjustments
  if (!players || players.length === 0) return adjustments

  const skaterBaselines = options.skaterBaselines || buildSkaterRatingBaselines(players, games)

  for (const t of teams) {
    const { z, ratedCount } = teamFieldPlayerZ(t.id, players, games, options, skaterBaselines)
    if (z == null) continue // 0 bewertete Spieler -> Adjustment bleibt 0 (kein erfundener Wert)
    const clampedZ = clamp(z, -PLAYER_RATING_ADJUSTMENT.maxZScore, PLAYER_RATING_ADJUSTMENT.maxZScore)
    const confidence = clamp(ratedCount / PLAYER_RATING_ADJUSTMENT.minPlayersFullConfidence, 0, 1)
    adjustments[t.id] = weight * clampedZ * confidence * LOGIT_TO_ELO
  }
  return adjustments
}
