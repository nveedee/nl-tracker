// ---------------------------------------------------------------------------
// UI-Hilfsfunktionen für das Player Rating (src/playerRating.js) - rein
// darstellungsbezogen, KEINE neue Berechnung/Gewichtung. Ändert nichts an der
// Rating-Formel selbst; bildet nur bereits vorhandene Werte auf
// UI-Kategorien ab (Datengrundlage-Label, Breakdown-Zeilenliste).
//
// Bewusst als eigenes, reines (React-freies) Modul - wie advancedStats.js/
// playerHistory.js testbar mit `node --test`, ohne Component-Rendering.
// ---------------------------------------------------------------------------

import { POSITION_LABEL } from './playerHistory.js'

// Schwellen für die Datengrundlage-Kategorie (Auftrag: "gering/mittel/hoch",
// AUSDRÜCKLICH KEIN Vorhersage-Vertrauenswert - reine Einordnung, wie viele
// Spiele/wie viel Historie das Rating stützen). `confidence` kommt
// unverändert aus calculatePlayerRating()/calculateGoalieRating() (0-100).
export const DATA_QUALITY_THRESHOLDS = { hoch: 70, mittel: 30 }

export function dataQualityLabel(confidence) {
  if (confidence == null) return null
  if (confidence >= DATA_QUALITY_THRESHOLDS.hoch) return 'hoch'
  if (confidence >= DATA_QUALITY_THRESHOLDS.mittel) return 'mittel'
  return 'gering'
}

// Positions-Text für "Perzentil unter allen X" - identische Wortwahl wie die
// bestehende Impact-Score-Anzeige (siehe PlayerDetail.jsx).
export function positionGroupLabel(position) {
  if (position === 'F') return 'Stürmern'
  if (position === 'D') return 'Verteidigern'
  if (position === 'G') return 'Torhütern'
  return null
}

export function positionLabel(position) {
  return POSITION_LABEL[position] ?? null
}

// Breakdown-Kategorien je Positionstyp - Torhüter bekommen bewusst NUR die
// für sie anwendbaren Kategorien (siehe calculatePlayerRating(): offense/
// specialTeams sind bei Torhütern strukturell `null`, nicht "0" oder "–").
const SKATER_BREAKDOWN_KEYS = [
  { key: 'offense', label: 'Offense' },
  { key: 'defense', label: 'Defense' },
  { key: 'specialTeams', label: 'Special Teams' },
  { key: 'usage', label: 'Usage' },
  { key: 'form', label: 'Form' },
]
const GOALIE_BREAKDOWN_KEYS = [
  { key: 'defense', label: 'Shot Stopping' },
  { key: 'usage', label: 'Usage' },
  { key: 'form', label: 'Form' },
]

// Baut die Liste der anzuzeigenden Breakdown-Zeilen aus einem
// calculatePlayerRating()-Ergebnis - nicht anwendbare/nicht verfügbare
// Kategorien werden WEGGELASSEN (kein "–"-Platzhalter), identisch zur
// bestehenden Konvention in AdvancedAnalyticsCard.jsx. "Career" wird aus
// `components.careerImpactScore` ergänzt (derselbe, bereits an anderer
// Stelle sichtbare Karriere-Impact-Score - keine neue Zahl).
export function buildRatingBreakdown(rating) {
  if (!rating) return []
  const keys = rating.position === 'G' ? GOALIE_BREAKDOWN_KEYS : SKATER_BREAKDOWN_KEYS
  const out = []
  for (const { key, label } of keys) {
    const value = rating[key]
    if (value != null) out.push({ key, label, value })
  }
  const careerValue = rating.components?.careerImpactScore
  if (careerValue != null) out.push({ key: 'career', label: 'Career', value: careerValue })
  return out
}
