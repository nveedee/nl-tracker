// ---------------------------------------------------------------------------
// Tests für src/playerRatingDisplay.js - reine UI-Ableitungsfunktionen
// (Datengrundlage-Kategorie, Breakdown-Zeilenliste). Keine neue
// Rating-Berechnung, nur Darstellungslogik.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dataQualityLabel, positionGroupLabel, positionLabel, buildRatingBreakdown, DATA_QUALITY_THRESHOLDS } from './playerRatingDisplay.js'

test('dataQualityLabel: gering/mittel/hoch anhand der dokumentierten Schwellen, kein Vorhersagewert-Wording', () => {
  assert.equal(dataQualityLabel(0), 'gering')
  assert.equal(dataQualityLabel(DATA_QUALITY_THRESHOLDS.mittel - 0.1), 'gering')
  assert.equal(dataQualityLabel(DATA_QUALITY_THRESHOLDS.mittel), 'mittel')
  assert.equal(dataQualityLabel(DATA_QUALITY_THRESHOLDS.hoch - 0.1), 'mittel')
  assert.equal(dataQualityLabel(DATA_QUALITY_THRESHOLDS.hoch), 'hoch')
  assert.equal(dataQualityLabel(100), 'hoch')
})

test('dataQualityLabel: null-Confidence liefert null, kein erfundener Default', () => {
  assert.equal(dataQualityLabel(null), null)
  assert.equal(dataQualityLabel(undefined), null)
})

test('positionGroupLabel/positionLabel: F/D/G korrekt, unbekannte Position liefert null', () => {
  assert.equal(positionGroupLabel('F'), 'Stürmern')
  assert.equal(positionGroupLabel('D'), 'Verteidigern')
  assert.equal(positionGroupLabel('G'), 'Torhütern')
  assert.equal(positionGroupLabel('X'), null)
  assert.equal(positionLabel('F'), 'Stürmer')
  assert.equal(positionLabel('G'), 'Torhüter')
})

test('buildRatingBreakdown: Feldspieler zeigt alle 5 Kategorien + Career, wenn vorhanden', () => {
  const rating = {
    position: 'F', offense: 70, defense: 40, specialTeams: 55, usage: 60, form: 65,
    components: { careerImpactScore: 50 },
  }
  const rows = buildRatingBreakdown(rating)
  assert.deepEqual(rows.map((r) => r.key), ['offense', 'defense', 'specialTeams', 'usage', 'form', 'career'])
  assert.equal(rows.find((r) => r.key === 'career').value, 50)
})

test('buildRatingBreakdown: Torhüter zeigt NUR Shot Stopping/Usage/Form(+Career) - offense/specialTeams werden nie erzeugt', () => {
  const rating = {
    position: 'G', offense: null, defense: 72, specialTeams: null, usage: 55, form: 60,
    components: { careerImpactScore: 48 },
  }
  const rows = buildRatingBreakdown(rating)
  assert.deepEqual(rows.map((r) => r.key), ['defense', 'usage', 'form', 'career'])
  assert.equal(rows.find((r) => r.key === 'defense').label, 'Shot Stopping')
})

test('buildRatingBreakdown: fehlende Kategorien werden weggelassen, nicht als Platzhalter gezeigt', () => {
  const rating = { position: 'F', offense: 62, defense: null, specialTeams: null, usage: null, form: null, components: {} }
  const rows = buildRatingBreakdown(rating)
  assert.deepEqual(rows.map((r) => r.key), ['offense'])
})

test('buildRatingBreakdown: null-Rating liefert leere Liste, kein Crash', () => {
  assert.deepEqual(buildRatingBreakdown(null), [])
  assert.deepEqual(buildRatingBreakdown(undefined), [])
})

test('buildRatingBreakdown: kleines Sample (alle Werte null ausser Career unverfügbar) liefert leere Liste statt erfundener Werte', () => {
  const rating = { position: 'F', offense: null, defense: null, specialTeams: null, usage: null, form: null, components: { careerImpactScore: null } }
  assert.deepEqual(buildRatingBreakdown(rating), [])
})
