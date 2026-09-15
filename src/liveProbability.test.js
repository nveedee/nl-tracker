import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeLiveWinProbability, remainingFraction, elapsedMinutesFromPeriodClock, OT_SHARE_OF_TIES } from './liveProbability.js'

// Repräsentative Pre-Game-Werte (Grössenordnung wie CALIBRATION.leagueHomeGPG/
// leagueAwayGPG in playoffSim.js für ein leicht heimfavorisiertes Spiel) -
// bewusst realistisch statt beliebig, aber NICHT identisch mit einer
// bestimmten echten Team-Paarung (reiner Engine-Test, keine Team-Daten nötig).
const PREGAME = { expHomeFull: 3.0, expAwayFull: 2.6, pHomePreGame: 0.56 }

function assertValidDistribution(r) {
  for (const [key, v] of Object.entries(r)) {
    if (typeof v !== 'number') continue
    assert.ok(Number.isFinite(v), `${key} ist NaN/Infinity`)
  }
  assert.ok(r.homeRegWin >= 0 && r.homeRegWin <= 1)
  assert.ok(r.drawAfter60 >= 0 && r.drawAfter60 <= 1)
  assert.ok(r.awayRegWin >= 0 && r.awayRegWin <= 1)
  assert.ok(r.homeFinal >= 0 && r.homeFinal <= 1)
  assert.ok(r.awayFinal >= 0 && r.awayFinal <= 1)
  assert.ok(Math.abs(r.homeRegWin + r.drawAfter60 + r.awayRegWin - 1) < 1e-9, 'Regulations-Aufteilung summiert nicht zu 1')
  assert.ok(Math.abs(r.homeFinal + r.awayFinal - 1) < 1e-9, 'Final-Aufteilung summiert nicht zu 1')
}

test('remainingFraction: Beispielwerte aus der Aufgabenstellung', () => {
  assert.ok(Math.abs(remainingFraction(0) - 1) < 1e-9)
  assert.ok(Math.abs(remainingFraction(10) - 0.8333) < 1e-3)
  assert.ok(Math.abs(remainingFraction(20) - 0.6667) < 1e-3)
  assert.ok(Math.abs(remainingFraction(30) - 0.5) < 1e-9)
  assert.ok(Math.abs(remainingFraction(40) - 0.3333) < 1e-3)
  assert.ok(Math.abs(remainingFraction(50) - 0.1667) < 1e-3)
  assert.ok(Math.abs(remainingFraction(58) - 0.0333) < 1e-3)
  assert.ok(Math.abs(remainingFraction(59.5) - 0.0083) < 1e-3)
  assert.ok(Math.abs(remainingFraction(60) - 0) < 1e-9)
})

test('elapsedMinutesFromPeriodClock: 3. Drittel, 01:42 verbleibend -> 58.3min', () => {
  const elapsed = elapsedMinutesFromPeriodClock(3, 102) // 01:42 = 102s
  assert.ok(Math.abs(elapsed - 58.3) < 0.01)
})

test('1) 0:0 bei 0\' - nahezu ausgeglichen (nur Heimvorteil-Bias)', () => {
  const r = computeLiveWinProbability({ ...PREGAME, homeGoals: 0, awayGoals: 0, elapsedMinutes: 0 })
  assertValidDistribution(r)
  assert.ok(Math.abs(r.homeFinal - PREGAME.pHomePreGame) < 0.02, 'bei 0:0/0\' muss homeFinal ~ dem Pre-Game-pHome entsprechen')
})

test('2) 0:0 bei 30\' - weiterhin ausgeglichen, aber weniger Restzeit', () => {
  const r = computeLiveWinProbability({ ...PREGAME, homeGoals: 0, awayGoals: 0, elapsedMinutes: 30 })
  assertValidDistribution(r)
  assert.ok(Math.abs(r.homeFinal - PREGAME.pHomePreGame) < 0.03)
})

test('3) 0:0 bei 59\' - drawAfter60 muss sehr hoch sein (kaum noch Zeit für ein Tor)', () => {
  const r = computeLiveWinProbability({ ...PREGAME, homeGoals: 0, awayGoals: 0, elapsedMinutes: 59 })
  assertValidDistribution(r)
  assert.ok(r.drawAfter60 > 0.9, `drawAfter60 sollte bei 0:0/59' > 90% sein, war ${r.drawAfter60}`)
})

test('4) 1:0 bei 10\' - Heim klar vorne, aber noch viel Restzeit', () => {
  const r = computeLiveWinProbability({ ...PREGAME, homeGoals: 1, awayGoals: 0, elapsedMinutes: 10 })
  assertValidDistribution(r)
  assert.ok(r.homeFinal > 0.6 && r.homeFinal < 0.9, `unerwarteter homeFinal: ${r.homeFinal}`)
})

test('5) 1:0 bei 50\' - Heim sehr hoch (wenig Zeit für Ausgleich)', () => {
  const r = computeLiveWinProbability({ ...PREGAME, homeGoals: 1, awayGoals: 0, elapsedMinutes: 50 })
  assertValidDistribution(r)
  assert.ok(r.homeFinal > 0.85, `homeFinal sollte bei 1:0/50' > 85% sein, war ${r.homeFinal}`)
})

test('6) 2:0 bei 50\' - Heim sehr hoch', () => {
  const r = computeLiveWinProbability({ ...PREGAME, homeGoals: 2, awayGoals: 0, elapsedMinutes: 50 })
  assertValidDistribution(r)
  assert.ok(r.homeFinal > 0.95, `homeFinal sollte bei 2:0/50' > 95% sein, war ${r.homeFinal}`)
})

test('7) 2:1 bei 58\' - Debug-Fall aus der Aufgabenstellung (siehe console.log)', () => {
  const params = { ...PREGAME, homeGoals: 2, awayGoals: 1, elapsedMinutes: 58 }
  const r = computeLiveWinProbability(params)
  assertValidDistribution(r)

  // Transparente Herleitung für die Dokumentation/das Debugging (Abschnitt 19
  // der Aufgabenstellung) - bewusst als Test-Output sichtbar.
  console.log('--- Debug: 2:1 bei 58\' ---')
  console.log('Pre-game:', { expHomeFull: params.expHomeFull, expAwayFull: params.expAwayFull, pHomePreGame: params.pHomePreGame })
  console.log('remainingFraction:', r.remainingFraction, 'remHomeLambda:', r.remHomeLambda, 'remAwayLambda:', r.remAwayLambda)
  console.log('homeRegWin:', r.homeRegWin, 'drawAfter60:', r.drawAfter60, 'awayRegWin:', r.awayRegWin)
  console.log('homeFinal:', r.homeFinal, 'awayFinal:', r.awayFinal)

  // Bei nur noch 2 Minuten Restzeit und einem 1-Tor-Rückstand muss Away sehr
  // klar unter dem alten (fehlerhaften) Demo-Wert von 11% liegen - das war
  // ein fest verdrahteter Demo-Wert ohne jede Berechnung, kein Modellergebnis.
  assert.ok(r.awayFinal < 0.08, `awayFinal sollte bei 2:1/58' deutlich unter 8% liegen, war ${r.awayFinal} (alter Demo-Wert: 11%)`)
  assert.ok(r.homeFinal > 0.9, `homeFinal sollte bei 2:1/58' > 90% sein, war ${r.homeFinal}`)
})

test('8) 3:1 bei 59\' - extrem hoch für Heim', () => {
  const r = computeLiveWinProbability({ ...PREGAME, homeGoals: 3, awayGoals: 1, elapsedMinutes: 59 })
  assertValidDistribution(r)
  assert.ok(r.homeFinal > 0.97, `homeFinal sollte bei 3:1/59' > 97% sein, war ${r.homeFinal}`)
})

test('6b) 0:3 bei 55\' - Away extrem hoch (Symmetrie-Check)', () => {
  const r = computeLiveWinProbability({ ...PREGAME, homeGoals: 0, awayGoals: 3, elapsedMinutes: 55 })
  assertValidDistribution(r)
  assert.ok(r.awayFinal > 0.95, `awayFinal sollte bei 0:3/55' > 95% sein, war ${r.awayFinal}`)
})

test('9) 2:2 bei 59\' - drawAfter60 dominant, final berücksichtigt OT/SO-Split', () => {
  const r = computeLiveWinProbability({ ...PREGAME, homeGoals: 2, awayGoals: 2, elapsedMinutes: 59 })
  assertValidDistribution(r)
  assert.ok(r.drawAfter60 > 0.85, `drawAfter60 sollte bei 2:2/59' > 85% sein, war ${r.drawAfter60}`)
  // Final-Split muss nahe am Pre-Game-pHome liegen (OT/SO-Auslosung dominiert
  // bei nahezu sicherem Unentschieden nach 60').
  assert.ok(Math.abs(r.homeFinal - PREGAME.pHomePreGame) < 0.05)
})

test('10) OT-Situation - Sudden Death, keine weitere Restzeit-Rechnung', () => {
  const r = computeLiveWinProbability({ ...PREGAME, homeGoals: 2, awayGoals: 2, elapsedMinutes: 60, phase: 'OT' })
  assertValidDistribution(r)
  assert.equal(r.drawAfter60, 1)
  assert.equal(r.remainingFraction, 0)
  assert.ok(Math.abs(r.homeFinal - PREGAME.pHomePreGame) < 1e-9)
  assert.ok(Math.abs(r.otShare - OT_SHARE_OF_TIES) < 1e-9)
})

test('11) Shootout-Situation - identische Sieger-Auslosung wie OT (bestehendes Modell, bewusst unverändert)', () => {
  const rOt = computeLiveWinProbability({ ...PREGAME, homeGoals: 1, awayGoals: 1, elapsedMinutes: 60, phase: 'OT' })
  const rSo = computeLiveWinProbability({ ...PREGAME, homeGoals: 1, awayGoals: 1, elapsedMinutes: 60, phase: 'SO' })
  assertValidDistribution(rOt)
  assertValidDistribution(rSo)
  assert.equal(rOt.homeFinal, rSo.homeFinal, 'OT- und SO-Sieger-Wahrscheinlichkeit müssen im bestehenden Modell identisch sein (fixture.pHome)')
})

test('Monotonie: mehr Heimtore darf Heim niemals unwahrscheinlicher machen (alles andere gleich)', () => {
  const base = computeLiveWinProbability({ ...PREGAME, homeGoals: 1, awayGoals: 1, elapsedMinutes: 40 })
  const more = computeLiveWinProbability({ ...PREGAME, homeGoals: 2, awayGoals: 1, elapsedMinutes: 40 })
  assert.ok(more.homeFinal > base.homeFinal)
})

test('Monotonie: mehr Auswärtstore darf Auswärts niemals unwahrscheinlicher machen (alles andere gleich)', () => {
  const base = computeLiveWinProbability({ ...PREGAME, homeGoals: 1, awayGoals: 1, elapsedMinutes: 40 })
  const more = computeLiveWinProbability({ ...PREGAME, homeGoals: 1, awayGoals: 2, elapsedMinutes: 40 })
  assert.ok(more.awayFinal > base.awayFinal)
})

test('Monotonie: weniger Restzeit stärkt den aktuellen Führenden bei gleichem Score', () => {
  const early = computeLiveWinProbability({ ...PREGAME, homeGoals: 1, awayGoals: 0, elapsedMinutes: 10 })
  const late = computeLiveWinProbability({ ...PREGAME, homeGoals: 1, awayGoals: 0, elapsedMinutes: 55 })
  assert.ok(late.homeFinal > early.homeFinal)
})

test('60:00 exakt (REG-Phase, Score bereits ausgeglichen) verhält sich wie drawAfter60=1', () => {
  const r = computeLiveWinProbability({ ...PREGAME, homeGoals: 1, awayGoals: 1, elapsedMinutes: 60 })
  assertValidDistribution(r)
  assert.ok(r.drawAfter60 > 0.999)
})

test('keine negativen oder unmöglichen Werte über ein Raster an Score-/Zeit-Kombinationen', () => {
  for (let elapsed = 0; elapsed <= 60; elapsed += 5) {
    for (let h = 0; h <= 4; h++) {
      for (let a = 0; a <= 4; a++) {
        const r = computeLiveWinProbability({ ...PREGAME, homeGoals: h, awayGoals: a, elapsedMinutes: elapsed })
        assertValidDistribution(r)
      }
    }
  }
})
