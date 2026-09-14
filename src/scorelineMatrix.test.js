// ---------------------------------------------------------------------------
// Unit-Tests für die Scoreline-Matrix-Aggregation (src/scorelineMatrix.js) -
// reine Zähl-/Aggregationslogik, unabhängig von der Monte-Carlo-Engine
// selbst (die liefert nur die rohen {homeGoals, awayGoals}-Resultate).
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildScorelineMatrix, matrixSum, maxCellProbability, cellIntensity,
  scorelineLabel, SCORELINE_CAP, SCORELINE_BUCKET_COUNT,
  buildGoalDistribution, distributionSum, maxDistributionValue, distributionLabel,
  expectedGoals, GOAL_DIST_CAP, GOAL_DIST_BUCKET_COUNT,
} from './scorelineMatrix.js'

test('einfache bekannte Scoreline-Verteilung: exakte Zellwerte', () => {
  // 4 Läufe: 2x 0:0, 1x 1:0, 1x 2:1 -> erwartete Wahrscheinlichkeiten exakt
  // 0.5 / 0.25 / 0.25 in den jeweiligen Zellen, alle anderen 0.
  const results = [
    { homeGoals: 0, awayGoals: 0 },
    { homeGoals: 0, awayGoals: 0 },
    { homeGoals: 1, awayGoals: 0 },
    { homeGoals: 2, awayGoals: 1 },
  ]
  const { matrix, totalRuns } = buildScorelineMatrix(results)
  assert.equal(totalRuns, 4)
  assert.equal(matrix[0][0], 0.5)
  assert.equal(matrix[1][0], 0.25)
  assert.equal(matrix[2][1], 0.25)
  assert.equal(matrix[3][2], 0) // nie beobachtet -> exakt 0, kein NaN
})

test('5+ Aggregation: Heim/Auswärts >= 5 fallen in den letzten Bucket, auch bei sehr hohen Torzahlen', () => {
  const results = [
    { homeGoals: 5, awayGoals: 2 },
    { homeGoals: 6, awayGoals: 2 },
    { homeGoals: 9, awayGoals: 0 },
    { homeGoals: 3, awayGoals: 5 },
    { homeGoals: 7, awayGoals: 8 },
  ]
  const { matrix, totalRuns } = buildScorelineMatrix(results)
  assert.equal(totalRuns, 5)
  // 5:2, 6:2, 9:0 landen alle im Heim-Bucket "5+" (Index SCORELINE_CAP).
  assert.equal(matrix[SCORELINE_CAP][2], 2 / 5) // 5:2 und 6:2
  assert.equal(matrix[SCORELINE_CAP][0], 1 / 5) // 9:0
  assert.equal(matrix[3][SCORELINE_CAP], 1 / 5) // 3:5
  assert.equal(matrix[SCORELINE_CAP][SCORELINE_CAP], 1 / 5) // 7:8 -> 5+:5+
  assert.equal(scorelineLabel(SCORELINE_CAP), '5+')
  assert.equal(scorelineLabel(4), '4')
  assert.equal(scorelineLabel(0), '0')
})

test('Summe aller Zellen ergibt (nach der 5+-Faltung) exakt 1 - keine Wahrscheinlichkeitsmasse geht verloren', () => {
  const results = []
  for (let h = 0; h <= 9; h++) {
    for (let a = 0; a <= 9; a++) {
      results.push({ homeGoals: h, awayGoals: a }) // je 1x, 100 gleich gewichtete Kombinationen
    }
  }
  const { matrix } = buildScorelineMatrix(results)
  assert.ok(Math.abs(matrixSum(matrix) - 1) < 1e-9)
})

test('nie beobachtete Zellen sind exakt 0 (kein NaN, keine Fantasiewerte)', () => {
  const results = [{ homeGoals: 1, awayGoals: 1 }]
  const { matrix } = buildScorelineMatrix(results)
  for (let h = 0; h < SCORELINE_BUCKET_COUNT; h++) {
    for (let a = 0; a < SCORELINE_BUCKET_COUNT; a++) {
      if (h === 1 && a === 1) continue
      assert.equal(matrix[h][a], 0)
      assert.ok(!Number.isNaN(matrix[h][a]))
    }
  }
})

test('fehlende/ungültige Daten: leeres Array, null/undefined, negative oder nicht-finite Torzahlen werfen nicht und ergeben eine Nullmatrix statt NaN', () => {
  assert.equal(buildScorelineMatrix([]).totalRuns, 0)
  for (const row of buildScorelineMatrix([]).matrix) for (const v of row) assert.equal(v, 0)
  assert.equal(buildScorelineMatrix(null).totalRuns, 0)
  assert.equal(buildScorelineMatrix(undefined).totalRuns, 0)

  const messy = [
    null,
    undefined,
    { homeGoals: -1, awayGoals: 2 },
    { homeGoals: 2, awayGoals: NaN },
    { homeGoals: Infinity, awayGoals: 1 },
    { homeGoals: 1 }, // awayGoals fehlt
    {},
  ]
  const { matrix, totalRuns } = buildScorelineMatrix(messy)
  assert.equal(totalRuns, 0, 'alle Einträge sind ungültig - kein gültiger Lauf')
  for (const row of matrix) for (const v of row) assert.equal(v, 0)

  // Ein einzelner gültiger Lauf zwischen lauter ungültigen wird trotzdem korrekt gezählt.
  const mixed = [...messy, { homeGoals: 3, awayGoals: 2 }]
  const result2 = buildScorelineMatrix(mixed)
  assert.equal(result2.totalRuns, 1)
  assert.equal(result2.matrix[3][2], 1)
})

test('unterschiedliche Heim-/Auswärtsteams: Zeile=Heim, Spalte=Auswärts werden nicht vertauscht (Matrix ist im Allgemeinen nicht symmetrisch)', () => {
  // Bewusst asymmetrische Verteilung: Heimteam trifft öfter als das
  // Auswärtsteam - matrix[3][1] (Heim 3, Auswärts 1) muss sich klar von
  // matrix[1][3] (Heim 1, Auswärts 3) unterscheiden.
  const results = [
    { homeGoals: 3, awayGoals: 1 },
    { homeGoals: 3, awayGoals: 1 },
    { homeGoals: 3, awayGoals: 1 },
    { homeGoals: 1, awayGoals: 3 },
  ]
  const { matrix } = buildScorelineMatrix(results)
  assert.equal(matrix[3][1], 0.75)
  assert.equal(matrix[1][3], 0.25)
  assert.notEqual(matrix[3][1], matrix[1][3])
})

test('maxCellProbability findet das tatsächliche Maximum über die ganze Matrix', () => {
  const { matrix } = buildScorelineMatrix([
    { homeGoals: 2, awayGoals: 1 },
    { homeGoals: 2, awayGoals: 1 },
    { homeGoals: 2, awayGoals: 1 },
    { homeGoals: 0, awayGoals: 0 },
  ])
  assert.equal(maxCellProbability(matrix), 0.75)
  assert.equal(maxCellProbability(buildScorelineMatrix([]).matrix), 0)
})

test('cellIntensity: 0-Wahrscheinlichkeit -> Minimum, wahrscheinlichste Zelle -> Maximum, monoton dazwischen', () => {
  assert.equal(cellIntensity(0, 0.3), 0.05)
  assert.equal(cellIntensity(0.3, 0.3), 0.95)
  assert.equal(cellIntensity(0.1, 0), 0.05) // maxProb 0 (leere Matrix) -> Minimum, keine Division durch 0
  const low = cellIntensity(0.05, 0.3)
  const high = cellIntensity(0.2, 0.3)
  assert.ok(low > 0.05 && low < high && high < 0.95)
})

// ---------------------------------------------------------------------------
// Goal Distribution + Expected Goals - verbindliches Beispiel aus dem
// Auftrag: Simulationen 1:0, 2:1, 3:2, 6:1, 8:3 (5 Läufe).
// ---------------------------------------------------------------------------

const WORKED_EXAMPLE = [
  { homeGoals: 1, awayGoals: 0 },
  { homeGoals: 2, awayGoals: 1 },
  { homeGoals: 3, awayGoals: 2 },
  { homeGoals: 6, awayGoals: 1 },
  { homeGoals: 8, awayGoals: 3 },
]

test('Home Goal Distribution: verbindliches Beispiel aus dem Auftrag (1:0, 2:1, 3:2, 6:1, 8:3)', () => {
  const { distribution, totalRuns } = buildGoalDistribution(WORKED_EXAMPLE, 'homeGoals')
  assert.equal(totalRuns, 5)
  assert.equal(distribution[0], 0) // Home 0 = 0%
  assert.equal(distribution[1], 0.2) // Home 1 = 20% (1x)
  assert.equal(distribution[2], 0.2) // Home 2 = 20% (1x)
  assert.equal(distribution[3], 0.2) // Home 3 = 20% (1x)
  assert.equal(distribution[4], 0)
  assert.equal(distribution[5], 0)
  // Home 6+ = 20% (6:1 UND 8:3 fallen beide in den 6+-Bucket -> 2/5 = 40%,
  // nicht 20% - siehe Korrektur unten: das Beispiel im Auftrag listet "Home
  // 6+" versehentlich zweimal mit 20% obwohl ZWEI Läufe (6 und 8 Tore)
  // hineinfallen. Wir prüfen hier die mathematisch korrekte Aggregation
  // (2 von 5 Läufen >= 6 Tore = 40%), nicht den inkonsistenten Beispielwert.
  assert.equal(distribution[GOAL_DIST_CAP], 0.4)
  assert.equal(distributionLabel(GOAL_DIST_CAP), '6+')
})

test('Away Goal Distribution: verbindliches Beispiel aus dem Auftrag', () => {
  const { distribution, totalRuns } = buildGoalDistribution(WORKED_EXAMPLE, 'awayGoals')
  assert.equal(totalRuns, 5)
  assert.equal(distribution[0], 0.2) // 1x 0 (1:0)
  assert.equal(distribution[1], 0.4) // 2x 1 (2:1, 6:1)
  assert.equal(distribution[2], 0.2) // 1x 2 (3:2)
  assert.equal(distribution[3], 0.2) // 1x 3 (8:3)
  assert.ok(Math.abs(distributionSum(distribution) - 1) < 1e-9)
})

test('6+ Aggregation: auch sehr hohe Torzahlen (z.B. 8, 12) fallen korrekt in den letzten Bucket', () => {
  const results = [
    { homeGoals: 6, awayGoals: 0 },
    { homeGoals: 7, awayGoals: 0 },
    { homeGoals: 12, awayGoals: 0 },
    { homeGoals: 5, awayGoals: 0 },
  ]
  const { distribution } = buildGoalDistribution(results, 'homeGoals')
  assert.equal(distribution[5], 0.25) // exakt 5 bleibt eigenständig, NICHT im 6+-Bucket
  assert.equal(distribution[GOAL_DIST_CAP], 0.75) // 6, 7, 12 -> alle in 6+
})

test('Expected Goals: verbindliches Beispiel aus dem Auftrag - Home xG = (1+2+3+6+8)/5 = 4.0', () => {
  const { homeXG, awayXG, totalXG, totalRuns } = expectedGoals(WORKED_EXAMPLE)
  assert.equal(totalRuns, 5)
  assert.equal(homeXG, 4.0)
  assert.equal(awayXG, (0 + 1 + 2 + 1 + 3) / 5) // = 1.4
  assert.ok(Math.abs(totalXG - (homeXG + awayXG)) < 1e-9, 'Total xG muss Home xG + Away xG sein')
})

test('Expected Goals bleibt bei hohen Torzahlen exakt (6+ wird für xG NICHT als 6 gedeckelt)', () => {
  // 8 Tore müssen für xG mit ihrem echten Wert (8) zählen, nicht als "6".
  const { homeXG } = expectedGoals([{ homeGoals: 8, awayGoals: 0 }, { homeGoals: 0, awayGoals: 0 }])
  assert.equal(homeXG, 4) // (8+0)/2 = 4, NICHT (6+0)/2 = 3
})

test('Summe der Wahrscheinlichkeiten (Home- und Away-Verteilung) ergibt je exakt 1', () => {
  const home = buildGoalDistribution(WORKED_EXAMPLE, 'homeGoals')
  const away = buildGoalDistribution(WORKED_EXAMPLE, 'awayGoals')
  assert.ok(Math.abs(distributionSum(home.distribution) - 1) < 1e-9)
  assert.ok(Math.abs(distributionSum(away.distribution) - 1) < 1e-9)
})

test('leere Simulation: keine Läufe -> Nullverteilung/xG=0 statt NaN oder Fehler', () => {
  const home = buildGoalDistribution([], 'homeGoals')
  assert.equal(home.totalRuns, 0)
  for (const v of home.distribution) assert.equal(v, 0)
  assert.equal(distributionSum(home.distribution), 0)
  assert.equal(maxDistributionValue(home.distribution), 0)

  const xg = expectedGoals([])
  assert.deepEqual(xg, { homeXG: 0, awayXG: 0, totalXG: 0, totalRuns: 0 })

  const xgNullish = expectedGoals(null)
  assert.equal(xgNullish.totalRuns, 0)
  assert.equal(xgNullish.totalXG, 0)
})

test('ungültige Daten: negative/nicht-finite Torzahlen und fehlende Felder werden übersprungen statt zu werfen', () => {
  const messy = [
    null,
    undefined,
    { homeGoals: -2, awayGoals: 1 }, // homeGoals negativ -> ungültig für Home-Verteilung UND xG
    { homeGoals: 3, awayGoals: NaN }, // homeGoals für sich genommen gültig (Home-Verteilung zählt es), für xG (braucht BEIDE Felder) aber ungültig
    { homeGoals: Infinity, awayGoals: 1 }, // nicht endlich -> ungültig
    { awayGoals: 2 }, // homeGoals fehlt -> ungültig
    {},
    { homeGoals: 4, awayGoals: 2 }, // vollständig gültiger Lauf
  ]
  // Home-Verteilung betrachtet NUR das eigene Feld (homeGoals) - ein defektes
  // awayGoals in DEMSELBEN Eintrag macht den Home-Wert nicht ungültig.
  const home = buildGoalDistribution(messy, 'homeGoals')
  assert.equal(home.totalRuns, 2) // { homeGoals: 3, ... } UND { homeGoals: 4, awayGoals: 2 }
  assert.equal(home.distribution[3], 0.5)
  assert.equal(home.distribution[4], 0.5)

  // expectedGoals() braucht dagegen BEIDE Felder gleichzeitig gültig (Home-
  // UND Away-Tore werden gemeinsam pro Lauf aufsummiert) - der Lauf mit
  // awayGoals=NaN zählt hier NICHT mit, nur der einzige vollständig gültige.
  const xg = expectedGoals(messy)
  assert.equal(xg.totalRuns, 1)
  assert.equal(xg.homeXG, 4)
  assert.equal(xg.awayXG, 2)
})

test('unterschiedliche Heim-/Auswärtsteams: Home- und Away-Verteilung sowie xG werden unabhängig (nicht symmetrisch) berechnet', () => {
  const results = [
    { homeGoals: 5, awayGoals: 1 },
    { homeGoals: 5, awayGoals: 1 },
    { homeGoals: 5, awayGoals: 1 },
    { homeGoals: 1, awayGoals: 5 },
  ]
  const home = buildGoalDistribution(results, 'homeGoals')
  const away = buildGoalDistribution(results, 'awayGoals')
  assert.equal(home.distribution[5], 0.75)
  assert.equal(home.distribution[1], 0.25)
  assert.equal(away.distribution[5], 0.25)
  assert.equal(away.distribution[1], 0.75)
  assert.notDeepEqual(home.distribution, away.distribution)

  const xg = expectedGoals(results)
  assert.equal(xg.homeXG, (5 + 5 + 5 + 1) / 4)
  assert.equal(xg.awayXG, (1 + 1 + 1 + 5) / 4)
  assert.notEqual(xg.homeXG, xg.awayXG)
})

test('GOAL_DIST_BUCKET_COUNT/distributionLabel sind konsistent (7 Buckets: 0..5, 6+)', () => {
  assert.equal(GOAL_DIST_BUCKET_COUNT, 7)
  assert.equal(distributionLabel(0), '0')
  assert.equal(distributionLabel(5), '5')
  assert.equal(distributionLabel(6), '6+')
})
