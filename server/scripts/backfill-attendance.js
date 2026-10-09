#!/usr/bin/env node
// Manueller, gezielter Backfill echter Zuschauerzahlen aus
// overview.spectators. Standardmässig lokaler Dry-Run; API-Zugriff und
// Schreiben erfolgen ausschliesslich mit explizitem --write.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fetchGameDetail } from '../nlGameDetailSync.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.PERSIST_DIR || path.join(here, '..', 'data')
const dbPath = path.join(dataDir, 'db.json')

export function hasValidAttendance(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) return false
  const number = Number(value)
  return Number.isFinite(number) && number > 0
}

export function findAttendanceCandidates(db) {
  return (db.games || [])
    .filter((game) => game.status === 'final'
      && game.externalId != null
      && String(game.externalId).trim() !== ''
      && !hasValidAttendance(game.attendance))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

export function readSpectators(detail) {
  if (detail?.overview?.status !== 'finished') return null
  const value = detail.overview.spectators
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

export function parseLimit(args) {
  const limitArgs = args.filter((arg) => arg === '--limit' || arg.startsWith('--limit='))
  if (limitArgs.length === 0) return undefined
  if (limitArgs.length > 1 || !limitArgs[0].startsWith('--limit=')) {
    throw new Error('Ungültiges --limit. Erwartet wird genau ein positives ganzzahliges --limit=N.')
  }
  const value = limitArgs[0].slice('--limit='.length)
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('Ungültiges --limit. N muss eine positive ganze Zahl sein, zum Beispiel --limit=5.')
  }
  const limit = Number(value)
  if (!Number.isSafeInteger(limit)) {
    throw new Error('Ungültiges --limit. N muss eine positive sichere Ganzzahl sein.')
  }
  return limit
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function runAttendanceBackfill({
  db,
  write = false,
  fetchDetail = fetchGameDetail,
  save = () => {},
  log = () => {},
  delay = sleep,
  requestDelayMs = 500,
  limit,
} = {}) {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new Error('Ungültiges --limit. N muss eine positive sichere Ganzzahl sein.')
  }
  const allCandidates = findAttendanceCandidates(db)
  const candidates = limit === undefined ? allCandidates : allCandidates.slice(0, limit)
  log(`[ATTENDANCE] ${candidates.length} geeignet(e) Spiel(e) ohne gültige Zuschauerzahl.`)
  if (!write) {
    for (const game of candidates) log(`  ${game.date || 'Datum unbekannt'} ${game.id}: externe ID ${game.externalId}`)
    log('[ATTENDANCE] Dry-Run: keine API-Aufrufe und keine Änderungen.')
    return { candidates: candidates.length, updated: 0, errors: 0 }
  }

  let updated = 0
  let errors = 0
  for (let index = 0; index < candidates.length; index++) {
    const game = candidates[index]
    try {
      const detail = await fetchDetail(game.externalId, { log })
      const attendance = readSpectators(detail)
      if (attendance == null) {
        log(`  ${game.id}: keine gültige Zuschauerzahl in der Detailantwort; übersprungen.`)
      } else if (!hasValidAttendance(game.attendance)) {
        game.attendance = attendance
        updated++
        log(`  ${game.id}: ${attendance} Zuschauer ergänzt.`)
      }
    } catch (error) {
      errors++
      log(`  ${game.id}: Abruf/Verarbeitung fehlgeschlagen (${error.message}); nächstes Spiel folgt.`)
    }
    if (index < candidates.length - 1) await delay(requestDelayMs)
  }

  if (updated > 0) await save(db)
  log(`[ATTENDANCE] Fertig: ${updated} ergänzt, ${errors} Fehler.`)
  return { candidates: candidates.length, updated, errors }
}

function readDb() { return JSON.parse(fs.readFileSync(dbPath, 'utf8')) }
function writeDb(db) { fs.writeFileSync(dbPath, JSON.stringify(db, null, 2)) }

async function main() {
  const limit = parseLimit(process.argv.slice(2))
  const write = process.argv.includes('--write')
  const db = readDb()
  await runAttendanceBackfill({ db, write, save: writeDb, log: console.log, limit })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[ATTENDANCE] Unerwarteter Fehler: ${error.message}`)
    process.exitCode = 1
  })
}
