// ---------------------------------------------------------------------------
// LIVE-POLLING - eigenständig vom bestehenden 5-Minuten-SIHF-Sync
// (server/scripts/sync-sihf.cjs::runSync, unverändert). Pollt AUSSCHLIESSLICH
// Spiele, deren geplante Startzeit bereits vergangen ist und die lokal noch
// nicht `status: 'final'` sind, in einem deutlich kürzeren Intervall
// (LIVE_POLL_INTERVAL_MS) - ohne das bestehende, für Endresultate zuständige
// Sync-Intervall zu verändern.
//
// Schreibt NIE in game.homeGoals/awayGoals/status/decision - ausschliesslich
// in das separate, additive Feld game.liveState (siehe
// sync-sihf.cjs::parseLiveSnapshot). Das Endergebnis übernimmt weiterhin
// ausschliesslich der bestehende SIHF-Sync.
//
// In-Flight-Lock (`inFlight`-Set): verhindert parallele Requests für
// dasselbe Spiel, falls ein Poll-Tick noch läuft, wenn der nächste fällig
// wäre (z.B. bei einem langsamen/hängenden SIHF-Request).
// ---------------------------------------------------------------------------

import sihfSync from './scripts/sync-sihf.cjs'

// Bewusst NICHT destrukturiert (const { fetchSihfGame } = sihfSync): Tests
// (server/liveSync.test.js) überschreiben sihfSync.fetchSihfGame gezielt mit
// einem Fake, um API-Ausfall/Retry und In-Flight-Verhalten ohne echten
// Netzwerkzugriff zu prüfen - das funktioniert nur, wenn hier bei jedem
// Aufruf über das Objekt (nicht über eine beim Modul-Load eingefrorene
// Kopie) zugegriffen wird.

export const LIVE_POLL_INTERVAL_MS = 20_000 // 20s - deutlich unter dem beobachteten SIHF-Rate-Limit (1200 req/60s, siehe LIVE_PROBABILITY_ANALYSIS.md)
const LIVE_WINDOW_BEFORE_START_MIN = 0 // Polling erst AB der geplanten Startzeit (kein verfrühtes Pollen "geplanter" Spiele)
const LIVE_WINDOW_MAX_HOURS = 5 // Sicherheitsnetz: ein Spiel ohne Endresultat wird nach 5h nicht mehr weiterverfolgt (verhindert endloses Pollen bei z.B. abgesagten/verschobenen Spielen ohne sauberen SIHF-Status)

const inFlight = new Set()

// gameId -> liveState (letzter erfolgreich geparster Snapshot). Rein
// serverseitiger Cache - überlebt keinen Neustart, muss er auch nicht
// (nächster Poll-Tick baut ihn wieder auf).
const cache = new Map()

function isCandidate(game, now) {
  if (!game.sihfGameId || game.status === 'final') return false
  const start = new Date(`${game.date}T${game.time || '00:00'}`)
  if (Number.isNaN(start.getTime())) return false
  const minutesSinceStart = (now - start) / 60000
  return minutesSinceStart >= LIVE_WINDOW_BEFORE_START_MIN && minutesSinceStart <= LIVE_WINDOW_MAX_HOURS * 60
}

async function pollOne(game, { log } = {}) {
  if (inFlight.has(game.id)) return // vorheriger Poll für dieses Spiel läuft noch
  inFlight.add(game.id)
  try {
    const res = await sihfSync.fetchSihfGame(game.sihfGameId, { log })
    if (res.status === 404 || !res.json || !res.json.details) return
    const snapshot = sihfSync.parseLiveSnapshot(res.json)
    if (snapshot.status === 'final') {
      // Endergebnis übernimmt ausschliesslich der bestehende SIHF-Sync -
      // hier nur den Live-Cache räumen, damit der Client sauber auf die
      // finalen db.json-Felder umschwenkt statt einen veralteten
      // Live-Snapshot weiterzuzeigen.
      cache.delete(game.id)
      return
    }
    cache.set(game.id, snapshot)
  } catch (e) {
    log && log(`[LIVE SYNC] ${game.id}: ${e.message}`)
    // Bestehenden Cache-Eintrag (falls vorhanden) NICHT löschen - ein
    // vorübergehender API-Fehler soll den zuletzt bekannten Live-Stand nicht
    // aus der UI verschwinden lassen, siehe Retry/Backoff bereits in
    // fetchSihfGame() (2 Versuche, exponentielles Backoff).
  } finally {
    inFlight.delete(game.id)
  }
}

// Pollt alle aktuell live-relevanten Spiele aus `db.games` parallel (je
// eigenem In-Flight-Lock) - ein einzelnes fehlschlagendes Spiel blockiert die
// anderen nicht (siehe try/catch in pollOne).
export async function pollLiveGames(db, { log, now = new Date() } = {}) {
  const candidates = db.games.filter((g) => isCandidate(g, now))
  await Promise.all(candidates.map((g) => pollOne(g, { log })))
  return { polled: candidates.length, live: [...cache.keys()] }
}

export function getLiveState(gameId) {
  return cache.get(gameId) || null
}

// Alle aktuell im Cache gehaltenen Live-Snapshots (vom Hintergrund-Poller
// oben befüllt, siehe pollLiveGames()) - für GET /api/live-games
// (server/index.js): EIN zentraler Request fürs Dashboard statt eines
// eigenen Live-Polls pro Spiel. Löst selbst KEINEN zusätzlichen SIHF-Request
// aus, liest nur den bestehenden Cache.
export function getAllLiveStates() {
  return [...cache.entries()].map(([gameId, state]) => ({ gameId, ...state }))
}

// Für den GET-Endpoint (server/index.js): liefert den Cache, falls er noch
// frisch genug ist (< maxAgeMs), sonst wird EIN gezielter Fetch für genau
// dieses Spiel angestossen (respektiert denselben In-Flight-Lock wie der
// Hintergrund-Poller - kein doppelter Request, falls der Hintergrund-Poller
// gerade ohnehin schon pollt) und danach der (dann aktuelle oder weiterhin
// alte, falls der Fetch fehlschlug) Cache-Stand zurückgegeben.
export async function ensureFreshLiveState(game, { log, maxAgeMs = 15_000, now = new Date() } = {}) {
  const cached = cache.get(game.id)
  if (cached && now - new Date(cached.updatedAt) < maxAgeMs) return cached
  if (!isCandidate(game, now)) return cached || null
  await pollOne(game, { log })
  return cache.get(game.id) || null
}

// Nur für Tests: Cache/Locks zwischen Testfällen zurücksetzen.
export function _resetForTests() {
  cache.clear()
  inFlight.clear()
}
