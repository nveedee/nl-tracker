// ---------------------------------------------------------------------------
// Scoreline-Probability-Matrix (Heim-/Auswärtstore-Verteilung EINES Spiels)
// + davon abgeleitete Match-Analytics (Torverteilung je Team, Expected
// Goals - siehe Abschnitt weiter unten). Bewusst ohne React/JSX, damit die
// reine Aggregation unabhängig vom DOM per node:test geprüft werden kann
// (siehe scorelineMatrix.test.js).
//
// KEINE eigene Simulations-/Zufallslogik: nimmt ausschliesslich bereits
// simulierte Einzelergebnisse entgegen (z.B. aus playoffSim.js::
// simulateGameResult(), n-mal aufgerufen - exakt dieselben Läufe, die
// MatchupDetail.jsx für die Heimsieg-/Auswärtssieg-Wahrscheinlichkeit und
// die "häufigsten Endresultate" ohnehin schon berechnet). `homeGoals`/
// `awayGoals` sind dabei bereits das FINALE Resultat (inkl. OT/SO-
// Entscheidungstor) - dieselbe Definition wie überall sonst auf der Seite
// (pHomeWin/pAwayWin/topScores basieren ebenfalls auf dem finalen Score,
// nicht auf dem 60-Minuten-Zwischenstand vor einem Unentschieden).
// ---------------------------------------------------------------------------

// 0, 1, 2, 3, 4, 5+ - Hockey-typische Bucket-Grenze (nicht 6+ wie im
// Fussball, siehe Auftrag: "0,1,2,3,4,5+").
export const SCORELINE_CAP = 5
export const SCORELINE_BUCKET_COUNT = SCORELINE_CAP + 1

// '0'..'4' oder '5+' für einen Bucket-Index.
export function scorelineLabel(bucketIndex) {
  return bucketIndex >= SCORELINE_CAP ? `${SCORELINE_CAP}+` : String(bucketIndex)
}

function emptyMatrix() {
  return Array.from({ length: SCORELINE_BUCKET_COUNT }, () => new Array(SCORELINE_BUCKET_COUNT).fill(0))
}

// Baut die Wahrscheinlichkeits-Matrix (Zeile = Heimtore-Bucket, Spalte =
// Auswärtstore-Bucket) aus rohen Simulationsergebnissen:
//   P(Heim = h UND Auswärts = a) = Anzahl Läufe mit exakt diesem Ergebnis
//                                   (bzw. "h+"/"a+" bei >= 5) / Anzahl aller
//                                   gültigen Läufe
// `results`: Array<{ homeGoals: number, awayGoals: number }> - ungültige
// Einträge (null/undefined, fehlende/nicht-endliche/negative Torzahlen)
// werden übersprungen, nicht gezählt, lösen aber keinen Fehler aus.
// Gibt bei leerer/vollständig ungültiger Eingabe eine Nullmatrix zurück
// (kein NaN, keine Division durch 0).
export function buildScorelineMatrix(results) {
  const counts = emptyMatrix()
  let counted = 0

  if (Array.isArray(results)) {
    for (const r of results) {
      if (!r) continue
      const { homeGoals, awayGoals } = r
      if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) continue
      if (homeGoals < 0 || awayGoals < 0) continue
      const h = Math.min(Math.floor(homeGoals), SCORELINE_CAP)
      const a = Math.min(Math.floor(awayGoals), SCORELINE_CAP)
      counts[h][a]++
      counted++
    }
  }

  if (counted === 0) return { matrix: emptyMatrix(), totalRuns: 0 }

  const matrix = counts.map((row) => row.map((c) => c / counted))
  return { matrix, totalRuns: counted }
}

// Summe aller Zellen (Sanity-Check: muss bei totalRuns > 0 exakt 1 ergeben -
// die "5+"-Faltung darf keine Wahrscheinlichkeitsmasse verlieren).
export function matrixSum(matrix) {
  return matrix.reduce((sum, row) => sum + row.reduce((s, v) => s + v, 0), 0)
}

export function maxCellProbability(matrix) {
  let max = 0
  for (const row of matrix) for (const v of row) if (v > max) max = v
  return max
}

// Kontinuierliche Opacity-Skala (keine 6 harten Farbstufen, siehe Auftrag) -
// relativ zur wahrscheinlichsten Zelle der Matrix normiert (sonst wären bei
// z.B. 36 Zellen selbst die stärkste Zelle nur ~10-15% linear und die
// Heatmap wirkt flach). sqrt() betont die mittleren Wahrscheinlichkeiten
// etwas stärker als eine lineare Skala (gleiches Prinzip wie bei den
// sequentiellen Heatmap-Rampen sonst im Projekt, hier aber eine einzelne
// Teamfarbe statt einer 7-stufigen RGB-Rampe - siehe ScorelineMatrix.jsx).
export function cellIntensity(prob, maxProb, { min = 0.05, max = 0.95 } = {}) {
  if (!Number.isFinite(prob) || prob <= 0 || !Number.isFinite(maxProb) || maxProb <= 0) return min
  const ratio = Math.max(0, Math.min(1, prob / maxProb))
  return min + (max - min) * Math.sqrt(ratio)
}

// ---------------------------------------------------------------------------
// Goal Distribution + Expected Goals (Erweiterung: "Goal Probabilities by
// Team" + "Expected Goals"-Module auf der Match-Detailseite).
//
// Bewusst EIN Bucket-Cap höher als die Scoreline-Matrix (6+ statt 5+, siehe
// Auftrag: "Im Hockey sind höhere Torzahlen normaler... 0,1,2,3,4,5,6+" für
// die reine Team-Tordichte). Würde man die Heim-/Auswärts-Verteilung stur
// aus der bereits 5+-gefalteten Scoreline-Matrix ableiten (wie Abschnitt 5
// des Auftrags es als Grundidee beschreibt), liesse sich "genau 5" nicht
// mehr von "6, 7, 8, ..." unterscheiden - die Matrix hat diese Information
// durch ihr eigenes, gröberes Cap bereits verworfen. Home-/Away-Distribution
// UND Expected Goals werden deshalb beide direkt aus denselben ROHEN
// Simulationsergebnissen (`results`, exakt dieselbe Liste wie
// buildScorelineMatrix() oben bekommt) neu aggregiert - dieselbe
// Datenquelle, nur mit jeweils eigenem, für den Anwendungsfall passenden
// Bucket-Cap statt eines gemeinsamen, verlustbehafteten Zwischenschritts.
// Macht Scoreline-Matrix, Goal-Distribution und Expected Goals automatisch
// konsistent zueinander (alle drei aus derselben Stichprobe), ohne drei
// separate Modelle zu pflegen.
export const GOAL_DIST_CAP = 6
export const GOAL_DIST_BUCKET_COUNT = GOAL_DIST_CAP + 1

export function distributionLabel(bucketIndex) {
  return bucketIndex >= GOAL_DIST_CAP ? `${GOAL_DIST_CAP}+` : String(bucketIndex)
}

// Torverteilung EINES Teams (`teamKey`: 'homeGoals' oder 'awayGoals') aus
// denselben rohen Simulationsergebnissen wie buildScorelineMatrix(). Gleiche
// Validierung/Fehlertoleranz (ungültige Einträge werden übersprungen, keine
// Exception, Nullverteilung bei leerer/vollständig ungültiger Eingabe).
export function buildGoalDistribution(results, teamKey) {
  const counts = new Array(GOAL_DIST_BUCKET_COUNT).fill(0)
  let counted = 0

  if (Array.isArray(results)) {
    for (const r of results) {
      if (!r) continue
      const g = r[teamKey]
      if (!Number.isFinite(g) || g < 0) continue
      counts[Math.min(Math.floor(g), GOAL_DIST_CAP)]++
      counted++
    }
  }

  if (counted === 0) return { distribution: new Array(GOAL_DIST_BUCKET_COUNT).fill(0), totalRuns: 0 }
  return { distribution: counts.map((c) => c / counted), totalRuns: counted }
}

// Summe einer 1D-Verteilung (Sanity-Check: muss bei totalRuns > 0 exakt 1 ergeben).
export function distributionSum(distribution) {
  return (distribution || []).reduce((s, v) => s + v, 0)
}

export function maxDistributionValue(distribution) {
  return (distribution || []).reduce((m, v) => (v > m ? v : m), 0)
}

// Expected Goals: Ø tatsächlich simulierter Tore je Team, NICHT die
// Fussball-xG-Definition (siehe Auftrag: "Home xG = Durchschnitt der
// simulierten Heimtore"). Rechnet direkt über die UNGECAPPTE Rohsumme
// (7, 8, 9 Tore zählen also mit ihrem echten Wert, nicht als "6+"/6) -
// mathematisch identisch zu Σ(h × P(h,a)) über die ungefaltete Verteilung,
// hier aber als einfacher Mittelwert über die Rohdaten (Auftrag: "Falls die
// Simulation direkt die einzelnen Simulationsergebnisse besitzt, kann
// alternativ einfach der Mittelwert verwendet werden" - beide Methoden sind
// für dieselbe Stichprobe rechnerisch identisch).
export function expectedGoals(results) {
  let sumHome = 0, sumAway = 0, counted = 0
  if (Array.isArray(results)) {
    for (const r of results) {
      if (!r) continue
      const { homeGoals, awayGoals } = r
      if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) continue
      if (homeGoals < 0 || awayGoals < 0) continue
      sumHome += homeGoals
      sumAway += awayGoals
      counted++
    }
  }
  if (counted === 0) return { homeXG: 0, awayXG: 0, totalXG: 0, totalRuns: 0 }
  const homeXG = sumHome / counted
  const awayXG = sumAway / counted
  return { homeXG, awayXG, totalXG: homeXG + awayXG, totalRuns: counted }
}
