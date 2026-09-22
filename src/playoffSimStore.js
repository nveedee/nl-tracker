// ---------------------------------------------------------------------------
// Persistiert das ZULETZT abgeschlossene Season-Projections-Simulationsergebnis
// (src/playoffSim.js::simulatePlayoffOdds) in localStorage, damit /playoff-odds
// nach einem Reload/Seitenwechsel sofort wieder etwas anzeigt statt automatisch
// 10'000 Läufe neu zu rechnen - nur der bestehende "Simulation starten/
// aktualisieren"-Button in PlayoffOdds.jsx löst noch einen echten Lauf aus.
//
// Es wird bewusst NUR `rows` + die skalaren Kennzahlen gespeichert, NICHT
// `raw`/`postseasonRaw` (die Uint8/16Array-Rohdaten aller 10'000 Einzelläufe -
// mehrere MB, würde das localStorage-Kontingent sprengen bzw. bei jedem Lauf
// unnötig lange JSON.stringify/parse-Zeit kosten). LockStandings.jsx und
// PointsTargets.jsx degradieren dafür bereits von sich aus sauber
// (`if (!simResult?.raw) return []`/`return null`, siehe playoffSim.js), zeigen
// nach einem Reload also "keine Daten" bis zum nächsten echten Simulationslauf -
// alle anderen Tabs (Matrix/Brackets/What-if/Swing/Verlauf) laufen sofort mit
// dem wiederhergestellten Ergebnis weiter, kein bestehendes Feature bricht.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'nl-tracker:playoff-sim-result'
const STORAGE_VERSION = 1

// row.team ist das volle Team-Objekt aus data.teams - nicht separat
// gespeichert, sondern beim Laden anhand der teamId gegen die AKTUELLEN
// Teams aufgelöst (hydrateRows), falls sich z.B. Team-Metadaten geändert haben.
function toStoredRow(row) {
  const { team, ...rest } = row
  return { teamId: team.id, ...rest }
}

function hydrateRows(storedRows, teams) {
  const byId = Object.fromEntries(teams.map((t) => [t.id, t]))
  const out = []
  for (const row of storedRows) {
    const team = byId[row.teamId]
    if (!team) return null // Team seit dem gespeicherten Lauf entfernt/umbenannt - lieber komplett verwerfen als eine unvollständige Tabelle zeigen
    const { teamId, ...rest } = row
    out.push({ ...rest, team })
  }
  return out
}

// season/teamCount dienen als einfache Versionierung des Datensatzes: ändert
// sich die Saison oder die Anzahl Teams, gilt die gespeicherte Simulation als
// nicht mehr kompatibel (siehe loadSimResult) - unabhängig davon, ob während
// der Saison Spiele fertig werden (das macht eine Simulation "veraltet",
// aber nicht "inkompatibel" - dafür existiert bewusst weiterhin nur der
// manuelle "Neu simulieren"-Button, keine automatische Invalidierung).
export function saveSimResult(simResult, { season, teamCount }) {
  try {
    const payload = {
      version: STORAGE_VERSION,
      season,
      teamCount,
      generatedAt: new Date().toISOString(),
      runs: simResult.runs,
      seed: simResult.seed,
      scheduledCount: simResult.scheduledCount,
      leagueGPG: simResult.leagueGPG,
      homeAdvantage: simResult.homeAdvantage,
      otRate: simResult.otRate,
      bracketSimulated: simResult.bracketSimulated,
      metadata: simResult.metadata,
      rows: simResult.rows.map(toStoredRow),
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // localStorage voll/blockiert (privater Modus, Quota) - rein additives
    // Feature, darf die Simulation selbst nie stören
  }
}

// null = nichts gespeichert, JSON beschädigt, oder Season/Teamanzahl passt
// nicht mehr zum aktuellen Datenstand -> Aufrufer zeigt "neue Simulation
// nötig" an, startet aber NIE automatisch selbst einen Lauf.
export function loadSimResult({ season, teams }) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.version !== STORAGE_VERSION) return null
    if (parsed.season !== season || parsed.teamCount !== teams.length) return null
    if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) return null

    const rows = hydrateRows(parsed.rows, teams)
    if (!rows) return null

    return {
      runs: parsed.runs,
      seed: parsed.seed,
      scheduledCount: parsed.scheduledCount,
      teamCount: parsed.teamCount,
      leagueGPG: parsed.leagueGPG,
      homeAdvantage: parsed.homeAdvantage,
      otRate: parsed.otRate,
      bracketSimulated: parsed.bracketSimulated,
      metadata: parsed.metadata,
      rows,
      raw: null,
      postseasonRaw: null,
      generatedAt: parsed.generatedAt,
    }
  } catch {
    return null // beschädigtes JSON o.ä. - darf die App nie crashen lassen
  }
}
