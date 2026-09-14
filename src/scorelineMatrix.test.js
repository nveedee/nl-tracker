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
