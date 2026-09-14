import { useState, useMemo } from 'react'
import { SectionHeader } from './ui.jsx'
import PositionMatrix from './PositionMatrix.jsx'
import BracketCards from './BracketCards.jsx'
import { filterLockedRuns, LOCK_MIN_SAMPLE, LOCK_BRACKET_KINDS } from '../playoffSim.js'

const RANKS = Array.from({ length: 14 }, (_, i) => i + 1)

function lockLabel(lock, teamsById) {
  const teamName = teamsById.get(lock.teamId)?.short || lock.teamId
  if (lock.kind === 'rank') return `${teamName}: Rang ${lock.rank}`
  const kindLabel = LOCK_BRACKET_KINDS.find((k) => k.key === lock.kind)?.label || lock.kind
  return `${teamName}: ${kindLabel}`
}

// Pinnt Teams auf einen Endrang oder Bracket-Ausgang und filtert die BEREITS
// GELAUFENEN Läufe (baseResults.raw, src/playoffSim.js::filterLockedRuns())
// auf die Teilmenge, die alle Vorgaben erfüllt - reines Nachrechnen, KEINE
// neue Simulation. Läuft daher live bei jeder Änderung (kein "Anwenden"-Klick
// nötig), im Gegensatz zum What-if-Simulator.
export default function LockStandings({ teams, baseResults }) {
  const [locks, setLocks] = useState([])
  const [formTeamId, setFormTeamId] = useState(teams[0]?.id)
  const [formKind, setFormKind] = useState('rank')
  const [formRank, setFormRank] = useState(1)

  const teamsById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams])

  const addLock = () => {
    const kind = formKind
    const newLock = kind === 'rank' ? { teamId: formTeamId, kind, rank: Number(formRank) } : { teamId: formTeamId, kind }
    // Duplikat (gleiches Team, gleiche Art) ersetzen statt zu verdoppeln
    setLocks((prev) => [...prev.filter((l) => !(l.teamId === newLock.teamId && l.kind === newLock.kind)), newLock])
  }
  const removeLock = (idx) => setLocks((prev) => prev.filter((_, i) => i !== idx))

  const locked = useMemo(() => (locks.length ? filterLockedRuns(baseResults, locks) : null), [baseResults, locks])

  return (
    <div className="card mb">
      <div className="card-pad" style={{ paddingBottom: 10 }}>
        <SectionHeader
          title="Lock Final Standings"
          caption={`Bedingte Wahrscheinlichkeiten ohne Neuberechnung - filtert die ${baseResults.runs.toLocaleString('de-CH')} bereits gelaufenen Läufe.`}
        />

        <div className="row gap-sm wrap" style={{ marginTop: 10, alignItems: 'center' }}>
          <select value={formTeamId} onChange={(e) => setFormTeamId(e.target.value)} style={{ width: 'auto', minHeight: 40 }}>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select value={formKind} onChange={(e) => setFormKind(e.target.value)} style={{ width: 'auto', minHeight: 40 }}>
            <option value="rank">Endrang</option>
            {LOCK_BRACKET_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
          {formKind === 'rank' && (
            <select value={formRank} onChange={(e) => setFormRank(e.target.value)} style={{ width: 'auto', minHeight: 40 }}>
              {RANKS.map((r) => <option key={r} value={r}>Rang {r}</option>)}
            </select>
          )}
          <button className="btn ghost sm" onClick={addLock} style={{ minHeight: 40 }}>Pin hinzufügen</button>
        </div>

        {locks.length > 0 && (
          <div className="row gap-sm wrap" style={{ marginTop: 10 }}>
            {locks.map((lock, i) => (
              <span key={i} className="chip">
                {lockLabel(lock, teamsById)}
                <button className="btn ghost sm" style={{ padding: '0 4px', marginLeft: 2 }} onClick={() => removeLock(i)}>×</button>
              </span>
            ))}
            <button className="btn ghost sm" onClick={() => setLocks([])}>Alle entfernen</button>
          </div>
        )}
      </div>

      {locked && (
        <div className="card-pad" style={{ paddingTop: 0 }}>
          {locked.matchingRuns === 0 ? (
            <div className="chip">0 von {locked.totalRuns.toLocaleString('de-CH')} Läufen erfüllen alle Bedingungen gleichzeitig - unmöglich/widersprüchlich.</div>
          ) : (
            <>
              <div className="row gap-sm wrap" style={{ marginBottom: 12 }}>
                <div className="chip">
                  {locked.matchingRuns.toLocaleString('de-CH')} von {locked.totalRuns.toLocaleString('de-CH')} Läufen erfüllen alle Bedingungen
                  {' '}({(locked.matchingRuns / locked.totalRuns * 100).toFixed(1)}%)
                </div>
                {!locked.sufficientSample && (
                  <div className="chip" style={{ color: 'var(--bad)', borderColor: 'var(--bad)' }}>
                    Zu selten für stabile Aussage (&lt;{LOCK_MIN_SAMPLE} Läufe)
                  </div>
                )}
              </div>
              <BracketCards rows={locked.rows} />
              <PositionMatrix rows={locked.rows} runs={locked.runs} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
