// ---------------------------------------------------------------------------
// Test für den kontrollierten, SCHREIBFREIEN Erststart (BOOT_SKIP_SYNC=1).
//
// Bootet server/index.js in einem isolierten Kindprozess mit einem Temp-
// PERSIST_DIR und einem ephemeren Port (PORT=0) und prüft, dass KEIN
// automatischer, db.json-verändernder Startjob läuft (NL-Sync, SIHF-Discover,
// SIHF-Auto-Sync) und das Live-Polling deaktiviert ist. ensureDb() (reine
// Initialisierung, kein Sync) darf weiterhin aus seed.json seeden.
//
// Bewusst NUR der BOOT_SKIP_SYNC=1-Pfad: dieser löst per Definition KEINEN
// Sync aus und ist damit netzwerk-frei/deterministisch. Der Default-Pfad
// (ohne Schalter) würde den unbedingten Start-NL-Sync auslösen - das wäre ein
// echter Sync-Aufruf und wird deshalb hier NICHT gebootet (siehe Bericht:
// Default-Verhalten ist rein additiv `!bootSkipSync && …` und damit
// unverändert).
//
// Aufruf: node --test server/bootSkipSync.test.js
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INDEX = path.join(__dirname, 'index.js')

function bootAndCollect(env, ms) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INDEX], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), ms)
    child.on('exit', () => { clearTimeout(timer); resolve(out) })
    child.on('error', () => { clearTimeout(timer); resolve(out) })
  })
}

test('BOOT_SKIP_SYNC=1: kein automatischer Start-Job läuft, ensureDb seedet trotzdem', async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-boot-'))
  try {
    const out = await bootAndCollect({ BOOT_SKIP_SYNC: '1', PERSIST_DIR: TMP, PORT: '0' }, 2500)

    assert.match(out, /BOOT_SKIP_SYNC=1/, 'Hinweis-Log fehlt')
    // KEIN db.json-verändernder Startjob:
    assert.doesNotMatch(out, /\[NL SYNC\]/, 'Start-NL-Sync lief trotz BOOT_SKIP_SYNC')
    assert.doesNotMatch(out, /\[NL GAME DETAIL\]/, 'Game-Detail-Sync lief trotz BOOT_SKIP_SYNC')
    assert.doesNotMatch(out, /\[SIHF DISCOVER\]/, 'SIHF-Discover lief trotz BOOT_SKIP_SYNC')
    assert.doesNotMatch(out, /SIHF-Auto-Sync aktiv/, 'SIHF-Auto-Sync aktiviert trotz BOOT_SKIP_SYNC')
    assert.doesNotMatch(out, /NL-Auto-Sync aktiv/, 'NL-Auto-Sync aktiviert trotz BOOT_SKIP_SYNC')
    assert.doesNotMatch(out, /Live-Auto-Poll aktiv/, 'Live-Auto-Poll aktiviert trotz BOOT_SKIP_SYNC')
    assert.doesNotMatch(out, /SIHF-Auto-Discover aktiv/, 'SIHF-Auto-Discover aktiviert trotz BOOT_SKIP_SYNC')

    // ensureDb() (reine Initialisierung) lief: db.json aus seed.json (364 Spiele).
    const dbPath = path.join(TMP, 'db.json')
    assert.ok(fs.existsSync(dbPath), 'db.json wurde nicht initialisiert')
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8'))
    assert.equal((db.games || []).length, 364, 'db.json nicht aus seed.json (364 Spiele) initialisiert')
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* egal */ }
  }
})
