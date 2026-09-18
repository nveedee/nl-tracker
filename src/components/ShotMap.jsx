import { useMemo, useState } from 'react'
import { SHOT_MAP_X_MAX, SHOT_MAP_Y_MAX, isValidShotCoordinate } from '../advancedStats.js'

// ---------------------------------------------------------------------------
// FESTE Koordinatentransformation (Auftrag Punkt 1/2 - siehe Bericht):
//
//   x (roh, 0-30) = seitliche Position über die Eisbreite. 30 deckt sich
//     exakt mit der offiziellen Eisbreite (30m) eines Schweizer/
//     europäischen Rinks - X ist mit hoher Sicherheit eine echte
//     Meterangabe, nicht willkürlich skaliert.
//   y (roh, 0-24) = Tiefe ab der Torlinie in Richtung Angriffszone. Anhand
//     von 40+ echten Torereignissen aus mehreren abgeschlossenen Spielen:
//     Tore liegen bei y meist zwischen 4 und 17 (nahe der Torlinie),
//     NIE nahe y=24 - das bestätigt y=0 = an/nahe der Torlinie, y=24 = Rand
//     des erfassten Bereichs (ungefähr Höhe der blauen Linie).
//
// Es wird NICHT dynamisch auf die Wertespanne des jeweiligen Spielers
// skaliert (das war der Fehler der alten Implementierung - 4 Schüsse aus
// derselben kleinen Zone würden sonst über die ganze Karte gespreizt). Die
// Grenzen [0, SHOT_MAP_X_MAX] x [0, SHOT_MAP_Y_MAX] sind KONSTANT, unabhängig
// vom Spieler - zwei Spieler mit Schüssen aus derselben Eiszone landen daher
// immer an derselben Stelle der Karte.
//
// KEINE Heim-/Auswärts- oder Drittel-Spiegelung: an echten Daten verifiziert
// (siehe Bericht), dass die X/Y-Wertespannen für ein Team über alle 3
// Drittel stabil bleiben und Tor-Events beider Teams sich über denselben
// Wertebereich verteilen statt in zwei getrennte Hälften zu zerfallen - die
// API liefert die Koordinaten bereits in einer einheitlichen,
// angreiferrelativen Ausrichtung.
// ---------------------------------------------------------------------------

// Rein VISUELLE Ergänzung um den erfassten Bereich herum, um ein
// wiedererkennbares Rink zu zeichnen (Mittellinie, blaue Linie, Bullykreise,
// Banden) - NICHT Teil der Datentransformation, NICHT als offizielle
// Bandenmasse behauptet (siehe Auftrag Punkt 2: "falls die exakten
// offiziellen Bandenmasse nicht ableitbar sind, eine feste normalisierte
// Geometrie verwenden, aber nicht als offiziell ausgeben"). BOARD_OFFSET
// (Abstand Torlinie-Bande) und DISPLAY_DEPTH (Bande bis Mittellinie) folgen
// den STANDARD-IIHF-Proportionen (Bande~4m vor dem Tor, Halbfeld~30m) rein
// zur Wiedererkennbarkeit - sie sind keine aus der API abgeleiteten Werte.
const BOARD_OFFSET = 4
const DISPLAY_DEPTH = 30 // Bande (0) bis Mittellinie (30), enthält den erfassten Bereich [BOARD_OFFSET, BOARD_OFFSET+SHOT_MAP_Y_MAX]
const BLUE_LINE_DEPTH = 22 // schematisch (~IIHF-Zonentiefe), keine verifizierte Messgrösse
const GOAL_LINE_DEPTH = BOARD_OFFSET
const CREASE_RADIUS = 1.8 // m, IIHF-Standard
const FACEOFF_DOT_OFFSET_X = 7 // m von der Mitte, IIHF-Standard (Angriffszone)
const FACEOFF_DOT_DEPTH = BOARD_OFFSET + 6 // 6m von der Torlinie, IIHF-Standard
const FACEOFF_CIRCLE_RADIUS = 2.13 // m, IIHF-Standard

// Shot-Typ -> Darstellung. Bewusst 4 klar unterscheidbare Marker-Formen
// (nicht nur Farbe, siehe Mobile/Farbschwäche) - Kreis gefüllt (Tor), Kreis
// hohl (SOG), Kreuz (Miss), Raute (Block).
const TYPE_STYLE = {
  GOAL: { label: 'Tor', color: 'var(--accent)', r: 6, fill: true },
  SOG: { label: 'Schuss aufs Tor', color: 'var(--text)', r: 4.2, fill: false },
  MISS: { label: 'Verfehlt', color: 'var(--text-faint)', r: 4.2, fill: false },
  BLOCK: { label: 'Geblockt', color: 'var(--warn)', r: 4.2, fill: false },
}
const SITUATION_LABEL = { EQ: 'Gleichzahl', PP: 'Powerplay', PK: 'Unterzahl' }
const SITUATION_FILTERS = [
  { key: 'all', label: 'Alle' },
  { key: 'EQ', label: 'EQ' },
  { key: 'PP', label: 'PP' },
  { key: 'PK', label: 'PK' },
]

function fmtTime(sec) {
  if (sec == null) return null
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Marker-Symbol je Typ (r/Farbe aus TYPE_STYLE) - Kreuz/Raute als <path>,
// Kreis als <circle>. Tooltip (Auftrag Punkt 9): Drittel, Zeit, Situation,
// Schuss-Typ, xG - <title> als natives SVG-Tooltip (gleiches Muster wie
// MarketValueHistoryChart.jsx).
function ShotMarker({ shot, cx, cy }) {
  const style = TYPE_STYLE[shot.type] || TYPE_STYLE.SOG
  const parts = [
    style.label,
    shot.period != null ? `${shot.period}. Drittel` : null,
    fmtTime(shot.time),
    shot.situation ? SITUATION_LABEL[shot.situation] || shot.situation : null,
    shot.xg != null ? `xG ${shot.xg.toFixed(2)}` : null,
  ].filter(Boolean)
  const title = parts.join(' · ')

  if (shot.type === 'MISS') {
    const r = style.r
    return (
      <g stroke={style.color} strokeWidth="1.8" opacity="0.9">
        <line x1={cx - r} y1={cy - r} x2={cx + r} y2={cy + r} />
        <line x1={cx - r} y1={cy + r} x2={cx + r} y2={cy - r} />
        <title>{title}</title>
      </g>
    )
  }
  if (shot.type === 'BLOCK') {
    const r = style.r
    return (
      <g>
        <path d={`M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z`} fill="none" stroke={style.color} strokeWidth="1.8" opacity="0.9" />
        <title>{title}</title>
      </g>
    )
  }
  return (
    <circle cx={cx} cy={cy} r={style.r} fill={style.fill ? style.color : 'none'} stroke={style.color} strokeWidth={style.fill ? 0 : 2} opacity={style.fill ? 0.95 : 0.9}>
      <title>{title}</title>
    </circle>
  )
}

// Schematischer, aber erkennbarer Eisfeld-Hintergrund (Halbfeld: Bande bis
// Mittellinie) - Banden (abgerundet an der Torseite), Mittellinie, blaue
// Linie, Torraum/Kreuz, Bullykreise. `toPx(xData, depthData)` rechnet
// Eiskoordinaten (0-30 Breite, 0-DISPLAY_DEPTH Tiefe) in Pixel um.
function RinkBackground({ toPx }) {
  const corner = 5.5 // m, Eckenradius der Bande (schematisch)
  const p = (x, y) => { const [px, py] = toPx(x, y); return `${px} ${py}` }
  // Radien in Pixel je Achse separat (toPx skaliert x/y unterschiedlich) -
  // aus der linearen Transformation abgeleitet, keine feste Pixelzahl.
  const [ox, oy] = toPx(0, 0)
  const rxPx = Math.abs(toPx(corner, 0)[0] - ox)
  const ryPx = Math.abs(toPx(0, corner)[1] - oy)
  // Bande als Rechteck von (0, 0) bis (30, DISPLAY_DEPTH), NUR an der
  // Torseite (Tiefe 0, unten im Bild) abgerundet - an der Mittellinie
  // (oben) endet die Darstellung ohnehin schematisch, keine echte Bande.
  const boardsPath = [
    `M ${p(0, corner)}`,
    `A ${rxPx} ${ryPx} 0 0 1 ${p(corner, 0)}`,
    `L ${p(SHOT_MAP_X_MAX - corner, 0)}`,
    `A ${rxPx} ${ryPx} 0 0 1 ${p(SHOT_MAP_X_MAX, corner)}`,
    `L ${p(SHOT_MAP_X_MAX, DISPLAY_DEPTH)}`,
    `L ${p(0, DISPLAY_DEPTH)}`,
    'Z',
  ].join(' ')

  const [goalCx, goalCy] = toPx(SHOT_MAP_X_MAX / 2, GOAL_LINE_DEPTH)
  const [, blueLineY] = toPx(0, BLUE_LINE_DEPTH)
  const [, centerLineY] = toPx(0, DISPLAY_DEPTH)
  const [x0] = toPx(0, 0)
  const [x1] = toPx(SHOT_MAP_X_MAX, 0)
  const creaseRPx = Math.abs(toPx(SHOT_MAP_X_MAX / 2 + CREASE_RADIUS, GOAL_LINE_DEPTH)[0] - goalCx)

  const faceoffDots = [SHOT_MAP_X_MAX / 2 - FACEOFF_DOT_OFFSET_X, SHOT_MAP_X_MAX / 2 + FACEOFF_DOT_OFFSET_X].map((fx) => toPx(fx, FACEOFF_DOT_DEPTH))
  const faceoffRPx = Math.abs(toPx(SHOT_MAP_X_MAX / 2 + FACEOFF_DOT_OFFSET_X + FACEOFF_CIRCLE_RADIUS, FACEOFF_DOT_DEPTH)[0] - faceoffDots[1][0])

  return (
    <g>
      <path d={boardsPath} fill="var(--bg-elev-2)" stroke="var(--border)" strokeWidth="2" />
      {/* Mittellinie (rot, schematisch am oberen Rand des Halbfelds) */}
      <line x1={x0} y1={centerLineY} x2={x1} y2={centerLineY} stroke="var(--bad)" strokeWidth="2" opacity="0.55" />
      {/* Blaue Linie */}
      <line x1={x0} y1={blueLineY} x2={x1} y2={blueLineY} stroke="#3a7bd5" strokeWidth="2" opacity="0.55" />
      {/* Bullykreise Angriffszone */}
      {faceoffDots.map(([fx, fy], i) => (
        <g key={i}>
          <circle cx={fx} cy={fy} r={faceoffRPx} fill="none" stroke="var(--border)" strokeWidth="1.3" opacity="0.6" />
          <circle cx={fx} cy={fy} r="2.5" fill="var(--border)" opacity="0.7" />
        </g>
      ))}
      {/* Torraum (Kreuz) */}
      <path
        d={`M ${goalCx - creaseRPx} ${goalCy} A ${creaseRPx} ${creaseRPx} 0 0 0 ${goalCx + creaseRPx} ${goalCy}`}
        fill="var(--accent)" opacity="0.12" stroke="var(--accent)" strokeWidth="1.3"
      />
      {/* Tor */}
      <rect x={goalCx - 7} y={goalCy - 4} width="14" height="4" fill="none" stroke="var(--text)" strokeWidth="1.6" />
    </g>
  )
}

// `shots` = Rückgabe von collectPlayerShots() (src/advancedStats.js) - EIN
// Spieler, bereits über die Saison gesammelt, unveränderte Rohkoordinaten -
// die Filterung ungültiger/fehlender Koordinaten passiert HIER, rein für die
// Darstellung (collectPlayerShots() selbst liefert bewusst alle Rohdaten
// unverändert, siehe Kommentar dort).
export default function ShotMap({ shots }) {
  const [filter, setFilter] = useState('all')

  const withCoords = useMemo(() => (shots || []).filter(isValidShotCoordinate), [shots])
  const filtered = useMemo(
    () => (filter === 'all' ? withCoords : withCoords.filter((s) => s.situation === filter)),
    [withCoords, filter]
  )
  const invalidCount = (shots || []).length - withCoords.length

  const counts = useMemo(() => {
    const c = { all: withCoords.length, EQ: 0, PP: 0, PK: 0 }
    for (const s of withCoords) if (s.situation && c[s.situation] != null) c[s.situation]++
    return c
  }, [withCoords])

  if (withCoords.length === 0) {
    return (
      <div className="muted card-pad" style={{ fontSize: 12.5 }}>
        Noch keine Shot-Daten mit gültigen Koordinaten für diesen Spieler verfügbar.
      </div>
    )
  }

  // Basis-Seitenverhältnis der Eisfläche unverändert (30 Breite : 30 Tiefe,
  // siehe DISPLAY_DEPTH/SHOT_MAP_X_MAX oben - reine Darstellungsgrösse, KEINE
  // Änderung an der verifizierten 30x24-Koordinatentransformation selbst).
  // Deutlich grösser als zuvor (Polish Punkt 1: vorher max. 460px breit, mit
  // viel Leerraum rechts auf breiten Karten) - wächst jetzt mit der
  // verfügbaren Breite bis 620px auf Desktop.
  const W = 460, H = 504, pad = 20
  const toPx = (xData, depthData) => [
    pad + (xData / SHOT_MAP_X_MAX) * (W - pad * 2),
    pad + (1 - depthData / DISPLAY_DEPTH) * (H - pad * 2),
  ]
  const shotToPx = (s) => toPx(s.x, BOARD_OFFSET + s.y)

  return (
    <div>
      <div className="pill-tabs full mb" style={{ maxWidth: 320 }}>
        {SITUATION_FILTERS.map((f) => (
          <button key={f.key} className={filter === f.key ? 'active' : ''} onClick={() => setFilter(f.key)}>
            {f.label} <span className="muted" style={{ fontSize: 10.5 }}>({counts[f.key] ?? 0})</span>
          </button>
        ))}
      </div>
      {/* Rink + Legende/Caption nebeneinander auf breiten Karten (nutzt den
          Leerraum rechts neben dem hochformatigen Rink statt ihn
          verschwenden zu lassen), untereinander sobald der verfügbare Platz
          nicht mehr reicht (flexWrap - responsive, keine feste Media-Query-
          Breakpoint-Abhängigkeit, funktioniert daher auch auf Mobile). */}
      <div className="row" style={{ gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 380px', minWidth: 280, maxWidth: 620 }}>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
            <RinkBackground toPx={toPx} />
            {filtered.map((s, i) => {
              const [cx, cy] = shotToPx(s)
              return <ShotMarker key={s.gameId + '-' + i} shot={s} cx={cx} cy={cy} />
            })}
          </svg>
        </div>
        <div style={{ flex: '1 1 180px', minWidth: 160, paddingTop: 4 }}>
          <div className="column gap-sm" style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 11.5 }}>
            {Object.entries(TYPE_STYLE).map(([type, style]) => (
              <span key={type} className="row gap-sm" style={{ alignItems: 'center' }}>
                <span style={{ width: 9, height: 9, flexShrink: 0, borderRadius: type === 'GOAL' || type === 'SOG' ? '50%' : 0, background: style.fill ? style.color : 'transparent', border: style.fill ? 'none' : `1.6px solid ${style.color}` }} />
                {style.label}
              </span>
            ))}
          </div>
          <div className="muted mt" style={{ fontSize: 10.5 }}>
            Feste Koordinatentransformation ({SHOT_MAP_X_MAX}×{SHOT_MAP_Y_MAX}-Raster der National-League-API, unabhängig von der Schussverteilung dieses Spielers) - schematische Eisfeld-Darstellung, keine offiziellen Bandenmasse.
            {invalidCount > 0 && ` ${invalidCount} Schuss${invalidCount === 1 ? '' : 'e'} mit fehlerhaften Koordinaten (ausserhalb des gültigen Bereichs) wurde${invalidCount === 1 ? '' : 'n'} ausgeblendet.`}
          </div>
        </div>
      </div>
    </div>
  )
}
