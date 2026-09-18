// ---------------------------------------------------------------------------
// Erweiterte, spielbasierte Spieler-Kennzahlen - reine Berechnungsebene über
// die zusätzlichen Felder, die server/nlGameDetailSync.js in
// `game.playerStats[]` (Faceoffs, Blocks, PP/PK-TOI, Special-Teams-Tore, xG)
// und `game.nlShots` (rohe Schuss-Daten je Spiel) ablegt.
//
// Analog zu src/playerHistory.js (Karriere-/Saison-Kennzahlen aus dem
// historischen Mehrsaison-Archiv), aber für die NEUEN, spielbasierten
// NL-Detail-Felder der LAUFENDEN Saison (`data.games`, nicht
// player-history.json). Bewusst als eigenes Modul, nicht in
// src/playerHistory.js/stats.js verschoben - andere Datenquelle, andere
// Granularität (Spiel- statt Saison-Ebene), keine bestehende Datei
// umgebaut.
//
// Prinzip (identisch zum Rest der Codebasis, siehe Auftrag Punkt 6): fehlt
// ein Feld für ALLE betrachteten Spiele (z.B. weil der Game-Detail-Sync für
// diese Spiele noch nicht gelaufen ist, oder ein reiner SIHF-Datensatz ohne
// NL-Detail-Ergänzung vorliegt), liefert die jeweilige Kennzahl `null` -
// nie geschätzt, nie mit 0 aufgefüllt. NOCH KEIN UI - nur Datenmodell +
// Berechnung (siehe Auftrag Punkt 9).
// ---------------------------------------------------------------------------

// Summiert `key` über die Boxscore-Zeilen; `null`, wenn KEINE Zeile einen
// Wert für dieses Feld trägt (statt einer irreführenden 0 bei fehlenden
// Daten - z.B. Spiele vor Einführung des Game-Detail-Syncs).
function sum(rows, key) {
  let total = 0, any = false
  for (const s of rows) {
    const v = s?.[key]
    if (v != null) { total += v; any = true }
  }
  return any ? total : null
}

function safeDiv(a, b) {
  return a != null && b != null && b > 0 ? a / b : null
}

// Ein Spieler-Boxscore-Eintrag + die Anzahl seiner rohen Schuss-Versuche in
// diesem Spiel (GOAL+SOG+MISS+BLOCK aus game.nlShots, siehe
// server/nlGameDetailSync.js::normalizeShot) - eindeutiger als die
// Schuss-Teilfelder der Boxscore-Zeile selbst zu addieren (dort ist z.B.
// nicht dokumentiert, ob `sog` Tore einschliesst).
function countShotAttempts(game, playerId) {
  if (!game.nlShots) return null
  const all = [...(game.nlShots.home || []), ...(game.nlShots.away || [])]
  const mine = all.filter((sh) => sh.playerId === playerId)
  return mine.length > 0 ? mine.length : (all.some((sh) => sh.playerId != null) ? 0 : null)
}

// Alle abgeschlossenen Spiele eines Spielers (chronologisch), jeweils mit
// seiner Boxscore-Zeile + Schuss-Versuchs-Anzahl. `games` = data.games
// (laufende Saison, wie überall sonst in der App).
export function collectPlayerGameStats(games, playerId) {
  const rows = []
  for (const g of games || []) {
    if (g.status !== 'final') continue
    const s = (g.playerStats || []).find((x) => x.playerId === playerId)
    if (!s) continue
    rows.push({ game: g, s, shotAttempts: countShotAttempts(g, playerId) })
  }
  rows.sort((a, b) => (a.game.date < b.game.date ? -1 : a.game.date > b.game.date ? 1 : 0))
  return rows
}

// Aggregierte Advanced Stats über eine Menge von Spiel-Zeilen (ganze Saison
// oder ein Ausschnitt, siehe computeRollingXg unten). `rows` = (Ausschnitt
// von) collectPlayerGameStats().
export function computeAdvancedStats(rows) {
  if (!rows || rows.length === 0) return null
  const gp = rows.length
  const s = rows.map((r) => r.s)

  const goals = sum(s, 'goals')
  const assists = sum(s, 'assists')
  const points = sum(s, 'points') ?? (goals != null && assists != null ? goals + assists : null)
  const sog = sum(s, 'sog') ?? sum(s, 'shotsOnGoalNl')
  const blockedShots = sum(s, 'blockedShots')
  const toiSec = sum(s, 'toiSec') ?? sum(s, 'toiSecNl')
  const toiEqSec = sum(s, 'toiEqSec')
  const toiPpSec = sum(s, 'toiPpSec')
  const toiPkSec = sum(s, 'toiPkSec')
  const pim = sum(s, 'penaltyMinutes') ?? sum(s, 'pim')
  const plusMinus = sum(s, 'plusMinus') ?? sum(s, 'plusMinusNl')
  const fow = sum(s, 'faceoffsWon')
  const fol = sum(s, 'faceoffsLost')
  const foTotal = fow != null && fol != null ? fow + fol : sum(s, 'faceoffsTotal')
  const powerplayGoals = sum(s, 'powerplayGoals')
  const powerplayAssists = sum(s, 'powerplayAssists')
  const shorthandedGoals = sum(s, 'shorthandedGoals')
  const shorthandedAssists = sum(s, 'shorthandedAssists')
  const gameWinningGoals = sum(s, 'gameWinningGoals')
  const xg = sum(s, 'xg')
  const shotAttempts = rows.some((r) => r.shotAttempts != null) ? rows.reduce((acc, r) => acc + (r.shotAttempts || 0), 0) : null

  return {
    gp,
    pointsPerGame: safeDiv(points, gp),
    goalsPerGame: safeDiv(goals, gp),
    assistsPerGame: safeDiv(assists, gp),
    sogPerGame: safeDiv(sog, gp),
    shootingPercentage: safeDiv(goals, sog), // Tore / Schüsse aufs Tor
    toiPerGame: safeDiv(toiSec, gp),
    eqToiPerGame: safeDiv(toiEqSec, gp),
    ppToiPerGame: safeDiv(toiPpSec, gp),
    pkToiPerGame: safeDiv(toiPkSec, gp),
    faceoffPercentage: safeDiv(fow, foTotal),
    blockedShotsPerGame: safeDiv(blockedShots, gp),
    penaltyMinutesPerGame: safeDiv(pim, gp),
    plusMinus,
    xg,
    xgPerGame: safeDiv(xg, gp),
    xgPerShot: safeDiv(xg, shotAttempts),
    goalsMinusXg: goals != null && xg != null ? goals - xg : null,
    powerplayGoalsPerGame: safeDiv(powerplayGoals, gp),
    powerplayAssistsPerGame: safeDiv(powerplayAssists, gp),
    shorthandedGoals,
    shorthandedAssists,
    gameWinningGoals,
    raw: {
      goals, assists, points, sog, shotAttempts, blockedShots, toiSec, toiEqSec, toiPpSec, toiPkSec, pim, plusMinus,
      faceoffsWon: fow, faceoffsLost: fol, faceoffsTotal: foTotal,
      powerplayGoals, powerplayAssists, shorthandedGoals, shorthandedAssists, gameWinningGoals, xg,
    },
  }
}

// Rollierende xG-/Advanced-Stats-Fenster (Punkt 7: "rolling xG last 5/10") -
// `null`, wenn weniger als `n` Spiele mit Boxscore-Daten vorliegen (keine
// Berechnung auf zu wenig Datenbasis, gleiches Prinzip wie
// computeRollingForm() in src/playerHistory.js).
export function computeRollingAdvancedStats(rows, n) {
  if (!rows || rows.length < n) return null
  return computeAdvancedStats(rows.slice(-n))
}

// Bequemlichkeits-Wrapper: Saison- + rollierende (letzte 5/10) Advanced
// Stats für EINEN Spieler in einem Aufruf (Player-Profile-Nutzung, Punkt 9).
export function computePlayerAdvancedStats(games, playerId) {
  const rows = collectPlayerGameStats(games, playerId)
  return {
    season: computeAdvancedStats(rows),
    last5: computeRollingAdvancedStats(rows, 5),
    last10: computeRollingAdvancedStats(rows, 10),
    gamesWithDetail: rows.filter((r) => r.s.xg != null || r.s.faceoffsTotal != null).length,
    gamesTotal: rows.length,
  }
}

// ---------------------------------------------------------------------------
// POSITIONSRELATIVE PERZENTILE (Auftrag Punkt 10) - für die NEUEN, spiel-
// basierten Kennzahlen der LAUFENDEN Saison. Bewusst dieselbe Statistik-Basis
// (mean/stdDev/normalCdf, aus src/playerHistory.js re-exportiert statt
// dupliziert) und dieselbe Baseline-FORM ({ [position]: { [key]: {mean,std,n} } })
// wie buildPositionBaselines() dort - dadurch ist die bestehende
// <PercentileRow>-UI-Komponente (src/pages/PlayerDetail.jsx) unverändert
// wiederverwendbar, nur mit einer zweiten Baseline-Quelle.
//
// EIGENSTÄNDIG von playerHistory.js: andere Datenquelle (aktuelle Saison aus
// data.games statt Karriere-Archiv aus player-history.json), andere
// Kennzahlen (xG/PP-TOI/PK-TOI/Faceoff% existieren im Archiv gar nicht).
// ---------------------------------------------------------------------------

import { mean, stdDev, normalCdf } from './playerHistory.js'

const MIN_BASELINE_N = 20 // gleiche Schwelle wie playerHistory.js::computePercentile - zu kleine Stichprobe sonst irreführend

const ADVANCED_RATE_KEYS = [
  'pointsPerGame', 'goalsPerGame', 'assistsPerGame', 'sogPerGame', 'toiPerGame',
  'ppToiPerGame', 'pkToiPerGame', 'faceoffPercentage', 'blockedShotsPerGame', 'xgPerGame',
]

// Baut die Positions-Baseline (Mittel/Std je Kennzahl, F/D getrennt) über
// ALLE aktuellen Kader-Feldspieler mit mindestens einem abgeschlossenen
// Spiel dieser Saison. `players`/`games` = data.players/data.games (laufende
// Saison, wie überall sonst in der App) - reine Berechnung, kein Netzwerk-
// zugriff, keine React-Abhängigkeit (Memoization ist Aufgabe des Aufrufers,
// siehe usePositionBaselines()-Muster in playerHistory.js).
export function buildAdvancedBaselines(players, games) {
  const groups = { Stürmer: [], Verteidiger: [] }
  for (const p of players || []) {
    const posLabel = p.position === 'F' ? 'Stürmer' : p.position === 'D' ? 'Verteidiger' : null
    if (!posLabel) continue
    const season = computeAdvancedStats(collectPlayerGameStats(games, p.id))
    if (season) groups[posLabel].push(season)
  }
  const out = {}
  for (const pos of Object.keys(groups)) {
    const rows = groups[pos]
    out[pos] = { n: rows.length }
    for (const key of ADVANCED_RATE_KEYS) {
      const vals = rows.map((r) => r[key]).filter((v) => v != null)
      const m = mean(vals)
      out[pos][key] = { mean: m ?? 0, std: stdDev(vals, m ?? 0), n: vals.length }
    }
  }
  return out
}

// Perzentil (0-100) EINER Kennzahl für einen Wert ggü. der Positions-
// Baseline - identisches Prinzip/identische Signatur wie
// playerHistory.js::computePercentile (bewusst kompatibel, siehe
// Dateikopfkommentar), nur mit der hier gebauten Baseline.
export function computeAdvancedPercentile(value, position, key, baselines) {
  if (value == null || !baselines?.[position]?.[key] || baselines[position][key].n < MIN_BASELINE_N) return null
  const b = baselines[position][key]
  const z = (value - b.mean) / b.std
  return Math.round(normalCdf(z) * 1000) / 10
}

// ---------------------------------------------------------------------------
// ZUSÄTZLICHES, EIGENSTÄNDIGES "Season Impact Signal" (Auftrag Punkt 11).
//
// Der bestehende, karriere-validierte Impact Score (computeImpactScore in
// src/playerHistory.js, Spearman-stabilitätsgeprüfte 4-Komponenten-Formel
// P/GP+TOI/GP+/-/GP+SOG/GP) wird NICHT verändert/erweitert - eine
// nachträgliche Erweiterung um weitere Komponenten würde die dortige
// Validierung (Jahr-zu-Jahr-Stabilität, Positions-Fairness) entwerten, ohne
// dass diese neuen, spielbasierten Signale (erst seit dieser Saison
// verfügbar) auf dieselbe Weise geprüft werden konnten - "nachvollziehbar
// bleiben" (Auftrag) heisst hier: die validierte Formel bleibt unangetastet.
//
// Stattdessen: ein ZWEITER, klar als "aktuelle Saison" gekennzeichneter
// Score mit GENAU dem von der Aufgabe vorgeschlagenen Signal-Set (xG/GP,
// SOG/GP, TOI/GP, PP-TOI, PK-TOI, Faceoff%, Blocked Shots/GP) - exakt
// dieselbe, bereits etablierte Methode (z-Score je verfügbarer Komponente,
// GLEICHGEWICHTET gemittelt, über normalCdf auf 0-100 abgebildet) wie beim
// bestehenden Score, damit KEINE neue, ungeprüfte Gewichtung erfunden wird.
// Fehlende Komponenten werden übersprungen (nicht mit 0 aufgefüllt), null
// bei 0 verfügbaren Komponenten.
// ---------------------------------------------------------------------------

const SEASON_SIGNAL_KEYS = ['xgPerGame', 'sogPerGame', 'toiPerGame', 'ppToiPerGame', 'pkToiPerGame', 'faceoffPercentage', 'blockedShotsPerGame']

export function computeCurrentSeasonAdvancedScore(season, position, baselines) {
  if (!season || !baselines?.[position]) return null
  const b = baselines[position]
  const components = []
  for (const key of SEASON_SIGNAL_KEYS) {
    const v = season[key]
    if (v != null && b[key]?.n >= MIN_BASELINE_N) components.push((v - b[key].mean) / b[key].std)
  }
  if (components.length === 0) return null
  const z = mean(components)
  return { score: Math.round(normalCdf(z) * 1000) / 10, componentsUsed: components.length }
}

// ---------------------------------------------------------------------------
// SHOT-DATEN (Auftrag Punkt 3, Shotmap) - alle rohen Schüsse eines Spielers
// über die Saison, unverändert aus game.nlShots übernommen (siehe
// server/nlGameDetailSync.js::normalizeShot) - KEINE Koordinaten-Transformation/
// -Normalisierung (Heim-/Auswärts-Seitenwechsel pro Drittel ist nicht
// verifiziert, siehe Bericht - Rohdaten werden 1:1 weitergereicht, nichts
// "korrigiert" oder erfunden).
// ---------------------------------------------------------------------------

// Feste Koordinatengrenzen der National-League-API (empirisch verifiziert,
// siehe Bericht: raw.posXPercentage === raw.posX / 30 und
// raw.posYPercentage === raw.posY / 24 bei ALLEN gültigen Schüssen in
// mehreren realen, abgeschlossenen Spielen - X = seitliche Position über
// die Eisbreite [0,30] (deckt sich exakt mit der offiziellen 30m-Breite
// eines Schweizer/europäischen Rinks), Y = Tiefe ab Torlinie in Richtung
// Angriffszone [0,24]. KEINE Heim-/Auswärts- oder Drittel-Spiegelung nötig
// (X/Y-Wertebereiche bleiben für ein Team über alle 3 Drittel stabil, Tor-
// Events beider Teams verteilen sich über denselben Wertebereich statt in
// zwei getrennte Hälften zu zerfallen - die API liefert die Koordinaten
// bereits in einer einheitlichen, angreiferrelativen Ausrichtung).
export const SHOT_MAP_X_MAX = 30
export const SHOT_MAP_Y_MAX = 24

// Manche Schüsse tragen fehlerhafte Rohkoordinaten aus der API selbst
// (posXPercentage/posYPercentage > 1, verifiziert an echten Spielen - ein
// Datenqualitätsproblem der Quelle, kein Rechenfehler hier) - diese müssen
// aus der Shotmap-Darstellung gefiltert werden statt sie zu clampen oder
// als echte Position zu vertrauen.
export function isValidShotCoordinate(shot) {
  return (
    shot?.x != null && shot?.y != null &&
    shot.x >= 0 && shot.x <= SHOT_MAP_X_MAX &&
    shot.y >= 0 && shot.y <= SHOT_MAP_Y_MAX
  )
}

export function collectPlayerShots(games, playerId) {
  const shots = []
  for (const g of games || []) {
    if (g.status !== 'final' || !g.nlShots) continue
    for (const side of ['home', 'away']) {
      for (const s of g.nlShots[side] || []) {
        if (s.playerId === playerId) shots.push({ ...s, gameId: g.id, date: g.date })
      }
    }
  }
  shots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.gameSecond ?? 0) - (b.gameSecond ?? 0)))
  return shots
}

// Neutrale, rein datenbeschreibende Formulierung (Auftrag Punkt 4/8 -
// explizit KEINE Labels wie "Lucky"/"Unlucky", KEINE Interpretation im
// Sinne von Erwartung/Überperformance - gerade bei kleiner Spielanzahl (z.B.
// n=1) ist "mehr Tore als zu erwarten wäre" eine zu starke Aussage für eine
// Kennzahl, die noch kaum statistisches Gewicht hat. Beschreibt nur das
// Verhältnis der beiden Werte zueinander, ohne es zu bewerten). `threshold`:
// unterhalb dieser Differenz (Standard 1 Tor) gilt die Bilanz als ungefähr
// im Rahmen des xG-Werts - vermeidet eine Aussage bei einer Differenz von
// z.B. 0.2 Toren, die keine erkennbare Tendenz zeigt.
export function describeGoalsVsXg(goals, xg, threshold = 1) {
  if (goals == null || xg == null) return null
  const diff = goals - xg
  // 2 Nachkommastellen - dieselbe Präzision wie der "xG total"-Wert im
  // selben Advanced-Analytics-Block (AdvancedAnalyticsCard.jsx, fmt2()) -
  // sonst weicht der Text (z.B. "0.8") optisch vom danebenstehenden Wert
  // (z.B. "0.77") ab, obwohl beide dieselbe Zahl meinen.
  const xgLabel = xg.toFixed(2)
  if (Math.abs(diff) < threshold) return `Die erzielten Tore (${goals}) entsprechen etwa dem kumulierten xG-Wert (${xgLabel}).`
  if (diff > 0) return `In den bisher erfassten Spielen liegen die erzielten Tore (${goals}) über dem kumulierten xG-Wert (${xgLabel}).`
  return `In den bisher erfassten Spielen liegen die erzielten Tore (${goals}) unter dem kumulierten xG-Wert (${xgLabel}).`
}

// ---------------------------------------------------------------------------
// SMALL-SAMPLE-GATING (Auftrag Punkt 7) - für die AKTUELLE Saison, spiel-
// basierten Perzentile/das "Season-Signal" oben (NICHT für den karriere-
// validierten Impact Score in src/playerHistory.js, der bleibt unangetastet,
// siehe Kommentar dort). Nach wenigen Spielen sind einzelne Ausreisser
// (z.B. 1 Tor bei 1 Spiel) statistisch bedeutungslos, aber optisch extrem
// (100. Perzentil) - das ist technisch korrekt, aber analytisch irreführend.
// Bewusst KEIN neutraler Platzhalterwert wie 50 (das wäre selbst erfunden/
// geraten) - stattdessen wird die betroffene UI ganz ausgeblendet (< 5
// Spiele) bzw. mit einer Warnung versehen (< 10 Spiele).
// ---------------------------------------------------------------------------

export const SEASON_SIGNAL_HIDE_BELOW_GP = 5
export const SEASON_SIGNAL_WARN_BELOW_GP = 10

// `gp` = Anzahl Spiele mit Game-Detail-Daten dieser Saison (advanced.season.gp).
// `level`: 'none' (keine Daten), 'hidden' (< 5 Spiele - Perzentile/Signal
// nicht anzeigen), 'warn' (5-9 Spiele - anzeigen, aber mit Hinweis), 'ok'
// (>= 10 Spiele - keine Einschränkung).
export function seasonSampleQuality(gp) {
  if (gp == null || gp <= 0) return { level: 'none', hide: true, warning: null }
  if (gp < SEASON_SIGNAL_HIDE_BELOW_GP) {
    return {
      level: 'hidden',
      hide: true,
      warning: `Kleine Stichprobe (${gp} Spiel${gp === 1 ? '' : 'e'}) - Perzentile und Season-Signal dieser Saison werden erst ab ${SEASON_SIGNAL_HIDE_BELOW_GP} Spielen angezeigt.`,
    }
  }
  if (gp < SEASON_SIGNAL_WARN_BELOW_GP) {
    return {
      level: 'warn',
      hide: false,
      warning: `Geringe Stichprobengrösse (${gp} Spiele) - Perzentile und Season-Signal dieser Saison sind noch wenig belastbar.`,
    }
  }
  return { level: 'ok', hide: false, warning: null }
}
