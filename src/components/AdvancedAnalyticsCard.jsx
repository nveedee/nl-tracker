import { describeGoalsVsXg } from '../advancedStats.js'

function fmt2(v) { return v == null ? '–' : v.toFixed(2) }
function fmt1(v) { return v == null ? '–' : v.toFixed(1) }
function fmtPct1(v) { return v == null ? '–' : (v * 100).toFixed(1) + '%' }
function fmtSec(v) {
  if (v == null) return '–'
  const t = Math.round(v)
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}
function signed(v) {
  if (v == null) return '–'
  return v > 0 ? `+${v}` : String(v)
}

// Ein kleines Kennzahl-Paar (Label + Wert) für die kompakten Grids unten -
// vermeidet grosse Tabellen (Auftrag: "kein Excel-Gefühl").
function Stat({ label, value, accent }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</div>
      <div className={accent ? 'value accent' : 'value'} style={{ fontSize: 16, fontWeight: 800, fontFamily: 'var(--mono)' }}>{value}</div>
    </div>
  )
}

function SectionLabel({ children, first }) {
  return <div className="section-label" style={{ marginTop: first ? 12 : 16 }}>{children}</div>
}

// Horizontaler, segmentierter Balken für die Ice-Time-Aufteilung (EQ/PP/PK) -
// nur die tatsächlich vorhandenen Segmente werden gezeichnet; fehlt ein
// Segment (kein Wert), wird nichts geraten/aufgefüllt.
function IceTimeBar({ eq, pp, pk }) {
  const total = (eq || 0) + (pp || 0) + (pk || 0)
  if (total <= 0) return null
  const seg = (v, color, label) => v > 0 && (
    <div key={label} title={`${label}: ${fmtSec(v)}`} style={{ width: `${(v / total) * 100}%`, background: color, height: '100%' }} />
  )
  return (
    <div className="row" style={{ height: 10, borderRadius: 999, overflow: 'hidden', background: 'var(--bg-elev-2)', marginTop: 6, marginBottom: 4 }}>
      {seg(eq, 'var(--text-dim)', 'Gleichzahl')}
      {seg(pp, 'var(--good)', 'Powerplay')}
      {seg(pk, 'var(--bad)', 'Unterzahl')}
    </div>
  )
}

// `season` = computeAdvancedStats()-Ergebnis über die gesamte Saison dieses
// Spielers (bereits einmal in PlayerDetail.jsx berechnet/memoiziert, siehe
// Auftrag Punkt 13 - keine erneute Berechnung hier). Rendert NUR
// Teilbereiche, für die tatsächlich Daten vorliegen (leere Bereiche werden
// komplett weggelassen statt einen Block aus "–" zu zeigen).
export default function AdvancedAnalyticsCard({ season }) {
  if (!season) return null

  const hasPerformance = [season.raw.points, season.raw.goals, season.raw.assists].some((v) => v != null)
  const hasXg = season.xg != null
  const hasIceTimeSplit = season.eqToiPerGame != null || season.ppToiPerGame != null || season.pkToiPerGame != null
  const hasSpecialTeams = [season.raw.powerplayGoals, season.raw.powerplayAssists, season.raw.shorthandedGoals, season.raw.shorthandedAssists, season.raw.gameWinningGoals].some((v) => v != null)
  const hasFaceoffs = season.raw.faceoffsTotal != null && season.raw.faceoffsTotal > 0
  const hasDefense = [season.raw.blockedShots, season.raw.plusMinus, season.raw.pim].some((v) => v != null)

  if (!hasPerformance && !hasXg && !hasIceTimeSplit && !hasSpecialTeams && !hasFaceoffs && !hasDefense) return null

  const xgInterpretation = hasXg ? describeGoalsVsXg(season.raw.goals, season.xg) : null

  return (
    <div className="card card-pad mb">
      <h2 className="mb">Advanced Analytics</h2>
      <div className="muted" style={{ fontSize: 11 }}>Basierend auf {season.gp} Spiel{season.gp === 1 ? '' : 'en'} mit National-League-Detaildaten dieser Saison.</div>

      {/* Visuelle Hierarchie (Polish Punkt 5): Performance -> Shooting/xG ->
          Ice Time -> Special Teams -> Faceoffs -> Defensive - reine
          Neugruppierung bereits vorhandener Werte, keine neuen Kennzahlen. */}
      {hasPerformance && (
        <>
          <SectionLabel first>Performance</SectionLabel>
          <div className="grid grid-4" style={{ gap: 10, marginTop: 8 }}>
            <Stat label="Punkte" value={season.raw.points ?? '–'} accent />
            <Stat label="P/GP" value={fmt2(season.pointsPerGame)} />
            <Stat label="Tore/GP" value={fmt2(season.goalsPerGame)} />
            <Stat label="Assists/GP" value={fmt2(season.assistsPerGame)} />
          </div>
        </>
      )}

      {hasXg && (
        <>
          <SectionLabel>Shooting &amp; xG</SectionLabel>
          {/* Begriffsklarheit (Polish Punkt 2): Shot-Events = alle rohen
              Schuss-Versuche (GOAL+SOG+MISS+BLOCK), SOG = tatsächliche Shots
              on Goal INKLUSIVE Tore (verifiziert an echten API-Boxscore-
              Zeilen, siehe Bericht: raw "sog"-Feld = GOAL- + SOG-Typ-Schüsse
              zusammen), Schussquote = Tore / SOG. "Schüsse (Versuche)" hiess
              vorher irreführend ähnlich wie SOG, obwohl es eine andere,
              GRÖSSERE Menge ist (schliesst MISS/BLOCK mit ein). */}
          <div className="grid grid-4" style={{ gap: 10, marginTop: 8 }}>
            <Stat label="Shot-Events" value={season.raw.shotAttempts ?? '–'} />
            <Stat label="SOG" value={season.raw.sog ?? '–'} />
            <Stat label="Tore" value={season.raw.goals ?? '–'} />
            <Stat label="Schussquote" value={fmtPct1(season.shootingPercentage)} accent />
            <Stat label="xG total" value={fmt2(season.xg)} accent />
            <Stat label="xG/GP" value={fmt2(season.xgPerGame)} />
            <Stat label="xG/Schuss" value={fmt2(season.xgPerShot)} />
            <Stat label="Tore − xG" value={season.goalsMinusXg == null ? '–' : (season.goalsMinusXg > 0 ? '+' : '') + season.goalsMinusXg.toFixed(2)} />
          </div>
          {xgInterpretation && <div className="muted mt" style={{ fontSize: 12, fontStyle: 'italic' }}>{xgInterpretation}</div>}
        </>
      )}

      {hasIceTimeSplit && (
        <>
          <SectionLabel>Ice Time</SectionLabel>
          <IceTimeBar eq={season.eqToiPerGame} pp={season.ppToiPerGame} pk={season.pkToiPerGame} />
          <div className="grid grid-4" style={{ gap: 10, marginTop: 8 }}>
            <Stat label="TOI/GP" value={fmtSec(season.toiPerGame)} />
            <Stat label="EQ TOI/GP" value={fmtSec(season.eqToiPerGame)} />
            <Stat label="PP TOI/GP" value={fmtSec(season.ppToiPerGame)} />
            <Stat label="PK TOI/GP" value={fmtSec(season.pkToiPerGame)} />
          </div>
        </>
      )}

      {hasSpecialTeams && (
        <>
          <SectionLabel>Special Teams</SectionLabel>
          <div className="grid grid-2" style={{ gap: 14, marginTop: 8 }}>
            <div>
              <div className="muted" style={{ fontSize: 10.5, fontWeight: 700, marginBottom: 4 }}>POWERPLAY</div>
              <div className="grid grid-3" style={{ gap: 8 }}>
                <Stat label="Tore" value={season.raw.powerplayGoals ?? '–'} />
                <Stat label="Assists" value={season.raw.powerplayAssists ?? '–'} />
                <Stat label="TOI/GP" value={fmtSec(season.ppToiPerGame)} />
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 10.5, fontWeight: 700, marginBottom: 4 }}>UNTERZAHL</div>
              <div className="grid grid-3" style={{ gap: 8 }}>
                <Stat label="Tore" value={season.raw.shorthandedGoals ?? '–'} />
                <Stat label="Assists" value={season.raw.shorthandedAssists ?? '–'} />
                <Stat label="TOI/GP" value={fmtSec(season.pkToiPerGame)} />
              </div>
            </div>
          </div>
          {season.raw.gameWinningGoals != null && (
            <div className="muted mt" style={{ fontSize: 12 }}>Game Winning Goals: <strong style={{ color: 'var(--text)' }}>{season.raw.gameWinningGoals}</strong></div>
          )}
        </>
      )}

      {hasFaceoffs && (
        <>
          <SectionLabel>Faceoffs</SectionLabel>
          <div className="grid grid-4" style={{ gap: 10, marginTop: 8 }}>
            <Stat label="Gewonnen" value={season.raw.faceoffsWon ?? '–'} />
            <Stat label="Verloren" value={season.raw.faceoffsLost ?? '–'} />
            <Stat label="Faceoff-%" value={fmtPct1(season.faceoffPercentage)} accent />
            <Stat label="Bullys/GP" value={fmt1(season.raw.faceoffsTotal / season.gp)} />
          </div>
        </>
      )}

      {hasDefense && (
        <>
          <SectionLabel>Defensive</SectionLabel>
          <div className="grid grid-4" style={{ gap: 10, marginTop: 8 }}>
            <Stat label="Blocked Shots" value={season.raw.blockedShots ?? '–'} />
            <Stat label="Blocks/GP" value={fmt2(season.blockedShotsPerGame)} />
            <Stat label="+/–" value={signed(season.raw.plusMinus)} />
            <Stat label="Strafminuten" value={season.raw.pim ?? '–'} />
          </div>
        </>
      )}
    </div>
  )
}
