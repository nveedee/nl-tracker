import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import sihfSync from './scripts/sync-sihf.cjs'
import { runNlSync, readNlSyncStatus, DEFAULT_NL_SYNC_INTERVAL_MIN } from './sync.js'

const { runSync: runSihfSync, readSyncStatus } = sihfSync

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
const DB_PATH = path.join(DATA_DIR, 'db.json')
const SEED_PATH = path.join(DATA_DIR, 'seed.json')
const DIST_DIR = path.join(__dirname, '..', 'dist')
const PORT = process.env.PORT || 3001

// ---------------------------------------------------------------------------
// DB-Helfer: db.json lesen/schreiben. Existiert die Datei nicht, wird sie aus
// seed.json (14 NL-Teams) erzeugt.
// ---------------------------------------------------------------------------
function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(DB_PATH)) {
    const seed = fs.existsSync(SEED_PATH)
      ? fs.readFileSync(SEED_PATH, 'utf-8')
      : JSON.stringify(emptyDb(), null, 2)
    fs.writeFileSync(DB_PATH, seed)
  }
}

function emptyDb() {
  return {
    settings: {
      seasonName: 'National League 2026/27',
      eloStart: 1500,
      eloK: 16,
      eloHomeAdvantage: 65,
      // Prognose-Erweiterungen (src/marketValuePrior.js, src/restDays.js) -
      // beide unabhängig abschaltbar, siehe Settings-Seite.
      marketValuePriorEnabled: true,
      priorSpread: 120,
      restDaysEnabled: true,
      backToBackPenalty: 0.04,
    },
    teams: [],
    players: [],
    games: [],
    predictions: [],
  }
}

function readDb() {
  ensureDb()
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'))
  } catch (e) {
    console.error('db.json konnte nicht gelesen werden:', e.message)
    return emptyDb()
  }
}

function writeDb(db) {
  ensureDb()
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2))
}

// Simple, kollisionsarme ID.
function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

const app = express()
app.use(express.json({ limit: '5mb' }))

// ---------------------------------------------------------------------------
// Gesamte Daten
// ---------------------------------------------------------------------------
app.get('/api/data', (_req, res) => {
  res.json(readDb())
})

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
app.put('/api/settings', (req, res) => {
  const db = readDb()
  db.settings = { ...db.settings, ...req.body }
  writeDb(db)
  res.json(db.settings)
})

// ---------------------------------------------------------------------------
// Generischer CRUD-Helfer für Collections (teams, players, games)
// ---------------------------------------------------------------------------
function crud(collection, idPrefix) {
  app.post(`/api/${collection}`, (req, res) => {
    const db = readDb()
    const item = { id: makeId(idPrefix), ...req.body }
    db[collection].push(item)
    writeDb(db)
    res.status(201).json(item)
  })

  app.put(`/api/${collection}/:id`, (req, res) => {
    const db = readDb()
    const idx = db[collection].findIndex((x) => x.id === req.params.id)
    if (idx === -1) return res.status(404).json({ error: 'Nicht gefunden' })
    db[collection][idx] = { ...db[collection][idx], ...req.body, id: req.params.id }
    writeDb(db)
    res.json(db[collection][idx])
  })

  app.delete(`/api/${collection}/:id`, (req, res) => {
    const db = readDb()
    const before = db[collection].length
    db[collection] = db[collection].filter((x) => x.id !== req.params.id)
    // Aufräumen abhängiger Daten
    if (collection === 'teams') {
      db.players = db.players.filter((p) => p.teamId !== req.params.id)
      db.games = db.games.filter(
        (g) => g.homeTeamId !== req.params.id && g.awayTeamId !== req.params.id
      )
    }
    if (collection === 'players') {
      db.games = db.games.map((g) => ({
        ...g,
        playerStats: (g.playerStats || []).filter((s) => s.playerId !== req.params.id),
      }))
    }
    writeDb(db)
    res.json({ removed: before - db[collection].length })
  })
}

crud('teams', 'team')
crud('players', 'player')
// KEIN crud('games', 'game') mehr: Spiele kommen ausschliesslich über den
// Sync (SIHF/NL, s.u.) - manuelle Erfassung/Bearbeitung/Löschung von Spielen
// wurde entfernt (src/pages/GameEntry.jsx), da sie den Sync nur duplizierte.

// ---------------------------------------------------------------------------
// SIHF-Sync (server/scripts/sync-sihf.cjs) - hält den Spielplan mit den
// offiziellen SIHF-Resultaten synchron. Der Sync-Code selbst lebt komplett
// im eigenständigen Skript; hier nur ein dünner Trigger + Status-Endpunkt.
// ---------------------------------------------------------------------------
let syncRunning = false

app.get('/api/sync-status', (_req, res) => {
  res.json(readSyncStatus() || { lastRunAt: null, lastSuccessAt: null })
})

app.post('/api/sync', async (_req, res) => {
  if (syncRunning) return res.status(409).json({ error: 'Sync läuft bereits' })
  syncRunning = true
  const logs = []
  try {
    const summary = await runSihfSync({ write: true, log: (...a) => logs.push(a.join(' ')) })
    res.json({ ...summary, logs })
  } catch (e) {
    res.status(502).json({ error: 'SIHF-Synchronisation momentan nicht verfügbar.', message: e.message, logs })
  } finally {
    syncRunning = false
  }
})

// ---------------------------------------------------------------------------
// National-League-API-Sync (server/sync.js) - eigenständig von obigem
// SIHF-Sync: spiegelt Spiele, Tabelle und Spieler-Rohdaten der öffentlichen
// nationalleague.ch-API. Bewusst unter einem anderen Pfad (/api/sync-nl),
// damit der bestehende /api/sync-Button (SIHF-Live-Boxscores) unverändert
// funktioniert.
// ---------------------------------------------------------------------------
let nlSyncRunning = false

app.get('/api/sync-nl-status', (_req, res) => {
  res.json(readNlSyncStatus() || { lastRunAt: null, lastSuccessAt: null })
})

app.post('/api/sync-nl', async (_req, res) => {
  if (nlSyncRunning) return res.status(409).json({ error: 'NL-Sync läuft bereits' })
  nlSyncRunning = true
  const logs = []
  try {
    const summary = await runNlSync({ write: true, log: (...a) => logs.push(a.join(' ')) })
    res.json({ ...summary, logs })
  } catch (e) {
    res.status(502).json({ error: 'National-League-API momentan nicht erreichbar oder Team-Mapping fehlgeschlagen.', message: e.message, logs })
  } finally {
    nlSyncRunning = false
  }
})

// ---------------------------------------------------------------------------
// Backup / Import / Reset
// ---------------------------------------------------------------------------
app.get('/api/export', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="nl-backup.json"')
  res.json(readDb())
})

app.post('/api/import', (req, res) => {
  const incoming = req.body
  if (!incoming || !Array.isArray(incoming.teams)) {
    return res.status(400).json({ error: 'Ungültiges Backup-Format' })
  }
  const db = emptyDb()
  writeDb({ ...db, ...incoming })
  res.json(readDb())
})

app.post('/api/reset', (req, res) => {
  // keepTeams=true behält Teams & Spieler, löscht nur Spiele.
  const keepTeams = req.body && req.body.keepTeams
  if (keepTeams) {
    const db = readDb()
    db.games = []
    writeDb(db)
    return res.json(db)
  }
  const seed = fs.existsSync(SEED_PATH)
    ? JSON.parse(fs.readFileSync(SEED_PATH, 'utf-8'))
    : emptyDb()
  writeDb(seed)
  res.json(readDb())
})

// ---------------------------------------------------------------------------
// Produktionsmodus: gebautes Frontend (dist/, `npm run build`/`npm run serve`)
// als statische Dateien ausliefern, damit die App als EIN Prozess unter EINEM
// Port läuft (kein separater Vite-Dev-Prozess nötig). Rein additiv - im
// Dev-Modus (`npm run dev`) existiert dist/ meist nicht oder ist veraltet;
// dort bedient ohnehin der Vite-Dev-Server (Port 5173) das Frontend und
// proxyt /api/* hierher (vite.config.js, unverändert). Registriert NACH allen
// /api/*-Routen oben, damit diese unverändert Vorrang haben; der
// SPA-Fallback (unbekannte, nicht-/api-Routen -> index.html, für
// React-Router-Deep-Links wie /players/xyz) schliesst /api/* explizit aus,
// damit ein Tippfehler in einer API-Route sauber 404 statt index.html liefert.
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    res.sendFile(path.join(DIST_DIR, 'index.html'))
  })
}

app.listen(PORT, () => {
  ensureDb()
  console.log(`\n  NL Tracker API läuft auf http://localhost:${PORT}`)
  console.log(`  Daten: ${DB_PATH}\n`)

  // Automatischer SIHF-Poll: standardmässig AN (Dauerbetrieb, siehe `npm run
  // serve`/README) - alle 5 Minuten während der Saison. Abschaltbar mit
  // SIHF_AUTO_SYNC=0, Intervall überschreibbar mit SIHF_SYNC_INTERVAL_MIN.
  if (process.env.SIHF_AUTO_SYNC !== '0') {
    const intervalMs = (Number(process.env.SIHF_SYNC_INTERVAL_MIN) || 5) * 60 * 1000
    console.log(`  SIHF-Auto-Sync aktiv (alle ${intervalMs / 60000} Min.)`)
    const poll = () => {
      if (syncRunning) return
      syncRunning = true
      runSihfSync({ write: true, log: (...a) => console.log('[SIHF SYNC]', ...a) })
        .catch((e) => console.error('[SIHF SYNC] Fehler:', e.message))
        .finally(() => { syncRunning = false })
    }
    setInterval(poll, intervalMs)
  }

  // National-League-API-Sync: läuft immer einmal beim Serverstart (fire-and-
  // forget, blockiert den Start nicht). Intervall standardmässig AN
  // (Dauerbetrieb, Default alle 30 Min., NL_SYNC_INTERVAL_MIN überschreibt) -
  // abschaltbar mit NL_AUTO_SYNC=0. Die API cacht ohnehin 10 Min. - häufigeres
  // Pollen bringt nichts (30 Min. respektiert das mit deutlichem Puffer).
  const pollNl = () => {
    if (nlSyncRunning) return
    nlSyncRunning = true
    runNlSync({ write: true, log: (...a) => console.log('[NL SYNC]', ...a) })
      .catch((e) => console.error('[NL SYNC] Fehler:', e.message))
      .finally(() => { nlSyncRunning = false })
  }
  pollNl()

  if (process.env.NL_AUTO_SYNC !== '0') {
    const nlIntervalMs = (Number(process.env.NL_SYNC_INTERVAL_MIN) || DEFAULT_NL_SYNC_INTERVAL_MIN) * 60 * 1000
    console.log(`  NL-Auto-Sync aktiv (alle ${nlIntervalMs / 60000} Min.)`)
    setInterval(pollNl, nlIntervalMs)
  }

  console.log()
})
