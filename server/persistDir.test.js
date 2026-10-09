// ---------------------------------------------------------------------------
// Tests für die persistente Datenpfad-Konfiguration (Option A, Render-Disk).
//
// Verifiziert, dass die SCHREIBBAREN Laufzeitdateien (db.json + Sync-Status)
// über PERSIST_DIR aufgelöst werden, während seed.json/fixtures im Repo-Pfad
// (server/data) verbleiben. Läuft vollständig isoliert in einem Temp-
// Verzeichnis - KEINE Berührung der echten server/data/db.json.
//
// Aufruf: node --test server/persistDir.test.js
//
// WICHTIG: PERSIST_DIR muss gesetzt sein, BEVOR die Module importiert werden
// (die Pfade sind Modul-Konstanten, die beim Import aus process.env gelesen
// werden) - daher das Setzen ganz oben vor den dynamischen Imports.
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// Frisches, isoliertes persistentes Verzeichnis (simuliert den leeren Render-
// Disk-Mount) - VOR den Modul-Imports setzen.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-persist-'))
process.env.PERSIST_DIR = TMP

const NL_STATUS = { lastRunAt: '2026-01-01T00:00:00.000Z', lastSuccessAt: '2026-01-01T00:00:00.000Z', marker: 'nl-sentinel' }
const SIHF_STATUS = { lastRunAt: '2026-01-02T00:00:00.000Z', lastSuccessAt: '2026-01-02T00:00:00.000Z', marker: 'sihf-sentinel' }
fs.writeFileSync(path.join(TMP, 'nl-sync-status.json'), JSON.stringify(NL_STATUS))
fs.writeFileSync(path.join(TMP, 'sihf-sync-status.json'), JSON.stringify(SIHF_STATUS))

// Jetzt (nach gesetztem PERSIST_DIR) importieren.
const { readNlSyncStatus } = await import('./sync.js')
const sihf = require('./scripts/sync-sihf.cjs')

test('NL-Sync-Status wird aus PERSIST_DIR gelesen (nicht aus server/data)', () => {
  const s = readNlSyncStatus()
  assert.ok(s, 'readNlSyncStatus lieferte null')
  assert.equal(s.marker, 'nl-sentinel')
})

test('SIHF-Sync-Status wird aus PERSIST_DIR gelesen (nicht aus server/data)', () => {
  const s = sihf.readSyncStatus()
  assert.ok(s, 'readSyncStatus lieferte null')
  assert.equal(s.marker, 'sihf-sentinel')
})

test('seed.json bleibt im Repo-Pfad server/data (NICHT im persistenten Verzeichnis)', () => {
  const repoSeed = path.join(__dirname, 'data', 'seed.json')
  assert.ok(fs.existsSync(repoSeed), 'seed.json fehlt am Repo-Pfad server/data')
  assert.ok(!fs.existsSync(path.join(TMP, 'seed.json')), 'seed.json darf nicht im persistenten Verzeichnis liegen')
})

test('Default ohne PERSIST_DIR fällt auf server/data zurück (lokales Verhalten unverändert)', () => {
  // Kindprozess OHNE PERSIST_DIR: sync-sihf.cjs muss dann aus server/data lesen.
  const script =
    "const s=require(" + JSON.stringify(path.join(__dirname, 'scripts', 'sync-sihf.cjs')) + ");" +
    "process.stdout.write(JSON.stringify(s.readSyncStatus()));"
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, PERSIST_DIR: '' }, // leer -> falsy -> Default server/data
    encoding: 'utf-8',
  })
  const childStatus = JSON.parse(out)
  // Direkter Lesevergleich mit der echten Datei am Repo-Pfad (existiert oder
  // null) - beweist, dass der Default server/data ist, nicht das Temp-Verzeichnis.
  const repoStatusPath = path.join(__dirname, 'data', 'sihf-sync-status.json')
  const expected = fs.existsSync(repoStatusPath) ? JSON.parse(fs.readFileSync(repoStatusPath, 'utf-8')) : null
  assert.deepEqual(childStatus, expected)
  // Und definitiv NICHT das Temp-Sentinel (sonst hätte der Default fälschlich PERSIST_DIR genutzt).
  if (childStatus) assert.notEqual(childStatus.marker, 'sihf-sentinel')
})

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* egal */ }
})
