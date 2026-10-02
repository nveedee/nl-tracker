import { useData } from '../DataContext.jsx'
import { TeamBadge, useScrollFade } from '../components/ui.jsx'
import { PLAYOFF_FORMAT } from '../playoffSim.js'
import { isFinalGame } from '../stats.js'

// Zonen rein aus der bestehenden PLAYOFF_FORMAT-Konstante abgeleitet - keine
// neue/geänderte Logik, nur Darstellung (dezente Hintergrundtönung + Label).
const ZONES = [
  { key: 'qf', range: PLAYOFF_FORMAT.directQuarterfinal, label: 'Viertelfinale', hint: 'direkt qualifiziert', color: 'var(--good)' },
  { key: 'pi', range: PLAYOFF_FORMAT.playIn, label: 'Play-in', hint: 'Sieger erreichen das Viertelfinale', color: 'var(--warn)' },
  { key: 'end', range: PLAYOFF_FORMAT.seasonEnd, label: 'Saisonende', hint: 'weder Playoffs noch Play-out', color: null },
  { key: 'po', range: PLAYOFF_FORMAT.playout, label: 'Play-out', hint: 'Verlierer des Finals: Ligaqualifikation', color: 'var(--bad)' },
]

const zoneOf = (rank) => ZONES.find((z) => rank >= z.range[0] && rank <= z.range[1]) || null
// Deckende (nicht transparente) Tönung: die erste Spalte ist auf Mobile
// "sticky" und darf darunter scrollenden Inhalt nicht durchscheinen lassen.
const tint = (zone) => (zone?.color ? `color-mix(in srgb, ${zone.color} 7%, var(--bg-elev))` : undefined)

const COLS = [
  { label: 'Sp', title: 'Spiele' },
  { label: 'S', title: 'Siege nach 60 Minuten (3 Punkte)' },
  { label: 'OTS', title: 'Siege nach Verlängerung/Penaltyschiessen (2 Punkte)' },
  { label: 'OTN', title: 'Niederlagen nach Verlängerung/Penaltyschiessen (1 Punkt)' },
  { label: 'N', title: 'Niederlagen nach 60 Minuten (0 Punkte)' },
  { label: 'TF', title: 'Tore für' },
  { label: 'TG', title: 'Tore gegen' },
  { label: 'TD', title: 'Tordifferenz (Tore für minus Tore gegen)' },
  { label: 'Pkt', title: 'Punkte' },
]

export default function Standings() {
  const { data, derived } = useData()
  const rows = derived.standings
  const wrapRef = useScrollFade()
  const played = data.games.filter(isFinalGame).length
  const open = data.games.filter((g) => g.status === 'scheduled').length

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Tabelle</h1>
          <div className="sub">
            Aktueller Stand · {played} Spiele gespielt · {open} offen
          </div>
          <div className="sub">Punkte: Sieg 3 · OT/PS-Sieg 2 · OT/PS-Niederlage 1 · Niederlage 0</div>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 8, marginBottom: 10, fontSize: 12.5 }} aria-label="Playoff-Rennen: Zonen der Tabelle">
        <span className="muted" style={{ fontWeight: 600 }}>Playoff-Rennen:</span>
        {ZONES.map((z) => (
          <span key={z.key} className="chip" title={z.hint} style={{ borderLeft: `3px solid ${z.color || 'var(--border-strong)'}` }}>
            <strong>{z.range[0]}–{z.range[1]}</strong> {z.label}
          </span>
        ))}
      </div>

      <div className="card">
        <div className="table-wrap pin-first" ref={wrapRef}>
          <table>
            <thead>
              <tr>
                <th className="left">Team</th>
                {COLS.map((c) => (
                  <th key={c.label} className="num" title={c.title} style={c.label === 'Pkt' ? { fontWeight: 800 } : undefined}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const rank = i + 1
                const zone = zoneOf(rank)
                const startsZone = zone && rank === zone.range[0]
                const bg = tint(zone)
                const cell = bg ? { background: bg } : undefined
                return [
                  startsZone && (
                    <tr key={`z-${zone.key}`} className="zone-label-row">
                      <td colSpan={COLS.length + 1} className="left" style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-dim)', padding: '8px 12px 4px', background: 'var(--bg-elev)' }}>
                        {zone.label} <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>· Rang {zone.range[0]}–{zone.range[1]} · {zone.hint}</span>
                      </td>
                    </tr>
                  ),
                  <tr key={r.team.id}>
                    <td className="left" style={{ ...cell, boxShadow: zone?.color ? `inset 3px 0 0 ${zone.color}` : undefined }}>
                      <span
                        className="rank"
                        style={{ display: 'inline-block', minWidth: 22, textAlign: 'center', marginRight: 10, fontSize: rank <= 3 ? 15 : undefined, fontWeight: rank <= 3 ? 800 : 600, color: rank <= 3 ? 'var(--text)' : undefined }}
                      >{rank}</span>
                      <TeamBadge team={r.team} short />
                    </td>
                    <td className="num" style={cell}>{r.gp}</td>
                    <td className="num" style={cell}>{r.w}</td>
                    <td className="num" style={cell}>{r.otw}</td>
                    <td className="num" style={cell}>{r.otl}</td>
                    <td className="num" style={cell}>{r.l}</td>
                    <td className="num" style={cell}>{r.gf}</td>
                    <td className="num" style={cell}>{r.ga}</td>
                    <td className="num" style={{ ...cell, fontWeight: 700, color: r.gd > 0 ? 'var(--good)' : r.gd < 0 ? 'var(--bad)' : 'inherit' }}>
                      {r.gd > 0 ? '+' + r.gd : r.gd}
                    </td>
                    <td className="num" style={{ ...cell, fontSize: 16, fontWeight: 800 }}>{r.pts}</td>
                  </tr>,
                ]
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>
        <strong>Sp</strong> Spiele · <strong>S</strong> Sieg · <strong>OTS</strong> Sieg n.V./PS · <strong>OTN</strong> Niederlage n.V./PS · <strong>N</strong> Niederlage · <strong>TF</strong> Tore für · <strong>TG</strong> Tore gegen · <strong>TD</strong> Tordifferenz · <strong>Pkt</strong> Punkte
      </div>
      {data.games.length === 0 && <p className="muted mt">Noch keine Spiele erfasst – die Tabelle füllt sich automatisch.</p>}
    </>
  )
}
