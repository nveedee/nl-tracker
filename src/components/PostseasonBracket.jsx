import { SectionHeader, TeamBadge } from './ui.jsx'

function fmtPct(v) {
  if (v == null) return '–'
  const pct = v * 100
  if (pct > 0 && pct < 1) return pct.toFixed(1) + '%'
  return Math.round(pct) + '%'
}

function BracketRow({ teamAId, teamBId, winnerId, teamById, gamesPlayed }) {
  return (
    <div className="row spread postseason-bracket-row">
      <div className="row gap-sm" style={{ flex: 1 }}>
        <span style={teamAId === winnerId ? { fontWeight: 700 } : undefined}><TeamBadge team={teamById.get(teamAId)} short /></span>
        <span className="muted" style={{ fontSize: 11 }}>vs</span>
        <span style={teamBId === winnerId ? { fontWeight: 700 } : undefined}><TeamBadge team={teamById.get(teamBId)} short /></span>
      </div>
      <span className="muted" style={{ fontSize: 11.5, flex: 'none' }}>
        {gamesPlayed ? `${gamesPlayed} Spiele · ` : ''}Sieger: <TeamBadge team={teamById.get(winnerId)} short link={false} />
      </span>
    </div>
  )
}

// "Most Likely Bracket" (Punkt 14 im Auftrag, korrigiert): der exakt
// vollständige Bracket-Verlauf (Play-in + QF + SF + Final, jeweils inkl.
// Sieger), der unter allen Simulationsläufen am häufigsten IDENTISCH auftrat
// (siehe bracketFromRun()/mostLikelyBracket in src/postseasonPaths.js).
// Bewusst NICHT aus den häufigsten Einzelgegnern pro Team kombiniert - das
// garantiert per Konstruktion, dass jedes Team pro Runde nur einmal
// vorkommt, keine Paarung doppelt auftritt und der gesamte Bracket
// tatsächlich in genau dieser Form simuliert wurde.
export default function PostseasonBracket({ aggregate, teamById }) {
  if (!aggregate?.mostLikelyBracket) return null
  const b = aggregate.mostLikelyBracket

  return (
    <>
      <SectionHeader
        title="Most Likely Bracket"
        caption="Der am häufigsten beobachtete vollständige Bracket-Verlauf in den 10'000 Simulationen - keine aus Einzelgegnern kombinierte Paarung."
      />
      <div className="card card-pad mb">
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
          {b.count.toLocaleString('de-CH')} von {aggregate.runs.toLocaleString('de-CH')} Simulationen · <strong>{fmtPct(b.probability)}</strong>
          {aggregate.distinctBracketCount > 1 && ` · ${aggregate.distinctBracketCount.toLocaleString('de-CH')} unterschiedliche Brackets beobachtet`}
        </div>

        <div className="section-label">Play-in</div>
        <div className="postseason-bracket-group">
          <BracketRow teamAId={b.playIn.gameA.teamAId} teamBId={b.playIn.gameA.teamBId} winnerId={b.playIn.gameA.winnerId} teamById={teamById} />
          <BracketRow teamAId={b.playIn.gameB.teamAId} teamBId={b.playIn.gameB.teamBId} winnerId={b.playIn.gameB.winnerId} teamById={teamById} />
          <BracketRow teamAId={b.playIn.decision.teamAId} teamBId={b.playIn.decision.teamBId} winnerId={b.playIn.decision.winnerId} teamById={teamById} />
        </div>

        <div className="section-label" style={{ marginTop: 16 }}>Viertelfinal</div>
        <div className="postseason-bracket-group">
          {b.quarterfinal.map((s, i) => (
            <BracketRow key={i} teamAId={s.teamAId} teamBId={s.teamBId} winnerId={s.winnerId} gamesPlayed={s.gamesPlayed} teamById={teamById} />
          ))}
        </div>

        <div className="section-label" style={{ marginTop: 16 }}>Halbfinal</div>
        <div className="postseason-bracket-group">
          {b.semifinal.map((s, i) => (
            <BracketRow key={i} teamAId={s.teamAId} teamBId={s.teamBId} winnerId={s.winnerId} gamesPlayed={s.gamesPlayed} teamById={teamById} />
          ))}
        </div>

        <div className="section-label" style={{ marginTop: 16 }}>Final</div>
        <div className="postseason-bracket-group">
          <BracketRow teamAId={b.final.teamAId} teamBId={b.final.teamBId} winnerId={b.final.winnerId} gamesPlayed={b.final.gamesPlayed} teamById={teamById} />
        </div>

        <div className="row gap-sm" style={{ marginTop: 16, alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 12 }}>Meister in diesem Bracket:</span>
          <strong><TeamBadge team={teamById.get(b.champion)} /></strong>
        </div>
      </div>
    </>
  )
}
