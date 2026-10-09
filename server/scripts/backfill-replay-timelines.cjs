#!/usr/bin/env node
'use strict'
// ---------------------------------------------------------------------------
// BACKFILL für historische Replay-Timelines (Option A, siehe Commit 8489549).
//
// Ergänzt `game.replayTimeline` für bereits ABGESCHLOSSENE NL-Spiele, die der
// normale SIHF-Sync nicht (mehr) im Prüffenster hat (server/scripts/
// sync-sihf.cjs::inCheckWindow). Verwendet AUSSCHLIESSLICH die bestehende
// SIHF-Verarbeitung aus sync-sihf.cjs - KEINE zweite, abweichende
// Implementierung:
//   - fetchSihfGame()           : Abruf inkl. Retry/Backoff + Rate-Limit-Pause
//   - parseReplayTimeline()     : Rohfelder -> Timeline (nur echte SIHF-Daten)
//   - isReplayTimelineComplete(): Vollständigkeitsprüfung
//   - saveReplayTimelineIfBetter(): nicht-klobbernd (ersetzt eine vollständige
//                                   Timeline NIE durch unvollständige Daten)
//
// SICHERHEIT:
//   - Standard: DRY-RUN (nur anzeigen, kein Netzwerk, kein Write). Schreiben
//     NUR mit dem expliziten Flag --write.
//   - Nur Spiele mit status:'final' UND gültiger sihfGameId UND noch KEINER
//     vollständigen replayTimeline werden berücksichtigt.
//   - Es wird ausschliesslich das Feld `replayTimeline` ergänzt. Jeder Write
//     liest die DB FRISCH ein und setzt nur dieses eine Feld des EINEN Spiels
//     (kein Voll-Write einer veralteten Kopie -> überschreibt keine parallelen
//     Sync-Writes, keine Resultate/externalId/Teamdaten/ELO/Prognosen).
//   - Idempotent & wiederholbar: ein erneuter Lauf findet bereits vollständige
//     Spiele nicht mehr als Kandidaten.
//   - KEIN automatischer Aufruf beim Serverstart, KEINE Änderung an Sync-
//     Intervallen (reines, manuell zu startendes CLI-Tool).
//
// Nutzung:
//   node server/scripts/backfill-replay-timelines.cjs            # Dry-Run
//   node server/scripts/backfill-replay-timelines.cjs --write    # schreibt
//   Optionen: --limit=<n> (max. Spiele), --pause=<ms> (Pause zwischen Abrufen)
// ---------------------------------------------------------------------------

const fs = require('fs')
const path = require('path')
const sihfSync = require('./sync-sihf.cjs')

// Identische Pfadauflösung wie die übrigen Module (PERSIST_DIR -> Render-Disk,
// lokal Default server/data). __dirname ist server/scripts, daher '..'.
const PERSIST_DIR = process.env.PERSIST_DIR || path.join(__dirname, '..', 'data')
const DB_PATH = path.join(PERSIST_DIR, 'db.json')

function readDb() { return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')) }
function writeDb(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)) }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Kandidaten: abgeschlossen + sihfGameId vorhanden + noch KEINE vollständige
// replayTimeline. Rein lokal (kein Netzwerk) - identische Vollständigkeits-
// prüfung wie der Live-Sync.
function findCandidates(db) {
  return (db.games || []).filter((g) =>
    g.status === 'final' && g.sihfGameId &&
    !sihfSync.isReplayTimelineComplete(g.replayTimeline, g.decision)
  )
}

// write=false -> DRY-RUN: listet nur die lokal ermittelten Kandidaten, OHNE
// SIHF abzufragen und ohne zu schreiben.
async function runBackfill({ write = false, log = () => {}, limit = Infinity, pauseMs = 300 } = {}) {
  const db = readDb()
  const all = findCandidates(db)
  const candidates = Number.isFinite(limit) ? all.slice(0, Math.max(0, limit)) : all
  log(`[BACKFILL] ${all.length} Spiel(e) ohne vollständige replayTimeline (final + sihfGameId)${Number.isFinite(limit) ? `, limitiert auf ${candidates.length}` : ''}.`)

  let checked = 0, skipped = 0, saved = 0, failed = 0

  if (!write) {
    for (const g of candidates) {
      checked++
      log(`  [DRY] ${g.id} · ${g.date} · sihf ${g.sihfGameId} · decision ${g.decision || '-'}`)
    }
    log(`[BACKFILL] DRY-RUN: ${candidates.length} Spiel(e) würden abgefragt/ergänzt. Mit --write ausführen.`)
    return { checked, skipped, saved, failed, candidates: candidates.length, dryRun: true }
  }

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i]
    checked++
    log(`[BACKFILL] (${i + 1}/${candidates.length}) ${cand.id} · sihf ${cand.sihfGameId} …`)

    let raw = null
    try {
      // fetchSihfGame hat bereits internen Retry/Backoff + Rate-Limit-Pause.
      const res = await sihfSync.fetchSihfGame(cand.sihfGameId, { log })
      if (res.status === 404 || !res.json || !res.json.details) {
        log(`  … ${cand.id}: SIHF liefert keine Daten (404/leer) - übersprungen`)
        skipped++
        await sleep(pauseMs)
        continue
      }
      raw = res.json
    } catch (e) {
      log(`  ✗ ${cand.id}: Abruf fehlgeschlagen (${e.message}) - übersprungen`)
      failed++
      await sleep(pauseMs)
      continue
    }

    // Nicht-klobbernder Write: DB frisch einlesen, nur das EINE Spiel ergänzen,
    // sofort speichern. saveReplayTimelineIfBetter() schützt eine bereits
    // vollständige Timeline und speichert unvollständige Daten gar nicht erst.
    try {
      const fresh = readDb()
      const g = fresh.games.find((x) => x.id === cand.id)
      if (!g) {
        log(`  … ${cand.id}: nicht mehr in der DB - übersprungen`)
        skipped++
        await sleep(pauseMs)
        continue
      }
      const didSave = sihfSync.saveReplayTimelineIfBetter(g, raw, g.decision)
      if (didSave) {
        writeDb(fresh)
        saved++
        log(`  ✓ ${cand.id}: replayTimeline gespeichert`)
      } else {
        skipped++
        log(`  … ${cand.id}: keine vollständige Timeline ableitbar oder bereits vollständig - übersprungen`)
      }
    } catch (e) {
      log(`  ✗ ${cand.id}: Speichern fehlgeschlagen (${e.message})`)
      failed++
    }
    await sleep(pauseMs)
  }

  log(`[BACKFILL] Fertig: ${checked} geprüft · ${saved} gespeichert · ${skipped} übersprungen · ${failed} fehlgeschlagen.`)
  return { checked, skipped, saved, failed, candidates: candidates.length, dryRun: false }
}

async function main() {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const limitArg = args.find((a) => a.startsWith('--limit='))
  const pauseArg = args.find((a) => a.startsWith('--pause='))
  let limit = Infinity
  if (limitArg) { const n = Number(limitArg.split('=')[1]); if (Number.isFinite(n) && n >= 0) limit = n }
  let pauseMs = 300
  if (pauseArg) { const n = Number(pauseArg.split('=')[1]); if (Number.isFinite(n) && n >= 0) pauseMs = n }

  const log = (...a) => console.log(...a)
  log('[BACKFILL]' + (write ? ' SCHREIBMODUS (--write)' : ' DRY-RUN (Standard; mit --write schreiben)'))
  log(`[BACKFILL] DB: ${DB_PATH}`)
  try {
    await runBackfill({ write, log, limit, pauseMs })
  } catch (e) {
    console.error('[BACKFILL] Abbruch wegen Fehler:', e.message)
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = { runBackfill, findCandidates }
