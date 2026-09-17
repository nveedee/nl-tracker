// ---------------------------------------------------------------------------
// Tests für die reinen Formatierungs-Helfer in src/stats.js. Fokus:
// fmtSec()-Regressionstest für den "8:60"-Rundungsfehler (siehe Kommentar
// dort) - Ursache war, dass Minuten und Sekunden GETRENNT gerundet wurden
// (Math.floor(v/60) UND Math.round(v%60) je für sich), wodurch das
// Sekunden-Restglied auf 60 aufrunden konnte, statt in die nächste Minute
// überzulaufen.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtSec, fmtPct, fmtNum, fmtChf, plusMinusStr } from './stats.js'

test('fmtSec: rundet niemals auf ":60" hoch (Regressionstest für den 8:60-Bug)', () => {
  // v = 539.6s -> vorher: m=floor(8.993)=8, s=round(59.6)=60 -> "8:60" (Bug).
  // Korrekt: erst auf 540s runden -> 9:00.
  assert.equal(fmtSec(539.6), '9:00')
  // Weitere Werte knapp unter einer vollen Minute, die denselben Rundungsfehler auslösen würden.
  assert.equal(fmtSec(59.6), '1:00')
  assert.equal(fmtSec(119.5), '2:00')
  assert.equal(fmtSec(899.51), '15:00')
})

test('fmtSec: keine ":60"-Sekunden über einen breiten Wertebereich (0-1200s in 0.1er-Schritten)', () => {
  for (let v = 0; v <= 1200; v += 0.1) {
    const out = fmtSec(v)
    assert.ok(!/:60$/.test(out), `fmtSec(${v}) = "${out}" enthält ":60"`)
  }
})

test('fmtSec: normale, unkritische Werte weiterhin korrekt', () => {
  assert.equal(fmtSec(0), '0:00')
  assert.equal(fmtSec(65), '1:05')
  assert.equal(fmtSec(600), '10:00')
  assert.equal(fmtSec(null), '–')
})

test('fmtSec: Sekundenanteil immer zweistellig (Padding)', () => {
  assert.equal(fmtSec(61), '1:01')
  assert.equal(fmtSec(9), '0:09')
})

test('fmtPct/fmtNum/fmtChf/plusMinusStr: null-Werte liefern "–" statt NaN/undefined', () => {
  assert.equal(fmtPct(null), '–')
  assert.equal(fmtNum(null), '–')
  assert.equal(fmtChf(null), '–')
  assert.equal(fmtPct(0.5), '50.0%')
  assert.equal(fmtChf(1250000), "1'250'000")
  assert.equal(plusMinusStr(3), '+3')
  assert.equal(plusMinusStr(-2), '-2')
  assert.equal(plusMinusStr(0), '0')
})
