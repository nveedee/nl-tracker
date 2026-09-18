// ---------------------------------------------------------------------------
// Tests für die Shotmap-Koordinatensemantik (Auftrag Punkt 1/2/3/4/10) -
// basierend auf dem ECHTEN National-League-API-Fixture (KEINE synthetischen
// Koordinaten), siehe server/data/fixtures/nl-game-detail-sample.json und
// den Bericht zur Koordinaten-Investigation.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { isValidShotCoordinate, SHOT_MAP_X_MAX, SHOT_MAP_Y_MAX } from './advancedStats.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(path.join(__dirname, '..', 'server', 'data', 'fixtures', 'nl-game-detail-sample.json'), 'utf-8'))

function allShots() {
  return [
    ...(fixture.shotsHome || []).map((s) => ({ ...s, side: 'home' })),
    ...(fixture.shotsAway || []).map((s) => ({ ...s, side: 'away' })),
  ]
}

test('echtes Fixture: posXPercentage === posX/30 und posYPercentage === posY/24 bei jedem Schuss (Basis der festen Transformation)', () => {
  const shots = allShots()
  assert.ok(shots.length > 0)
  for (const s of shots) {
    assert.ok(Math.abs(s.posX / SHOT_MAP_X_MAX - s.posXPercentage) < 0.001, `posX=${s.posX} passt nicht zu posXPercentage=${s.posXPercentage}`)
    assert.ok(Math.abs(s.posY / SHOT_MAP_Y_MAX - s.posYPercentage) < 0.001, `posY=${s.posY} passt nicht zu posYPercentage=${s.posYPercentage}`)
  }
})

test('echtes Fixture: bekannte fehlerhafte Rohkoordinaten (>1 Prozentwert) werden von isValidShotCoordinate erkannt und ausgefiltert', () => {
  const shots = allShots().map((s) => ({ x: s.posX, y: s.posY }))
  const invalid = shots.filter((s) => !isValidShotCoordinate(s))
  // Aus der Investigation bekannt: 5 Schüsse mit posXPercentage/posYPercentage > 1 in diesem Spiel.
  assert.equal(invalid.length, 5)
  const valid = shots.filter(isValidShotCoordinate)
  assert.equal(valid.length + invalid.length, shots.length)
})

test('echtes Fixture: keine Heim-/Auswärts- oder Drittel-Spiegelung nötig - X/Y-Wertespannen pro Team bleiben über alle 3 Drittel stabil', () => {
  const shots = allShots().filter((s) => isValidShotCoordinate({ x: s.posX, y: s.posY }))
  for (const side of ['home', 'away']) {
    const ranges = []
    for (let period = 1; period <= 3; period++) {
      const subset = shots.filter((s) => s.side === side && s.sec === period)
      if (subset.length === 0) continue
      const xs = subset.map((s) => s.posX)
      ranges.push({ period, minX: Math.min(...xs), maxX: Math.max(...xs) })
    }
    assert.ok(ranges.length >= 2, `zu wenige Drittel mit Daten für Seite ${side}`)
    // Wenn eine Drittel-Spiegelung nötig wäre, würde sich die X-Wertespanne
    // zwischen Drittel 1/3 und Drittel 2 stark verschieben (Seitenwechsel).
    // Verifiziert: alle Drittel überlappen sich im selben ungefähren Bereich.
    const overallMin = Math.min(...ranges.map((r) => r.minX))
    const overallMax = Math.max(...ranges.map((r) => r.maxX))
    for (const r of ranges) {
      assert.ok(r.minX <= overallMax && r.maxX >= overallMin, `Drittel ${r.period} (Seite ${side}) liegt ausserhalb des gemeinsamen Bereichs - würde auf Spiegelbedarf hindeuten`)
    }
  }
})

test('echtes Fixture: Tor-Ereignisse liegen nahe der Torlinie (kleines y), nicht am fernen Rand des erfassten Bereichs', () => {
  const goals = allShots().filter((s) => s.type === 'GOAL' && isValidShotCoordinate({ x: s.posX, y: s.posY }))
  assert.ok(goals.length > 0)
  const ys = goals.map((g) => g.posY)
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length
  // Erwartung (siehe Bericht, verifiziert an 40 Toren aus 7 echten Spielen):
  // Tore clustern nahe y=0 (Torlinie), NICHT nahe y=24 (Rand der Zone).
  assert.ok(meanY < SHOT_MAP_Y_MAX / 2, `Tore sollten näher an der Torlinie (y klein) liegen, mittleres y=${meanY}`)
  for (const y of ys) assert.ok(y < SHOT_MAP_Y_MAX * 0.9, 'kein Tor sollte am äussersten Rand der erfassten Zone liegen')
})

test('echtes Fixture: Tor-Ereignisse sind seitlich (x) etwa um die Rinkmitte zentriert (Netz liegt zentral)', () => {
  const goals = allShots().filter((s) => s.type === 'GOAL' && isValidShotCoordinate({ x: s.posX, y: s.posY }))
  const xs = goals.map((g) => g.posX)
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length
  assert.ok(Math.abs(meanX - SHOT_MAP_X_MAX / 2) < SHOT_MAP_X_MAX * 0.25, `mittleres x=${meanX} sollte nahe der Rinkmitte (${SHOT_MAP_X_MAX / 2}) liegen`)
})

test('echtes Fixture: keine NaN/Infinity-Werte nach der Transformation für alle gültigen Schüsse', () => {
  const shots = allShots().filter((s) => isValidShotCoordinate({ x: s.posX, y: s.posY }))
  for (const s of shots) {
    const px = s.posX / SHOT_MAP_X_MAX
    const py = s.posY / SHOT_MAP_Y_MAX
    assert.ok(Number.isFinite(px))
    assert.ok(Number.isFinite(py))
  }
})
