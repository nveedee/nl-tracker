// ---------------------------------------------------------------------------
// Linienaufstellungen (SIHF raw.lineUps, serverseitig aufgelöst - siehe
// sync-sihf.cjs::parseLineups). Rein präsentational. Zeigt AUSSCHLIESSLICH die
// von SIHF gelieferte Positionsgruppierung (Torhüter / Verteidigung / Sturm) -
// KEINE erfundenen Sturmlinien, Verteidigungspaare oder Powerplay-Formationen
// und keine Ableitung aus Torschützen/Eiszeiten. Fehlen die Daten (`lineups`
// null/leer), erscheint ein sauberer Hinweis statt einer leeren Fläche.
// ---------------------------------------------------------------------------

// Reihenfolge der Kürzel-Badges aus SIHF taggedPlayers (C = Captain,
// A = Assistent, 1st = 1. Torhüter, PF-TS = PostFinance Top Scorer).
function PlayerRow({ p }) {
  return (
    <div className="lineup-player">
      <span className="lineup-number">{p.number != null ? p.number : '–'}</span>
      <span className="lineup-name">{p.name || 'Unbekannt'}</span>
      {(p.tags || []).map((t) => (
        <span key={t} className="lineup-tag">{t}</span>
      ))}
    </div>
  )
}

function Group({ label, players }) {
  if (!players || players.length === 0) return null
  return (
    <div className="lineup-group">
      <div className="lineup-group-label">{label}</div>
      {players.map((p) => <PlayerRow key={p.id} p={p} />)}
    </div>
  )
}

function TeamColumn({ team, lineup }) {
  return (
    <div>
      <div className="row gap-sm" style={{ alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontWeight: 800, color: team.color }}>{team.short}</span>
        {lineup?.coach && <span className="muted" style={{ fontSize: 11.5 }}>Coach: {lineup.coach}</span>}
      </div>
      {!lineup ? (
        <div className="muted" style={{ fontSize: 12.5 }}>Keine Aufstellung</div>
      ) : (
        <>
          <Group label="Torhüter" players={lineup.goalkeepers} />
          <Group label="Verteidigung" players={lineup.defenders} />
          <Group label="Sturm" players={lineup.forwards} />
          <Group label="Weitere" players={lineup.others} />
        </>
      )}
    </div>
  )
}

export default function LineupBoard({ homeTeam, awayTeam, lineups, sourceLabel }) {
  const hasData = lineups && (lineups.home || lineups.away)
  return (
    <div className="card card-pad live-section">
      <div className="row spread live-section-head">
        <h2 style={{ fontSize: 13 }}>Aufstellungen</h2>
        {sourceLabel && <span className="chip" style={{ color: 'var(--text-dim)', fontSize: 10 }}>{sourceLabel}</span>}
      </div>
      {!hasData ? (
        <div className="muted" style={{ fontSize: 13 }}>Linienaufstellungen derzeit nicht verfügbar.</div>
      ) : (
        <>
          <div className="grid grid-2">
            <TeamColumn team={homeTeam} lineup={lineups.home} />
            <TeamColumn team={awayTeam} lineup={lineups.away} />
          </div>
          <div className="muted" style={{ fontSize: 10.5, marginTop: 10 }}>
            Gruppierung nach Position wie von der Datenquelle geliefert – keine Linien-/Paar-/Powerplay-Zuordnung.
          </div>
        </>
      )}
    </div>
  )
}
