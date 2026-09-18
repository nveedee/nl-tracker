// ---------------------------------------------------------------------------
// PLAYER RATING ENGINE (erste Version) - eine NEUE, EIGENSTÄNDIGE 0-100-
// Kennzahl pro Spieler, gedacht als künftiger Input für Match-Predictions
// (noch NICHT integriert - siehe Auftrag: "noch KEIN Prediction-Modell
// ändern"). Ersetzt/löscht NICHTS Bestehendes: der karriere-validierte
// Impact Score (src/playerHistory.js::computeImpactScore) und die
// spielbasierten Advanced-Stats/Perzentile (src/advancedStats.js) bleiben
// unverändert und werden hier nur als EINGABE-Signale wiederverwendet.
//
// Reine Berechnungsebene, KEINE React-Abhängigkeit (Auftrag Punkt 9) -
// nimmt bereits geladene Daten entgegen (games, players, player-history.json
// -Objekt), tut selbst kein fetch().
//
// ============================================================================
// A) DATENLAGE-ANALYSE (Auftrag Punkt 1) - was ist tatsächlich zuverlässig
//    genug vorhanden, dokumentiert BEVOR irgendeine Formel gebaut wurde:
// ============================================================================
//
// 1. KARRIERE (public/player-history.json, via src/playerHistory.js):
//    - Skater: pro Saison { gp, goals, assists, points, sog, plusMinus, toiSec }.
//      Breite historische Basis (352 Spieler, mehrere Saisons) - bereits
//      produktiv validiert über computeImpactScore (Spearman-Jahr-zu-Jahr-
//      Stabilität, siehe Kommentar dort). ZUVERLÄSSIG.
//    - Goalie: pro Saison { gp, saves, goalsAgainst, shotsAgainst, toiSec }.
//      KEINE Shutouts, KEINE SV%/GAA direkt (wird abgeleitet). Kleinere
//      Population als Skater (deutlich weniger Torhüter/Saison im Archiv).
//      Ausreichend für eine SV%/GAA-Baseline, aber mit niedrigerer
//      Mindeststichprobe als bei Skatern (siehe GOALIE_MIN_BASELINE_N unten).
//    - KEINE xG-, Faceoff-, PP-/PK-TOI-Daten in der Historie (diese Felder
//      existieren erst seit dem NL-Detail-Sync dieser Saison) - Karriere-
//      Komponente kann sich NUR auf die klassischen Zähl-Stats stützen.
//
// 2. AKTUELLE SAISON (data.games[].playerStats[] + .nlShots, via
//    src/advancedStats.js): P/GP, G/GP, A/GP, SOG/GP, TOI (gesamt/EQ/PP/PK),
//    Faceoff%, Blocked Shots, xG (nur wo NL-Detail-Sync gelaufen ist),
//    Special-Teams-Tore/Assists. ZUVERLÄSSIG für Spiele NACH dem Sync-Start,
//    aber bislang mit sehr wenigen Spielen pro Spieler (frühe Saison) - daher
//    zwingend mit robustem Small-Sample-Handling (Auftrag Punkt 5).
//
// 3. GOALIE AKTUELLE SAISON: game.playerStats[] trägt für Torhüter
//    goalsAgainst/saves/shotsAgainst/toiSec (SIHF) sowie shutout/decision;
//    der NL-Detail-Sync ergänzt goalsAgainstNl/savesNl/savePercentageNl/
//    gaaNl/toiSecNl (siehe server/nlGameDetailSync.js::mapGoalieFields).
//    advancedStats.js deckt das NICHT ab (reine Feldspieler-Kennzahlen) -
//    hier daher ein EIGENER, lokaler Aggregator (siehe unten), OHNE
//    advancedStats.js zu verändern.
//
// 4. KEIN Center/Wing-Feld im Spielermodell (nur position: 'F'|'D'|'G'), kein
//    historisches Faceoff-Archiv. => Auftrag Punkt 3 ("Center anhand von
//    Faceoffs sinnvoll anders behandeln?") wird NICHT als eigene
//    Positionsgruppe erzwungen (Datenlage reicht nicht für eine separate,
//    validierbare Baseline) - Faceoff% fliesst stattdessen als optionales
//    "Center-Signal" mit reduziertem Gewicht in usageRating ein (nur wenn
//    vorhanden - bei Verteidigern faktisch nie, kein Sonderfall nötig).
//
// ============================================================================
// B) GEWICHTUNGEN - EHRLICHER HINWEIS (Auftrag Punkt 17)
// ============================================================================
// Für die BESTEHENDE Karriere-Formel (P/GP, TOI/GP, +/-/GP, SOG/GP,
// gleichgewichtet) existiert eine echte empirische Validierung (siehe
// playerHistory.js-Kommentar: 4 Varianten anhand Jahr-zu-Jahr-Stabilität
// verglichen). Diese wird hier 1:1 wiederverwendet (computeImpactScore).
//
// Für ALLE anderen Gewichte in diesem Modul (Top-Level-Komposition
// offense/defense/specialTeams/usage -> overall je Position, GP-basierte
// Career/Season/Form-Blend-Tabelle, Sub-Komponenten-Gewichte innerhalb einer
// Kategorie) gibt es AKTUELL KEINE historische Validierung/keinen Backtest -
// die xG-/Faceoff-/PP-/PK-TOI-Daten existieren erst seit dieser Saison, ein
// Jahr-zu-Jahr-Stabilitätstest wie bei computeImpactScore ist dafür noch
// nicht möglich. Es handelt sich um eine KLAR DOKUMENTIERTE HEURISTISCHE
// INITIALGEWICHTUNG (Domänenwissen: z.B. Stürmer stärker über Offense,
// Verteidiger stärker über Defense/Usage bewertet; Goals-xG bewusst
// untergewichtet, siehe Punkt 8), die gemäss Auftrag SPÄTER anhand eines
// historischen Backtests (Baseline ELO+Team-Stats vs. Enhanced mit Player
// Ratings) optimiert werden soll. Alle Gewichte stehen als benannte,
// exportierte Konstanten unten - zentral änderbar, nicht verstreut im Code.
// ---------------------------------------------------------------------------

import {
  collectPlayerGameStats, computeAdvancedStats, computeRollingAdvancedStats,
} from './advancedStats.js'
import {
  mean, stdDev, normalCdf, getPlayerSeasons, computeImpactScore, computeGoalieCareerStats,
  buildPositionBaselines, POSITION_LABEL,
} from './playerHistory.js'

// ============================================================================
// GRUNDBAUSTEINE
// ============================================================================

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// z-Score einer Kennzahl ggü. einer Positions-Baseline, auf +/-CLAMP_Z
// begrenzt (Auftrag Punkt 4: "Extreme Werte durch 1-2 Spiele dürfen das
// Rating nicht komplett dominieren" - ein einzelner Ausreisser-Wert kann
// sonst einen z-Score von z.B. 8 erzeugen und die gleichgewichtete Mittelung
// dominieren; +/-3 entspricht bereits < 0.3 Perzentil Extremfall).
const CLAMP_Z = 3

function zOf(value, baselineEntry, minN, clampAbs = CLAMP_Z) {
  if (value == null || !baselineEntry || baselineEntry.n < minN) return null
  const z = (value - baselineEntry.mean) / baselineEntry.std
  return clamp(z, -clampAbs, clampAbs)
}

// Gewichteter z-Komposit über mehrere Kennzahlen - fehlende/unter-besetzte
// Komponenten werden übersprungen und die verbleibenden Gewichte
// renormalisiert (kein künstliches Auffüllen, siehe Auftrag Punkt 5/6).
// `weightedKeys`: [[key, weight, clampAbs?], ...]
function weightedZComposite(rates, baseline, weightedKeys, minN) {
  let wSum = 0, zSum = 0, used = 0
  for (const [key, weight, clampAbs] of weightedKeys) {
    const z = zOf(rates?.[key], baseline?.[key], minN, clampAbs ?? CLAMP_Z)
    if (z == null) continue
    zSum += z * weight
    wSum += weight
    used++
  }
  if (used === 0) return null
  return { z: zSum / wSum, componentsUsed: used }
}

function zTo100(z) {
  if (z == null) return null
  return Math.round(normalCdf(z) * 1000) / 10
}

// Gewichteter Mittelwert über mehrere (Wert, Gewicht)-Paare, fehlende Werte
// übersprungen + renormalisiert. Rückgabe null, wenn NICHTS verfügbar ist.
function weightedAvg(pairs) {
  let wSum = 0, vSum = 0
  for (const [v, w] of pairs) {
    if (v == null || !(w > 0)) continue
    vSum += v * w
    wSum += w
  }
  return wSum > 0 ? vSum / wSum : null
}

// ============================================================================
// GP-BASIERTE BLEND-GEWICHTE (Auftrag Punkt 5/6) - HEURISTISCHE
// INITIALGEWICHTUNG, siehe Kommentar (B) oben. Bestimmt, wie stark Karriere
// vs. aktuelle Saison vs. Form in `overall` einfliessen, abhängig von der
// Anzahl bereits gespielter Spiele DIESER Saison (VOR dem Stichtag, siehe
// Data-Leakage-Schutz unten). Monoton: mehr aktuelle Spiele -> mehr Gewicht
// auf aktueller Saison/Form, weniger auf der (potenziell veralteten)
// Karriere-Basis - aber Karriere verschwindet nie ganz (ein Spieler bleibt
// nicht "vergessen", nur weil er gerade 12 starke Spiele hatte).
// ============================================================================
export const RATING_BLEND_WEIGHTS = [
  { maxGp: 0, career: 1.00, current: 0.00, form: 0.00 }, // noch keine Spiele dieser Saison (vor Stichtag)
  { maxGp: 4, career: 0.75, current: 0.25, form: 0.00 }, // 1-4 Spiele: Form-Fenster (min. 5) noch nicht verfügbar, aktuelle Saison nur gering gewichtet
  { maxGp: 9, career: 0.45, current: 0.35, form: 0.20 }, // 5-9 Spiele: Form verfügbar, darf stärker einfliessen
  { maxGp: Infinity, career: 0.25, current: 0.50, form: 0.25 }, // 10+ Spiele: "normale" Gewichtung
]

function blendWeightsForGp(gp) {
  for (const row of RATING_BLEND_WEIGHTS) if (gp <= row.maxGp) return row
  return RATING_BLEND_WEIGHTS[RATING_BLEND_WEIGHTS.length - 1]
}

// ============================================================================
// TOP-LEVEL-KOMPOSITION (Skater, aktuelle Saison) - HEURISTISCHE
// INITIALGEWICHTUNG (siehe B). Stürmer stärker über Offense, Verteidiger
// stärker über Defense+Usage - reines Domänenwissen, nicht backgetestet.
// ============================================================================
export const SKATER_TOP_WEIGHTS = {
  F: { offense: 0.40, defense: 0.15, specialTeams: 0.20, usage: 0.25 },
  D: { offense: 0.20, defense: 0.35, specialTeams: 0.15, usage: 0.30 },
}

const SKATER_MIN_BASELINE_N = 20 // identisch zur bestehenden Schwelle in advancedStats.js/playerHistory.js
// Torhüter sind eine deutlich kleinere Population (ca. 2-3 pro Team) - eine
// Schwelle von 20 würde die Baseline in der Praxis fast nie freischalten.
// Bewusst niedriger, klar als Abweichung dokumentiert (siehe A.1 oben).
const GOALIE_MIN_BASELINE_N = 6

// ============================================================================
// DATA-LEAKAGE-SCHUTZ (Auftrag Punkt 12) - EINZIGE Stelle, an der Spiele
// nach Datum gefiltert werden. `asOfDate` ist EXKLUSIV: Spiele mit
// `date < asOfDate` gelten als "damals bereits bekannt", ein Spiel GENAU an
// `asOfDate` (typischerweise das zu prognostizierende Spiel selbst) zählt
// NICHT dazu. Nur `status==='final'` Spiele fliessen ohnehin je in
// Kennzahlen ein (bestehende Konvention der gesamten Codebasis).
// ============================================================================
export function gamesBeforeDate(games, asOfDate) {
  return (games || []).filter((g) => g.status === 'final' && g.date < asOfDate)
}

// ============================================================================
// SKATER: erweiterte Positions-Baseline (aktuelle Saison) - dieselbe
// Methode/Schwelle wie advancedStats.js::buildAdvancedBaselines, aber um die
// zusätzlichen, hier benötigten Kennzahlen erweitert (PP-Tore/GP,
// SH-Punkte/GP, Goals-xG/GP, +/--/GP). Bewusst EIGENSTÄNDIG statt
// advancedStats.js zu verändern (Auftrag: "bestehende Ratings/Kennzahlen
// nicht überschreiben").
// ============================================================================
const SKATER_RATE_KEYS = [
  'pointsPerGame', 'goalsPerGame', 'assistsPerGame', 'sogPerGame', 'xgPerGame', 'goalsMinusXgPerGame',
  'toiPerGame', 'ppToiPerGame', 'pkToiPerGame', 'faceoffPercentage', 'blockedShotsPerGame',
  'plusMinusPerGame', 'powerplayGoalsPerGame', 'powerplayAssistsPerGame', 'shPointsPerGame',
]

// Ergänzt ein computeAdvancedStats()-Ergebnis um pro-Spiel-Ableitungen, die
// dort selbst (noch) nicht existieren (dortige Rückgabe bewusst
// unverändert gelassen, siehe Auftrag).
function deriveExtraSkaterRates(season) {
  if (!season) return {}
  const gp = season.gp
  const perGp = (total) => (total != null && gp > 0 ? total / gp : null)
  const shGoals = season.raw.shorthandedGoals, shAssists = season.raw.shorthandedAssists
  return {
    plusMinusPerGame: perGp(season.raw.plusMinus),
    goalsMinusXgPerGame: perGp(season.goalsMinusXg),
    powerplayGoalsPerGame: perGp(season.raw.powerplayGoals),
    powerplayAssistsPerGame: perGp(season.raw.powerplayAssists),
    shPointsPerGame: (shGoals != null || shAssists != null) ? perGp((shGoals || 0) + (shAssists || 0)) : null,
  }
}

function ratesFromSeason(season) {
  if (!season) return null
  return { ...season, ...deriveExtraSkaterRates(season) }
}

export function buildSkaterRatingBaselines(players, games) {
  const groups = { F: [], D: [] }
  for (const p of players || []) {
    if (!groups[p.position]) continue
    const season = computeAdvancedStats(collectPlayerGameStats(games, p.id))
    if (season) groups[p.position].push(ratesFromSeason(season))
  }
  const out = {}
  for (const pos of Object.keys(groups)) {
    const rows = groups[pos]
    out[pos] = { n: rows.length }
    for (const key of SKATER_RATE_KEYS) {
      const vals = rows.map((r) => r[key]).filter((v) => v != null)
      const m = mean(vals)
      out[pos][key] = { mean: m ?? 0, std: stdDev(vals, m ?? 0), n: vals.length }
    }
  }
  return out
}

// ============================================================================
// SKATER: aktuelle-Saison-Subratings (Offense/Defense/SpecialTeams/Usage) -
// alle als gewichteter z-Komposit ggü. der Positions-Baseline, siehe (B) für
// die Gewichtsbegründung. Goals-xG bewusst mit halbem Gewicht + engerem
// Clamp (Auftrag Punkt 8: "nicht übergewichten" - ein Spiel mit 2 Toren bei
// 0.4 xG soll das Offense-Rating spürbar, aber NICHT dominant anheben).
// Faceoff% als "Center-Signal" nur mit halbem Gewicht in usage (Auftrag
// Punkt 3/9) - siehe (A.4) zur Begründung, warum keine eigene Positionsgruppe.
// ============================================================================
function skaterSubRatings(rates, baseline, minN) {
  const offense = weightedZComposite(rates, baseline, [
    ['pointsPerGame', 1], ['goalsPerGame', 1], ['assistsPerGame', 1], ['sogPerGame', 1], ['xgPerGame', 1],
    ['goalsMinusXgPerGame', 0.5, 1.5],
  ], minN)
  const defense = weightedZComposite(rates, baseline, [
    ['plusMinusPerGame', 1], ['blockedShotsPerGame', 1], ['pkToiPerGame', 1],
  ], minN)
  const specialTeams = weightedZComposite(rates, baseline, [
    ['ppToiPerGame', 1], ['powerplayGoalsPerGame', 1], ['powerplayAssistsPerGame', 1], ['shPointsPerGame', 1],
  ], minN)
  const usage = weightedZComposite(rates, baseline, [
    ['toiPerGame', 1], ['ppToiPerGame', 1], ['pkToiPerGame', 1], ['faceoffPercentage', 0.5],
  ], minN)
  return { offense, defense, specialTeams, usage }
}

function skaterFormZ(rows, baseline, minN) {
  const window = rows.length >= 10 ? computeRollingAdvancedStats(rows, 10)
    : rows.length >= 5 ? computeRollingAdvancedStats(rows, 5) : null
  if (!window) return null
  const rates = ratesFromSeason(window)
  return weightedZComposite(rates, baseline, [
    ['pointsPerGame', 1], ['sogPerGame', 1], ['xgPerGame', 1], ['toiPerGame', 1],
  ], minN)
}

// ============================================================================
// GOALIE: aktuelle-Saison-Aggregation (eigenständig, siehe A.3 - kein
// Feldspieler-Pfad in advancedStats.js wiederverwendbar). `s.saves ?? s.savesNl`
// -Fallback-Muster identisch zu advancedStats.js (SIHF-Feld hat Vorrang,
// NL-Detail-Feld nur als Ersatz).
// ============================================================================
function collectGoalieGameRows(games, playerId) {
  const rows = []
  for (const g of games || []) {
    if (g.status !== 'final') continue
    const s = (g.playerStats || []).find((x) => x.playerId === playerId)
    if (!s) continue
    const isGoalieAppearance = s.saves != null || s.savesNl != null || s.shotsAgainst != null || s.goalsAgainst != null || s.goalsAgainstNl != null
    if (!isGoalieAppearance) continue
    rows.push({ game: g, s })
  }
  rows.sort((a, b) => (a.game.date < b.game.date ? -1 : a.game.date > b.game.date ? 1 : 0))
  return rows
}

function computeGoalieSeasonStats(rows) {
  if (!rows || rows.length === 0) return null
  const gp = rows.length
  let saves = 0, goalsAgainst = 0, shotsAgainst = 0, toiSec = 0, shutouts = 0
  let hasSaves = false, hasGA = false, hasSA = false, hasToi = false
  for (const { s } of rows) {
    const sv = s.saves ?? s.savesNl
    const ga = s.goalsAgainst ?? s.goalsAgainstNl
    const sa = s.shotsAgainst
    const toi = s.toiSec ?? s.toiSecNl
    if (sv != null) { saves += sv; hasSaves = true }
    if (ga != null) { goalsAgainst += ga; hasGA = true }
    if (sa != null) { shotsAgainst += sa; hasSA = true }
    if (toi != null) { toiSec += toi; hasToi = true }
    if (s.shutout) shutouts++
  }
  const savePct = hasSaves && hasSA && shotsAgainst > 0 ? saves / shotsAgainst
    : (hasGA && hasSA && shotsAgainst > 0 ? (shotsAgainst - goalsAgainst) / shotsAgainst : null)
  return {
    gp,
    saves: hasSaves ? saves : null,
    goalsAgainst: hasGA ? goalsAgainst : null,
    shotsAgainst: hasSA ? shotsAgainst : null,
    toiSec: hasToi ? toiSec : null,
    shutouts,
    savePct,
    gaa: hasGA && gp > 0 ? goalsAgainst / gp : null,
    toiPerGame: hasToi ? toiSec / gp : null,
    shutoutsPerGame: gp > 0 ? shutouts / gp : null,
  }
}

const GOALIE_RATE_KEYS = ['savePct', 'gaa', 'toiPerGame', 'shutoutsPerGame']

export function buildGoalieRatingBaselines(players, games) {
  const rows = []
  for (const p of players || []) {
    if (p.position !== 'G') continue
    const stats = computeGoalieSeasonStats(collectGoalieGameRows(games, p.id))
    if (stats) rows.push(stats)
  }
  const out = { n: rows.length }
  for (const key of GOALIE_RATE_KEYS) {
    const vals = rows.map((r) => r[key]).filter((v) => v != null)
    const m = mean(vals)
    out[key] = { mean: m ?? 0, std: stdDev(vals, m ?? 0), n: vals.length }
  }
  return out
}

// Karriere-Baseline für Torhüter (analog buildPositionBaselines in
// playerHistory.js, aber goalie-spezifisch - dort nicht vorhanden). Nutzt
// dieselbe computeGoalieCareerStats()-Funktion wie das bestehende
// Team-Depth-Feature (playerHistory.js), keine neue Karriere-Logik erfunden.
export function buildGoalieCareerBaseline(playerHistoryData) {
  const rows = []
  for (const rec of Object.values(playerHistoryData?.players || {})) {
    const stats = computeGoalieCareerStats(rec.seasons)
    if (stats) rows.push(stats)
  }
  const out = { n: rows.length }
  for (const key of ['savePct', 'gaa']) {
    const vals = rows.map((r) => r[key]).filter((v) => v != null)
    const m = mean(vals)
    out[key] = { mean: m ?? 0, std: stdDev(vals, m ?? 0), n: vals.length }
  }
  return out
}

// GAA: NIEDRIGER ist besser -> z-Score invertiert, bevor er mit dem SV%-
// z-Score (höher = besser) gemittelt wird.
function goalieCompositeZ(stats, baseline, minN) {
  if (!stats || !baseline) return null
  const comps = []
  const zSv = zOf(stats.savePct, baseline.savePct, minN)
  if (zSv != null) comps.push(zSv)
  const zGaaRaw = zOf(stats.gaa, baseline.gaa, minN)
  if (zGaaRaw != null) comps.push(-zGaaRaw)
  if (comps.length === 0) return null
  return mean(comps)
}

function goalieFormZ(rows, baseline, minN) {
  const n = rows.length >= 10 ? 10 : rows.length >= 5 ? 5 : 0
  if (n === 0) return null
  const stats = computeGoalieSeasonStats(rows.slice(-n))
  return goalieCompositeZ(stats, baseline, minN)
}

// ============================================================================
// CONFIDENCE (Auftrag Punkt 10) - 0-100, HEURISTISCHE INITIALGEWICHTUNG
// (siehe B). Drei Faktoren, gleich benannt wie im Auftrag gefordert:
//   - aktuelle-Saison-Stichprobe (sättigt bei 10 Spielen - identisch zur
//     "10+ Spiele = normale Gewichtung"-Schwelle oben, konsistent)
//   - Karriere-Stichprobe (sättigt bei 60 Karriere-Spielen)
//   - Datenqualität: Anteil der erwarteten Advanced-Komponenten, die
//     tatsächlich vorhanden sind (xG/Faceoffs/PP-PK-TOI etc. - manche
//     Spiele/Spieler haben keinen NL-Detail-Sync)
// ============================================================================
const CONFIDENCE_WEIGHTS = { currentGp: 0.40, careerGp: 0.35, dataQuality: 0.25 }
const CONFIDENCE_CURRENT_GP_SATURATION = 10
const CONFIDENCE_CAREER_GP_SATURATION = 60

function computeConfidence({ currentGp, careerGp, dataQualityFraction }) {
  const currentPart = clamp((currentGp || 0) / CONFIDENCE_CURRENT_GP_SATURATION, 0, 1)
  const careerPart = clamp((careerGp || 0) / CONFIDENCE_CAREER_GP_SATURATION, 0, 1)
  const dataPart = clamp(dataQualityFraction ?? 0, 0, 1)
  const score = currentPart * CONFIDENCE_WEIGHTS.currentGp
    + careerPart * CONFIDENCE_WEIGHTS.careerGp
    + dataPart * CONFIDENCE_WEIGHTS.dataQuality
  return Math.round(clamp(score, 0, 1) * 1000) / 10
}

// ============================================================================
// HAUPTFUNKTION (Auftrag Punkt 13)
// ============================================================================
//
// calculatePlayerRating(playerId, games, options)
//   options.players           - data.players (aktuelles Kader, für Position)
//   options.playerHistoryData - player-history.json-Objekt (optional, Karriere)
//   options.asOfDate           - siehe gamesBeforeDate() oben; Default: heute
//                                (ISO-Datum) - schliesst dadurch niemals
//                                zukünftige/noch nicht gespielte Spiele ein,
//                                selbst wenn `games` versehentlich welche
//                                enthält (Auftrag Punkt 12).
//   options.skaterBaselines/options.goalieBaselines/options.goalieCareerBaseline
//                               - optional vorab berechnete Baselines (Performance:
//                                 werden sonst pro Aufruf aus `games` gebaut).
//
// Rückgabe: null, wenn der Spieler nicht in `options.players` gefunden wird
// (Position unbekannt -> keine sinnvolle Bewertung möglich).
// ============================================================================
export function calculatePlayerRating(playerId, games, options = {}) {
  const player = (options.players || []).find((p) => p.id === playerId)
  if (!player) return null

  const asOfDate = options.asOfDate || new Date().toISOString().slice(0, 10)
  const pastGames = gamesBeforeDate(games, asOfDate)

  if (player.position === 'G') return calculateGoalieRating(player, pastGames, options, asOfDate)
  if (player.position === 'F' || player.position === 'D') return calculateSkaterRating(player, pastGames, options, asOfDate)
  return null // unbekannte/fehlende Position - nicht raten
}

function calculateSkaterRating(player, pastGames, options, asOfDate) {
  const posCode = player.position // 'F' | 'D'
  const posLabelHist = POSITION_LABEL[posCode] // 'Stürmer' | 'Verteidiger' (Karriere-Archiv-Label)

  const rows = collectPlayerGameStats(pastGames, player.id)
  const currentSeason = computeAdvancedStats(rows)
  const currentGp = currentSeason?.gp ?? 0

  const baseline = options.skaterBaselines || buildSkaterRatingBaselines(options.players, pastGames)
  const posBaseline = baseline[posCode]
  const rates = ratesFromSeason(currentSeason)

  const sub = rates ? skaterSubRatings(rates, posBaseline, SKATER_MIN_BASELINE_N) : { offense: null, defense: null, specialTeams: null, usage: null }
  const formZ = rows.length > 0 ? skaterFormZ(rows, posBaseline, SKATER_MIN_BASELINE_N) : null

  const topWeights = SKATER_TOP_WEIGHTS[posCode]
  const currentCompositeZ = weightedAvg([
    [sub.offense?.z, topWeights.offense],
    [sub.defense?.z, topWeights.defense],
    [sub.specialTeams?.z, topWeights.specialTeams],
    [sub.usage?.z, topWeights.usage],
  ])

  // Karriere (Auftrag Punkt 6) - wiederverwendet die bestehende, validierte
  // Impact-Score-Formel 1:1 (siehe playerHistory.js) statt eine neue
  // Karriere-Gewichtung zu erfinden. `careerBaselines` fehlt hier bewusst
  // eine eigene Berechnung - Aufrufer übergibt sie (sie hängen vom
  // vollständigen player-history.json ab, nicht von `games`), sonst bleibt
  // die Karriere-Komponente einfach unverfügbar (kein Fehler).
  const careerSeasons = options.playerHistoryData ? getPlayerSeasons(options.playerHistoryData, player.id) : []
  const careerBaselines = options.careerBaselines || (options.playerHistoryData ? buildPositionBaselines(options.playerHistoryData) : null)
  const careerImpact = careerBaselines ? computeImpactScore(careerSeasons, posLabelHist, careerBaselines) : null
  const careerZ = careerImpact?.zComposite ?? null
  const careerGp = careerImpact?.careerGp ?? 0

  const weights = blendWeightsForGp(currentGp)
  const overallZ = weightedAvg([
    [careerZ, weights.career],
    [currentCompositeZ, weights.current],
    [formZ?.z, weights.form],
  ])

  // Datenqualität für Confidence: welcher Anteil der current-season-Signale
  // (5 Sub-Kategorien-Bausteine) tatsächlich einen Wert lieferte.
  const availableComponents = [sub.offense, sub.defense, sub.specialTeams, sub.usage, formZ].filter((c) => c != null).length
  const confidence = computeConfidence({
    currentGp, careerGp,
    dataQualityFraction: currentSeason ? availableComponents / 5 : 0,
  })

  return {
    overall: zTo100(overallZ),
    overallZ, // roher, geblendeter z-Score VOR der 0-100-Transformation - z.B.
    // für src/playerRatingAdjustment.js, das eine additive ELO-Punkte-
    // Adjustierung aus dem z-Score selbst ableitet (nicht aus dem bereits
    // nichtlinear transformierten 0-100-Wert). Rein additives Feld, ändert
    // nichts an der bestehenden Berechnung/den bestehenden Feldern.
    confidence,
    offense: zTo100(sub.offense?.z),
    defense: zTo100(sub.defense?.z),
    specialTeams: zTo100(sub.specialTeams?.z),
    usage: zTo100(sub.usage?.z),
    form: zTo100(formZ?.z),
    sampleSize: { currentSeasonGp: currentGp, careerGp },
    position: posCode,
    asOfDate,
    components: {
      kind: 'skater',
      blendWeights: weights,
      topWeights,
      careerImpactScore: careerImpact?.score ?? null,
      currentCompositeZ,
      formZ: formZ?.z ?? null,
      rates,
      subRatingComponentsUsed: {
        offense: sub.offense?.componentsUsed ?? 0,
        defense: sub.defense?.componentsUsed ?? 0,
        specialTeams: sub.specialTeams?.componentsUsed ?? 0,
        usage: sub.usage?.componentsUsed ?? 0,
      },
      baselineN: posBaseline?.n ?? 0,
    },
  }
}

function calculateGoalieRating(player, pastGames, options, asOfDate) {
  const rows = collectGoalieGameRows(pastGames, player.id)
  const currentSeason = computeGoalieSeasonStats(rows)
  const currentGp = currentSeason?.gp ?? 0

  const baseline = options.goalieBaselines || buildGoalieRatingBaselines(options.players, pastGames)
  const seasonZ = currentSeason ? goalieCompositeZ(currentSeason, baseline, GOALIE_MIN_BASELINE_N) : null
  const usageZ = currentSeason ? zOf(currentSeason.toiPerGame, baseline.toiPerGame, GOALIE_MIN_BASELINE_N) : null
  const formZ = rows.length > 0 ? goalieFormZ(rows, baseline, GOALIE_MIN_BASELINE_N) : null

  const careerSeasons = options.playerHistoryData ? getPlayerSeasons(options.playerHistoryData, player.id) : []
  const careerStats = computeGoalieCareerStats(careerSeasons)
  const careerBaseline = options.goalieCareerBaseline || (options.playerHistoryData ? buildGoalieCareerBaseline(options.playerHistoryData) : null)
  const careerZ = careerStats && careerBaseline ? goalieCompositeZ(careerStats, careerBaseline, GOALIE_MIN_BASELINE_N) : null
  const careerGp = careerStats?.gp ?? 0

  const weights = blendWeightsForGp(currentGp)
  const overallZ = weightedAvg([
    [careerZ, weights.career],
    [seasonZ, weights.current],
    [formZ, weights.form],
  ])

  const availableComponents = [seasonZ, usageZ, formZ].filter((v) => v != null).length
  const confidence = computeConfidence({
    currentGp, careerGp,
    dataQualityFraction: currentSeason ? availableComponents / 3 : 0,
  })

  return {
    overall: zTo100(overallZ),
    overallZ, // siehe Kommentar in calculateSkaterRating() oben
    confidence,
    offense: null, // nicht anwendbar für Torhüter (Auftrag Punkt 11)
    defense: zTo100(seasonZ), // Shot-Stopping (SV%/GAA-Komposit) = das goalie-Äquivalent zu "Defense"
    specialTeams: null, // nicht anwendbar
    usage: zTo100(usageZ), // TOI/GP-Auslastung
    form: zTo100(formZ),
    sampleSize: { currentSeasonGp: currentGp, careerGp },
    position: 'G',
    asOfDate,
    components: {
      kind: 'goalie',
      blendWeights: weights,
      careerSavePct: careerStats?.savePct ?? null,
      careerGaa: careerStats?.gaa ?? null,
      season: currentSeason,
      formZ,
      baselineN: baseline?.n ?? 0,
    },
  }
}
