import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeLiveWinProbability, buildLiveProbabilityTimeline, remainingFraction, elapsedMinutesFromPeriodClock, OT_SHARE_OF_TIES,
  regulationPeriodOffsetMinutes, isIntermissionStatus, regulationElapsedMinutes, advanceDisplayedElapsed, periodTimeFromElapsed,
} from './liveProbability.js'

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

// ---------------------------------------------------------------------------
// buildLiveProbabilityTimeline: durchgehende Kurve aus echten Toren + Engine.
// ---------------------------------------------------------------------------
test('buildLiveProbabilityTimeline: laufendes Spiel ergibt eine durchgehende Reihe (nicht nur 1 Punkt)', () => {
  const hist = buildLiveProbabilityTimeline({
    ...PREGAME, goals: [{ minute: 12, side: 'home' }], homeGoals: 1, awayGoals: 0, elapsedMinutes: 30, phase: 'REG',
  })
  assert.ok(hist.length > 10, 'zu wenige Stützpunkte für eine Kurve')
  // monoton steigende Spielzeit
  for (let i = 1; i < hist.length; i++) assert.ok(hist[i].elapsedSeconds >= hist[i - 1].elapsedSeconds)
  // erster Punkt = Spielbeginn 0:0, letzter = aktueller Stand/Zeit
  assert.equal(hist[0].elapsedSeconds, 0)
  assert.equal(hist[0].homeGoals, 0)
  assert.equal(hist[hist.length - 1].elapsedSeconds, 1800)
  assert.equal(hist[hist.length - 1].homeGoals, 1)
  // alle Werte gültig und je Zeile summieren Home+Away der Final-Quote zu 1
  for (const p of hist) {
    for (const k of ['homeWin', 'drawAfter60', 'awayWin']) assert.ok(p[k] >= 0 && p[k] <= 1, `${k} ausserhalb [0,1]`)
    assert.ok(Math.abs(p.homeWin + p.awayWin - 1) < 1e-9, 'homeWin+awayWin != 1')
  }
})

test('buildLiveProbabilityTimeline: Score zu jedem Zeitpunkt folgt den echten Torzeiten (harter Sprung)', () => {
  const hist = buildLiveProbabilityTimeline({
    ...PREGAME, goals: [{ minute: 20, side: 'away' }], homeGoals: 0, awayGoals: 1, elapsedMinutes: 40, phase: 'REG',
  })
  const before = hist.find((p) => p.elapsedSeconds === 20 * 60 - 1)
  const at = hist.find((p) => p.elapsedSeconds === 20 * 60)
  assert.ok(before && at, 'Tor-Randpunkte (Sekunde davor/Torsekunde) fehlen')
  assert.equal(before.awayGoals, 0)
  assert.equal(at.awayGoals, 1)
})

test('buildLiveProbabilityTimeline: OT -> Regulationskurve endet bei 60:00, Jetzt-Punkt eingefroren jenseits davon', () => {
  const hist = buildLiveProbabilityTimeline({
    ...PREGAME, goals: [{ minute: 10, side: 'home' }, { minute: 50, side: 'away' }], homeGoals: 1, awayGoals: 1, elapsedMinutes: 63, phase: 'OT',
  })
  const last = hist[hist.length - 1]
  assert.ok(last.elapsedSeconds > 60 * 60, 'Jetzt-Punkt liegt nicht jenseits der Regulationszeit')
  assert.ok(Math.abs(last.drawAfter60 - 1) < 1e-9, 'OT-Jetzt-Punkt nicht eingefroren (drawAfter60≈1)')
  assert.ok(Math.abs(last.homeWin - PREGAME.pHomePreGame) < 1e-9, 'OT homeFinal != Pre-Game-pHome')
})

test('buildLiveProbabilityTimeline: keine Tore / Spielbeginn -> trotzdem gültige Reihe', () => {
  const hist = buildLiveProbabilityTimeline({ ...PREGAME, goals: [], homeGoals: 0, awayGoals: 0, elapsedMinutes: 5, phase: 'REG' })
  assert.ok(hist.length >= 2)
  assert.equal(hist[0].eventType, 'START')
  for (const p of hist) assert.ok(Number.isFinite(p.homeWin) && Number.isFinite(p.awayWin))
})

// ---------------------------------------------------------------------------
// Live-Zeitposition: Drittel-Offset, Pause, Drittel-geklemmte Spielzeit,
// Wanduhr-Fortschreibung des "JETZT"-Markers.
// ---------------------------------------------------------------------------
test('regulationPeriodOffsetMinutes: Drittel-Name -> Offset 0/20/40, sonst null', () => {
  assert.equal(regulationPeriodOffsetMinutes('1. Drittel'), 0)
  assert.equal(regulationPeriodOffsetMinutes('2. Drittel'), 20)
  assert.equal(regulationPeriodOffsetMinutes('3. Drittel'), 40)
  assert.equal(regulationPeriodOffsetMinutes('Pause'), null)
  assert.equal(regulationPeriodOffsetMinutes('Overtime'), null)
  assert.equal(regulationPeriodOffsetMinutes(null), null)
})

test('isIntermissionStatus: erkennt Pause/Unterbrechung', () => {
  assert.equal(isIntermissionStatus('Pause'), true)
  assert.equal(isIntermissionStatus('1. Pause'), true)
  assert.equal(isIntermissionStatus('3. Drittel'), false)
})

test('regulationElapsedMinutes: percent wird ins Drittel-Fenster des verbindlichen Namens geklemmt', () => {
  // 1. Drittel ~05:00 (percent ~8.3)
  assert.ok(Math.abs(regulationElapsedMinutes({ statusLabel: '1. Drittel', percent: 8.33 }) - 5) < 0.1)
  // 2. Drittel ~25:00 (percent ~41.7)
  assert.ok(Math.abs(regulationElapsedMinutes({ statusLabel: '2. Drittel', percent: 41.67 }) - 25) < 0.1)
  // 3. Drittel ~50:00 (percent ~83.3)
  assert.ok(Math.abs(regulationElapsedMinutes({ statusLabel: '3. Drittel', percent: 83.33 }) - 50) < 0.1)
  // Drittelwechsel-Fall: Name sagt "3. Drittel", percent hängt noch bei 66 (=39.6') -> auf 40:00 geklemmt
  assert.equal(regulationElapsedMinutes({ statusLabel: '3. Drittel', percent: 66 }), 40)
  // percent zu hoch fürs genannte Drittel -> ans Drittelende geklemmt
  assert.equal(regulationElapsedMinutes({ statusLabel: '2. Drittel', percent: 95 }), 40)
})

test('regulationElapsedMinutes + periodTimeFromElapsed: Marker-Zeit passt zum angezeigten Drittel', () => {
  const elapsed = regulationElapsedMinutes({ statusLabel: '3. Drittel', percent: 83 }) // ~49.8'
  const { period, periodTime } = periodTimeFromElapsed(elapsed)
  assert.equal(period, 3)
  assert.equal(periodTime, '09:48')
})

test('advanceDisplayedElapsed: läuft zwischen Snapshots per Wanduhr weiter, innerhalb des Drittels', () => {
  const t0 = 1_000_000
  // Anker 50:00 im 3. Drittel, 30s Wanduhr später -> ~50:30
  const d = advanceDisplayedElapsed({ confirmedMin: 50, anchorWallMs: t0, nowMs: t0 + 30_000, offsetMin: 40, intermission: false, prevDisplayedMin: null })
  assert.ok(Math.abs(d - 50.5) < 1e-6)
})

test('advanceDisplayedElapsed: Pause friert die Uhr ein (keine Echtzeit-Fortschreibung)', () => {
  const t0 = 1_000_000
  const d = advanceDisplayedElapsed({ confirmedMin: 40, anchorWallMs: t0, nowMs: t0 + 120_000, offsetMin: null, intermission: true, prevDisplayedMin: null })
  assert.equal(d, 40)
})

test('advanceDisplayedElapsed: kein Rücksprung (monoton) und Deckel am Drittelende', () => {
  const t0 = 1_000_000
  // monoton: bereits 50.4 gezeigt, neuer Anker 50.0 -> bleibt >= 50.4
  const mono = advanceDisplayedElapsed({ confirmedMin: 50, anchorWallMs: t0, nowMs: t0, offsetMin: 40, intermission: false, prevDisplayedMin: 50.4 })
  assert.ok(mono >= 50.4)
  // Deckel: 59:00 + 5 Wanduhrminuten -> nicht über 60:00 (Drittelende 3. Drittel)
  const capped = advanceDisplayedElapsed({ confirmedMin: 59, anchorWallMs: t0, nowMs: t0 + 5 * 60_000, offsetMin: 40, intermission: false, prevDisplayedMin: null })
  assert.ok(capped <= 60 + 1e-9)
})
