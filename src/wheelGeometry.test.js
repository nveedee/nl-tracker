// ---------------------------------------------------------------------------
// Sanity-Checks für die Geometrie des Playoff Probability Wheel
// (src/wheelGeometry.js).
//
// VERBINDLICHE GEOMETRIE (siehe Auftrag):
//   WINKELBREITE = normalisierte P(Viertelfinal) relativ zu allen Teams
//                  (angleWidth_i = 360° x P(QF)_i / Σ P(QF)_alle_Teams)
//   RADIUS       = direkte, NICHT normalisierte P(je Runde) dieses Teams
//                  (rQF/rSF/rFinal/rCup = P(...) x maxRadius)
// Gleiche P(QF) -> exakt gleicher Winkel. Unterschiedliche P(QF) -> zwingend
// unterschiedlicher Winkel. Σ Winkel = 360°, immer.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { buildWheelLayout, sectorPath, polarToCartesian, RING_LEVELS, MIN_VISUAL_ANGLE_DEG } from './wheelGeometry.js'
import { simulateSeasonProjections } from './playoffSim.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SEED_PATH = path.join(__dirname, '..', 'server', 'data', 'seed.json')
const db = JSON.parse(readFileSync(SEED_PATH, 'utf-8'))
const { teams, games, players, settings } = db

function toProbsMap(sim) {
  return new Map(sim.rows.map((r) => [r.team.id, r]))
}

// Kleine, frei erfundene Fake-Teams für isolierte Geometrie-Tests - unabhängig
// von echten Simulationsläufen, damit die reine Mathematik exakt geprüft
// werden kann (keine Rundungs-/Simulationsnoise).
function fakeTeams(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `Team ${i}`, short: `T${i}`, color: '#000' }))
}
function probsMap(fTeams, values) {
  return new Map(fTeams.map((t, i) => [t.id, values[i]]))
}

test('alle Teams sind im Wheel-Layout vorhanden, in Eingabe-Reihenfolge', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 1000, seed: 1, players })
  const layout = buildWheelLayout(teams, toProbsMap(sim))
  assert.equal(layout.length, teams.length)
  layout.forEach((entry, i) => assert.equal(entry.team.id, teams[i].id))
})

test('Sektorlänge (rQF/rSF/rFinal/rCup) entspricht exakt der Wahrscheinlichkeit * maxRadius (NICHT normalisiert)', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 1000, seed: 1, players })
  const layout = buildWheelLayout(teams, toProbsMap(sim), { maxRadius: 100 })
  for (const entry of layout) {
    assert.ok(Math.abs(entry.rQF - entry.pPlayoffs * 100) < 1e-9)
    assert.ok(Math.abs(entry.rSF - entry.pSemifinal * 100) < 1e-9)
    assert.ok(Math.abs(entry.rFinal - entry.pFinal * 100) < 1e-9)
    assert.ok(Math.abs(entry.rCup - entry.pChampion * 100) < 1e-9)
  }
})

test('QF/SF/Final/Cup korrekt ineinander verschachtelt: rQF >= rSF >= rFinal >= rCup für jedes Team', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 2000, seed: 777, players })
  const layout = buildWheelLayout(teams, toProbsMap(sim))
  for (const entry of layout) {
    assert.ok(entry.rQF >= entry.rSF - 1e-9, `${entry.team.name}: QF (${entry.rQF}) < SF (${entry.rSF})`)
    assert.ok(entry.rSF >= entry.rFinal - 1e-9, `${entry.team.name}: SF (${entry.rSF}) < Final (${entry.rFinal})`)
    assert.ok(entry.rFinal >= entry.rCup - 1e-9, `${entry.team.name}: Final (${entry.rFinal}) < Cup (${entry.rCup})`)
  }
})

test('Winkelbreite ist PROPORTIONAL zu P(QF) und normalisiert auf Σ = 360° (exaktes 50/30/20-Beispiel)', () => {
  const fTeams = fakeTeams(3)
  // Σ P(QF) = 100% -> keine weitere Normalisierung "gegen andere Teams"
  // nötig, angle_i = 360 * p_i direkt.
  const probs = probsMap(fTeams, [
    { pPlayoffs: 0.5, pSemifinal: 0.3, pFinal: 0.1, pChampion: 0.02 },
    { pPlayoffs: 0.3, pSemifinal: 0.15, pFinal: 0.05, pChampion: 0.01 },
    { pPlayoffs: 0.2, pSemifinal: 0.05, pFinal: 0.01, pChampion: 0 },
  ])
  const layout = buildWheelLayout(fTeams, probs)
  const widths = layout.map((e) => e.angleWidth)

  assert.ok(Math.abs(widths[0] - 180) < 1e-9, `erwartet 180°, war ${widths[0]}°`)
  assert.ok(Math.abs(widths[1] - 108) < 1e-9, `erwartet 108°, war ${widths[1]}°`)
  assert.ok(Math.abs(widths[2] - 72) < 1e-9, `erwartet 72°, war ${widths[2]}°`)

  // Höhere P(QF) -> zwingend grösserer Winkel (nicht gleich!).
  assert.ok(widths[0] > widths[1])
  assert.ok(widths[1] > widths[2])

  // Summe über alle Teams = exakt 360°.
  const sum = widths.reduce((s, w) => s + w, 0)
  assert.ok(Math.abs(sum - 360) < 1e-9, `Σ Winkel muss 360° sein, war ${sum}°`)
})

test('gleiche P(QF) ergibt exakt denselben Winkel, auch wenn andere Playoff-Stufen abweichen', () => {
  const fTeams = fakeTeams(3)
  const probs = probsMap(fTeams, [
    { pPlayoffs: 0.4, pSemifinal: 0.3, pFinal: 0.2, pChampion: 0.1 },
    { pPlayoffs: 0.4, pSemifinal: 0.05, pFinal: 0.01, pChampion: 0 }, // gleiches P(QF), radial aber viel schwächer
    { pPlayoffs: 0.2, pSemifinal: 0.1, pFinal: 0.05, pChampion: 0.01 },
  ])
  const layout = buildWheelLayout(fTeams, probs)
  assert.ok(Math.abs(layout[0].angleWidth - layout[1].angleWidth) < 1e-9, 'gleiches P(QF) muss gleichen Winkel ergeben')
  assert.ok(layout[0].angleWidth > layout[2].angleWidth, 'höheres P(QF) muss grösseren Winkel ergeben')
  // Die radialen Werte bleiben trotz identischem Winkel unabhängig voneinander.
  assert.notEqual(layout[0].rSF, layout[1].rSF)
})

test('verbindliches A/B/C-Beispiel aus dem Auftrag (100/50/0 %): Winkel UND Radien korrekt, Team C nutzt den visuellen Mindestwinkel', () => {
  const fTeams = fakeTeams(3)
  const probs = probsMap(fTeams, [
    { pPlayoffs: 1, pSemifinal: 1, pFinal: 1, pChampion: 1 },
    { pPlayoffs: 0.5, pSemifinal: 0.3, pFinal: 0.15, pChampion: 0.05 },
    { pPlayoffs: 0, pSemifinal: 0, pFinal: 0, pChampion: 0 },
  ])
  const layout = buildWheelLayout(fTeams, probs, { maxRadius: 100 })
  const [a, b, c] = layout

  // Winkel: A (100%) > B (50%) > C (0%, Mindestwinkel) - Σ = 360°.
  // total P(QF) = 1.5 -> reserved = MIN_VISUAL_ANGLE_DEG für C, Rest 357°
  // proportional auf A/B verteilt (Verhältnis 1:0.5 -> 2:1).
  const expectedA = (360 - MIN_VISUAL_ANGLE_DEG) * (1 / 1.5)
  const expectedB = (360 - MIN_VISUAL_ANGLE_DEG) * (0.5 / 1.5)
  assert.ok(Math.abs(a.angleWidth - expectedA) < 1e-9, `A: erwartet ${expectedA}°, war ${a.angleWidth}°`)
  assert.ok(Math.abs(b.angleWidth - expectedB) < 1e-9, `B: erwartet ${expectedB}°, war ${b.angleWidth}°`)
  assert.ok(Math.abs(c.angleWidth - MIN_VISUAL_ANGLE_DEG) < 1e-9, `C: erwartet Mindestwinkel ${MIN_VISUAL_ANGLE_DEG}°, war ${c.angleWidth}°`)
  assert.ok(a.angleWidth > b.angleWidth && b.angleWidth > c.angleWidth)
  const sum = a.angleWidth + b.angleWidth + c.angleWidth
  assert.ok(Math.abs(sum - 360) < 1e-9)

  // isVisualMinimum unterscheidet klar zwischen "echter" und "visuell
  // aufgerundeter" Winkelbreite - die tatsächliche Wahrscheinlichkeit von
  // Team C bleibt dabei unverändert 0, NICHT durch den Mindestwinkel verfälscht.
  assert.equal(a.isVisualMinimum, false)
  assert.equal(b.isVisualMinimum, false)
  assert.equal(c.isVisualMinimum, true)
  assert.equal(c.pPlayoffs, 0)

  // Radien: direkt (nicht normalisiert) - exakt wie im Auftrag gefordert.
  assert.ok(Math.abs(a.rQF - 100) < 1e-9 && Math.abs(a.rSF - 100) < 1e-9)
  assert.ok(Math.abs(a.rFinal - 100) < 1e-9 && Math.abs(a.rCup - 100) < 1e-9)
  assert.ok(Math.abs(b.rQF - 50) < 1e-9 && Math.abs(b.rSF - 30) < 1e-9)
  assert.ok(Math.abs(b.rFinal - 15) < 1e-9 && Math.abs(b.rCup - 5) < 1e-9)
  assert.equal(c.rQF, 0)
  assert.equal(c.rSF, 0)
  assert.equal(c.rFinal, 0)
  assert.equal(c.rCup, 0)
})

test('Σ Winkelbreite über alle 14 echten NL-Teams (Simulationslauf) ist exakt 360°', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 1500, seed: 99, players })
  const layout = buildWheelLayout(teams, toProbsMap(sim))
  const sum = layout.reduce((s, e) => s + e.angleWidth, 0)
  assert.ok(Math.abs(sum - 360) < 1e-6, `Σ Winkel muss 360° sein, war ${sum}°`)
})

test('Sektoren überlappen nicht: startAngle/endAngle sind streng aufsteigend und bleiben innerhalb ihres allozierten Winkels', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 500, seed: 2, players })
  const layout = buildWheelLayout(teams, toProbsMap(sim))
  layout.forEach((entry) => {
    assert.ok(entry.endAngle > entry.startAngle, 'Sektor muss positive Winkelbreite haben')
    assert.ok(entry.endAngle - entry.startAngle <= entry.angleWidth + 1e-9, 'gerenderte Breite darf die allozierte nicht überschreiten (Lücke schneidet nur ab)')
  })
  for (let i = 1; i < layout.length; i++) {
    assert.ok(layout[i].startAngle >= layout[i - 1].endAngle - 1e-9, 'Sektoren dürfen sich nicht überlappen')
  }
})

test('fehlende Wahrscheinlichkeit für EIN Team (andere Teams positiv) ergibt 0-Radius + visuellen Mindestwinkel statt Absturz', () => {
  const fTeams = fakeTeams(3)
  const probs = new Map([
    [fTeams[0].id, { pPlayoffs: 0.6, pSemifinal: 0.4, pFinal: 0.2, pChampion: 0.1 }],
    [fTeams[1].id, { pPlayoffs: 0.4, pSemifinal: 0.2, pFinal: 0.1, pChampion: 0.05 }],
    // fTeams[2] fehlt komplett in der Map.
  ])
  const layout = buildWheelLayout(fTeams, probs)
  const missing = layout[2]
  assert.equal(missing.rQF, 0)
  assert.equal(missing.rSF, 0)
  assert.equal(missing.rFinal, 0)
  assert.equal(missing.rCup, 0)
  assert.ok(Math.abs(missing.angleWidth - MIN_VISUAL_ANGLE_DEG) < 1e-9)
  assert.equal(missing.isVisualMinimum, true)
})

test('komplett leere Wahrscheinlichkeiten (alle Teams fehlen) fallen auf gleichmässige Aufteilung zurück statt Division durch 0', () => {
  const layout = buildWheelLayout(teams, new Map())
  const slice = 360 / teams.length
  for (const entry of layout) {
    assert.equal(entry.rQF, 0)
    assert.equal(entry.rSF, 0)
    assert.equal(entry.rFinal, 0)
    assert.equal(entry.rCup, 0)
    assert.ok(Math.abs(entry.angleWidth - slice) < 1e-9)
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
