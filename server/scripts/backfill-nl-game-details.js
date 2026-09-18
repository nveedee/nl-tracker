#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Historischer Backfill der NL-Game-Detail-Daten (Auftrag Punkt 12) -
// EIGENSTÄNDIGES, manuell auszuführendes Skript, NICHT Teil des normalen
// Auto-Sync-Polls (server/index.js ruft server/nlGameDetailSync.js dort nur
// mit einem kleinen Limit pro Lauf auf, siehe DEFAULT_PER_RUN_LIMIT) - so
// werden beim normalen App-Start/Poll NIE hunderte Requests auf einmal
// ausgelöst.
//
// Holt in einer Schleife weiterhin ausstehende (status:'final', externalId
// gesetzt, kein nlDetailSyncedAt) Spiele nach, bis entweder alle erledigt
// sind oder --max erreicht ist. Nutzt dieselbe Sync-/Fehlerbehandlungslogik
// wie der reguläre Poll (server/nlGameDetailSync.js::runNlGameDetailSync) -
// ein einzelnes fehlschlagendes Spiel bricht den Backfill nicht ab.
//
// Aufruf:
//   node server/scripts/backfill-nl-game-details.js                (Dry-Run, Default)
//   node server/scripts/backfill-nl-game-details.js --write         (schreibt tatsächlich)
//   node server/scripts/backfill-nl-game-details.js --write --max 100
//   node server/scripts/backfill-nl-game-details.js --write --batch 20  (Requests/Batch, Pause dazwischen)
// ---------------------------------------------------------------------------

import { runNlGameDetailSync } from '../nlGameDetailSync.js'

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function main() {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const getArg = (name, fallback) => {
    const i = args.indexOf(name)
    return i !== -1 && args[i + 1] ? Number(args[i + 1]) : fallback
  }
  const max = getArg('--max', Infinity)
  const batch = getArg('--batch', 20)
  const pauseMs = getArg('--pause-ms', 3000) // Pause zwischen Batches (Höflichkeit ggü. der API, siehe Erkundung: 10-Min-Cache)

  console.log(`[BACKFILL] Historischer NL-Game-Detail-Import${write ? '' : ' (DRY RUN - es wird nichts geschrieben)'}`)
  console.log(`[BACKFILL] Batch-Grösse ${batch}, Pause ${pauseMs}ms zwischen Batches, max. ${Number.isFinite(max) ? max : 'unbegrenzt'} Spiele gesamt.`)

  let totalUpdated = 0, totalErrors = 0, totalChecked = 0
  for (;;) {
    if (totalChecked >= max) { console.log('[BACKFILL] Maximum erreicht, stoppe.'); break }
    const limit = Math.min(batch, max - totalChecked)
    const summary = await runNlGameDetailSync({ write, log: (...a) => console.log(...a), limit })
    totalUpdated += summary.updated
    totalErrors += summary.errors
    totalChecked += summary.checked
    if (summary.checked === 0) { console.log('[BACKFILL] Keine weiteren offenen Spiele - fertig.'); break }
    if (summary.checked < limit) { console.log('[BACKFILL] Letzter Batch war nicht voll - alle offenen Spiele abgearbeitet.'); break }
    await sleep(pauseMs)
  }

  console.log(`\n[BACKFILL] Abgeschlossen: ${totalChecked} geprüft, ${totalUpdated} ergänzt, ${totalErrors} Fehler.`)
  if (!write) console.log('[BACKFILL] Dry-Run - zum tatsächlichen Speichern mit --write erneut ausführen.')
}

main().catch((e) => { console.error('[BACKFILL] Abbruch wegen unerwartetem Fehler:', e.message); process.exitCode = 1 })
