// ---------------------------------------------------------------------------
// Sanity-Checks für die Geometrie des Playoff Probability Wheel
// (src/wheelGeometry.js): alle Teams vorhanden, Sektorlänge entspricht der
// Wahrscheinlichkeit, QF/SF/Final korrekt ineinander verschachtelt (nutzt
// dafür einen echten Simulationslauf aus playoffSim.js, unverändert).
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { buildWheelLayout, sectorPath, polarToCartesian, RING_LEVELS } from './wheelGeometry.js'
import { simulateSeasonProjections } from './playoffSim.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SEED_PATH = path.join(__dirname, '..', 'server', 'data', 'seed.json')
const db = JSON.parse(readFileSync(SEED_PATH, 'utf-8'))
const { teams, games, players, settings } = db

function toProbsMap(sim) {
  return new Map(sim.rows.map((r) => [r.team.id, r]))
}

test('alle Teams sind im Wheel-Layout vorhanden, in Eingabe-Reihenfolge', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 1000, seed: 1, players })
  const layout = buildWheelLayout(teams, toProbsMap(sim))
  assert.equal(layout.length, teams.length)
  layout.forEach((entry, i) => assert.equal(entry.team.id, teams[i].id))
})

test('Sektorlänge (rQF/rSF/rFinal) entspricht exakt der Wahrscheinlichkeit * maxRadius', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 1000, seed: 1, players })
  const layout = buildWheelLayout(teams, toProbsMap(sim), { maxRadius: 100 })
  for (const entry of layout) {
    assert.ok(Math.abs(entry.rQF - entry.pPlayoffs * 100) < 1e-9)
    assert.ok(Math.abs(entry.rSF - entry.pSemifinal * 100) < 1e-9)
    assert.ok(Math.abs(entry.rFinal - entry.pFinal * 100) < 1e-9)
  }
})

test('QF/SF/Final korrekt ineinander verschachtelt: rQF >= rSF >= rFinal für jedes Team', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 2000, seed: 777, players })
  const layout = buildWheelLayout(teams, toProbsMap(sim))
  for (const entry of layout) {
    assert.ok(entry.rQF >= entry.rSF - 1e-9, `${entry.team.name}: QF (${entry.rQF}) < SF (${entry.rSF})`)
    assert.ok(entry.rSF >= entry.rFinal - 1e-9, `${entry.team.name}: SF (${entry.rSF}) < Final (${entry.rFinal})`)
  }
})

test('Team-Sektoren teilen 360° gleichmässig auf und überlappen nicht (Lücke bleibt positiv)', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 500, seed: 2, players })
  const layout = buildWheelLayout(teams, toProbsMap(sim), { gapDeg: 4 })
  const slice = 360 / teams.length
  layout.forEach((entry, i) => {
    assert.ok(entry.endAngle > entry.startAngle, 'Sektor muss positive Winkelbreite haben')
    assert.ok(entry.endAngle - entry.startAngle < slice, 'Lücke zwischen Sektoren muss erhalten bleiben')
  })
  // Erstes Team beginnt oben (12 Uhr = -90°), letztes Team endet knapp vor +270°.
  assert.ok(Math.abs(layout[0].startAngle - (-90 + 2)) < 1e-9)
})

test('fehlende Wahrscheinlichkeiten (Team ohne Eintrag in probsByTeamId) ergeben 0-Radius statt Absturz', () => {
  const layout = buildWheelLayout(teams, new Map())
  for (const entry of layout) {
    assert.equal(entry.rQF, 0)
    assert.equal(entry.rSF, 0)
    assert.equal(entry.rFinal, 0)
  }
})

test('sectorPath: r<=0 liefert validen, unsichtbaren Pfad ohne Fehler', () => {
  assert.equal(sectorPath(50, 50, 0, -90, 0), 'M 50 50 Z')
  assert.equal(sectorPath(50, 50, -5, -90, 0), 'M 50 50 Z')
})

test('sectorPath: erzeugt einen Pfad mit Arc-Segment für einen normalen Sektor', () => {
  const p = sectorPath(0, 0, 10, -90, 0)
  assert.ok(p.startsWith('M 0 0'))
  assert.ok(p.includes('A 10 10 0 0 1'))
  assert.ok(p.trim().endsWith('Z'))
})

test('polarToCartesian: 0° liegt auf der positiven x-Achse, -90° oben (negative y)', () => {
  const east = polarToCartesian(0, 0, 10, 0)
  assert.ok(Math.abs(east.x - 10) < 1e-9 && Math.abs(east.y) < 1e-9)
  const top = polarToCartesian(0, 0, 10, -90)
  assert.ok(Math.abs(top.x) < 1e-9 && Math.abs(top.y - -10) < 1e-9)
})

test('RING_LEVELS ist aufsteigend sortiert und endet bei 1 (100%)', () => {
  for (let i = 1; i < RING_LEVELS.length; i++) assert.ok(RING_LEVELS[i] > RING_LEVELS[i - 1])
  assert.equal(RING_LEVELS[RING_LEVELS.length - 1], 1)
})
