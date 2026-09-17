import { useState } from 'react'
import { TeamBadge, SectionHeader, ProbBar, Tabs } from './ui.jsx'
import { matchupKey } from '../postseasonPaths.js'

const TABS = [
  { key: 'quarterfinal', label: 'Viertelfinal' },
  { key: 'semifinal', label: 'Halbfinal' },
  { key: 'final', label: 'Final' },
  { key: 'playout', label: 'Play-out' },
]

const INITIAL_COUNT = 8

function fmtPct(v) {
  if (v == null) return '–'
  const pct = v * 100
  if (pct > 0 && pct < 1) return pct.toFixed(1) + '%'
  return Math.round(pct) + '%'
}

// Globale "Most Likely Matchups" (Punkt 7/15 im Auftrag) - wie oft entstand
// diese KONKRETE Paarung (unabhängig von Heim/Auswärts, A-vs-B == B-vs-A)
// über alle 10'000 Simulationsläufe, plus die Serienlängen-Verteilung dieser
// Paarung in derselben Runde. Reines Durchreichen von aggregate.globalMatchups/
// aggregate.seriesLength (src/postseasonPaths.js) - keine eigene Berechnung.
export default function PostseasonMatchups({ aggregate, teamById }) {
  const [tab, setTab] = useState('quarterfinal')
  const [expanded, setExpanded] = useState(false)
  if (!aggregate) return null

  const matchups = aggregate.globalMatchups[tab]
  const lengthByKey = new Map(aggregate.seriesLength[tab].map((e) => [e.key || matchupKey(e.teamAId, e.teamBId), e]))
  const visible = expanded ? matchups : matchups.slice(0, INITIAL_COUNT)

  return (
    <>
      <SectionHeader title="Most Likely Matchups" caption="Wie oft entstand diese konkrete Paarung über alle Simulationsläufe - nicht aus Einzelwahrscheinlichkeiten kombiniert." />
      <div className="card mb">
        <div style={{ padding: '10px 16px 0' }}><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>
        <div className="card-pad">
          {visible.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>Keine Daten für diese Runde.</div>}
          {visible.map((m) => {
            const lengths = lengthByKey.get(m.key)
            return (
              <div key={m.key} style={{ padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                <div className="row" style={{ gap: 10 }}>
                  <div style={{ width: 78, flex: 'none' }}><TeamBadge team={teamById.get(m.teamAId)} short /></div>
                  <span className="muted" style={{ fontSize: 11, flex: 'none' }}>vs</span>
                  <div style={{ width: 78, flex: 'none' }}><TeamBadge team={teamById.get(m.teamBId)} short /></div>
                  <div style={{ flex: 1 }}><ProbBar value={m.probability} /></div>
                </div>
                {lengths && lengths.total > 0 && tab !== 'playIn' && (
                  <div className="row gap-sm" style={{ marginTop: 4, marginLeft: 88 }}>
                    {[4, 5, 6, 7].map((g) => (
                      <span key={g} className="muted" style={{ fontSize: 10.5 }}>
                        {g}: {Math.round(lengths.probabilities[g] * 100)}%
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {!expanded && matchups.length > INITIAL_COUNT && (
            <button className="expander-trigger" onClick={() => setExpanded(true)}>Alle {matchups.length} Paarungen anzeigen</button>
          )}
        </div>
      </div>
    </>
  )
}
