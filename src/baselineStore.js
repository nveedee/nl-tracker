// ---------------------------------------------------------------------------
// Baseline-Historie der Season-Projections-Wahrscheinlichkeiten, persistiert
// in localStorage (rein clientseitig - kein Backend-Roundtrip nötig, ein
// Snapshot ist < 2 KB). Eine Baseline pro Kalendertag ("Spieltag"): der
// ERSTE Simulationslauf eines Tages wird fix gespeichert und danach nicht
// mehr überschrieben, auch wenn am selben Tag mehrfach neu simuliert wird
// (z.B. nachdem Resultate von heute erfasst wurden).
//
// "Letzte Baseline" = der zuletzt gespeicherte Snapshot, unabhängig davon ob
// er von heute oder einem früheren Tag stammt:
//   - Erster Lauf eines NEUEN Tages -> Delta zeigt die Bewegung SEIT GESTERN
//     (die letzte Baseline ist noch die von gestern, da die heutige erst
//     danach gespeichert wird).
//   - Jeder weitere Lauf am selben Tag -> Delta zeigt die Bewegung SEIT
//     HEUTE FRÜH (die heutige Baseline wurde bereits beim ersten Lauf fixiert).
// So ergibt sich ohne Sonderfälle sowohl eine Tag-für-Tag- als auch eine
// Intraday-Bewegungsanzeige aus derselben, simplen Regel.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'nl-tracker:playoff-baselines'
const MAX_BASELINES = 90 // ~3 Saison-Monate tägliche Historie, verhindert unbegrenztes Wachstum

const BASELINE_FIELDS = [
  'pPlayoffs', 'pTop6', 'pPlayIn', 'pChampion', 'pPlayout1314', 'pLigaQualifikation', 'avgRank',
]

function todayKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function loadBaselines() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return [] // localStorage nicht verfügbar/blockiert (privater Modus etc.) - Feature einfach ohne Baseline
  }
}

function saveBaselines(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_BASELINES)))
  } catch {
    // Speicher voll o.ä. - Baseline-Feature ist rein additiv, nie kritisch für die Simulation selbst
  }
}

// Nur die für Delta-Anzeige/Riser-Faller benötigten Felder - kein Dump der
// kompletten Simulation (keine typed arrays, keine Rangverteilung/Bracket-Details).
function toBaselineRow(row) {
  const out = { teamId: row.team.id }
  for (const f of BASELINE_FIELDS) out[f] = row[f]
  return out
}

// Baut aus einem beliebigen simulateSeasonProjections()-Ergebnis ein Objekt
// in genau der Form, die getBaselineRow()/deltaPp() erwarten (`{ rows }`).
// Ermöglicht, BracketCards/PositionMatrix nicht nur gegen die persistierte
// Tages-Baseline, sondern auch gegen z.B. die aktuelle unbedingte Projektion
// zu vergleichen (WHAT-IF-SIMULATOR: Delta ggü. der Projektion OHNE
// Overrides, nicht ggü. der Tages-Baseline) - ohne eigene Persistierung.
export function toComparisonSnapshot(simResult, label) {
  if (!simResult) return null
  return { date: label, rows: simResult.rows.map(toBaselineRow) }
}

// Gibt den zuletzt gespeicherten Snapshot zurück (siehe Kommentar oben) -
// oder null, wenn es noch nie eine Baseline gab.
export function getLastBaseline() {
  const list = loadBaselines()
  return list.length ? list[list.length - 1] : null
}

// Die VOLLSTÄNDIGE Historie (ein Snapshot pro Spieltag), chronologisch
// aufsteigend sortiert - für SEASON-EVOLUTION (Liniendiagramm über die
// Spieltage). Baut sich ausschliesslich vorwärts auf: die Historie beginnt
// mit dem ersten Tag, an dem dieses Feature genutzt wurde - keine
// rückwirkenden Daten, siehe Hinweis in SeasonEvolution.jsx.
export function getBaselineHistory() {
  return loadBaselines().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

// Speichert den aktuellen Simulationslauf als Baseline für HEUTE, aber nur
// wenn für heute noch keine existiert (die Tagesbaseline bleibt sonst fix).
// Aufrufreihenfolge in der UI: erst getLastBaseline() für die Delta-Anzeige
// abfragen, DANACH recordBaselineIfNeeded() - siehe Kommentar oben.
export function recordBaselineIfNeeded(simResult) {
  const key = todayKey()
  const list = loadBaselines()
  if (list.some((b) => b.date === key)) return false
  list.push({
    date: key,
    createdAt: new Date().toISOString(),
    runs: simResult.runs,
    seed: simResult.seed,
    rows: simResult.rows.map(toBaselineRow),
  })
  saveBaselines(list)
  return true
}

export function getBaselineRow(baseline, teamId) {
  if (!baseline) return null
  return baseline.rows.find((r) => r.teamId === teamId) || null
}

// Delta (in Prozentpunkten, bereits *100) für ein Feld zwischen aktueller
// Simulation und der letzten Baseline. null, wenn keine Baseline vorliegt
// oder das Team darin fehlt (z.B. neu ins Team-Datenmodell aufgenommen).
export function deltaPp(currentValue, baselineRow, field) {
  if (!baselineRow || baselineRow[field] == null) return null
  return (currentValue - baselineRow[field]) * 100
}

// "Was hat sich bewegt": grösste Riser/Faller nach Delta in P(Playoffs) - der
// am ehesten pro Team eindeutig interpretierbare Einzelwert (im Gegensatz zu
// z.B. P(Ligaqualifikation), wo "gestiegen" eine schlechte statt guten
// Nachricht ist - Playoff-Chance ist für jedes Team gleich gerichtet: mehr
// ist immer eine bessere Ausgangslage). Andere Metriken bleiben über die
// Delta-Spalten der Bracket-Karten einsehbar.
export function computeMovers(rows, baseline, limit = 5) {
  if (!baseline) return { risers: [], fallers: [] }
  const withDelta = rows
    .map((row) => ({ row, delta: deltaPp(row.pPlayoffs, getBaselineRow(baseline, row.team.id), 'pPlayoffs') }))
    .filter((x) => x.delta != null && Math.abs(x.delta) > 0.05) // Rauschgrenze: <0.05pp nicht als "Bewegung" werten
    .sort((a, b) => b.delta - a.delta)

  return {
    risers: withDelta.slice(0, limit),
    fallers: withDelta.slice(-limit).reverse().filter((x) => x.delta < 0),
  }
}
