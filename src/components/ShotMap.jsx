import { useMemo, useState } from 'react'

// Shot-Typ -> Darstellung. Bewusst 4 klar unterscheidbare Marker-Formen
// (nicht nur Farbe, siehe Mobile/Farbschwäche) - Kreis gefüllt (Tor), Kreis
// hohl (SOG), Kreuz (Miss), Raute (Block).
const TYPE_STYLE = {
  GOAL: { label: 'Tor', color: 'var(--accent)', r: 5.5, fill: true },
  SOG: { label: 'Schuss aufs Tor', color: 'var(--text)', r: 4, fill: false },
  MISS: { label: 'Verfehlt', color: 'var(--text-faint)', r: 4, fill: false },
  BLOCK: { label: 'Geblockt', color: 'var(--warn)', r: 4, fill: false },
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
// Kreis als <circle>. `t` = <title>-Text für Hover/Tap (native SVG-Tooltip,
// gleiches Muster wie MarketValueHistoryChart.jsx).
function ShotMarker({ shot, cx, cy }) {
  const style = TYPE_STYLE[shot.type] || TYPE_STYLE.SOG
  const parts = [
    `${style.label}${shot.xg != null ? ` · xG ${shot.xg.toFixed(2)}` : ''}`,
    shot.situation ? SITUATION_LABEL[shot.situation] || shot.situation : null,
    shot.period != null ? `${shot.period}. Drittel` : null,
    fmtTime(shot.time),
  ].filter(Boolean)
  const title = parts.join(' · ')

  if (shot.type === 'MISS') {
    const r = style.r
    return (
      <g stroke={style.color} strokeWidth="1.6" opacity="0.85">
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
        <path d={`M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z`} fill="none" stroke={style.color} strokeWidth="1.6" opacity="0.9" />
        <title>{title}</title>
      </g>
    )
  }
  return (
    <circle cx={cx} cy={cy} r={style.r} fill={style.fill ? style.color : 'none'} stroke={style.color} strokeWidth={style.fill ? 0 : 1.8} opacity={style.fill ? 0.95 : 0.85}>
      <title>{title}</title>
    </circle>
  )
}

// Einfaches, schematisches Eisfeld-Rechteck (abgerundet + Mittellinie) als
// Hintergrund - KEINE offiziell exakten Bandenmarkierungen, nur ein
// dezenter, erkennbarer Rink-Rahmen. Die eigentliche Positionierung der
// Schüsse basiert ausschliesslich auf den tatsächlichen x/y-Rohwerten der
// API (siehe Auftrag: "keine künstliche Shotmap") - die Skalierung ist
// dynamisch an die tatsächliche Wertespanne dieses Spielers angepasst.
function RinkBackground({ w, h, pad }) {
  const x0 = pad, y0 = pad, rw = w - pad * 2, rh = h - pad * 2
  return (
    <g>
      <rect x={x0} y={y0} width={rw} height={rh} rx={Math.min(rw, rh) * 0.12} fill="var(--bg-elev-2)" stroke="var(--border)" strokeWidth="1.5" />
      <line x1={x0 + rw / 2} y1={y0} x2={x0 + rw / 2} y2={y0 + rh} stroke="var(--border)" strokeWidth="1" strokeDasharray="3 3" />
    </g>
  )
}

// `shots` = Rückgabe von collectPlayerShots() (src/advancedStats.js) - EIN
// Spieler, bereits über die Saison gesammelt, unveränderte Rohkoordinaten.
export default function ShotMap({ shots }) {
  const [filter, setFilter] = useState('all')

  const withCoords = useMemo(() => (shots || []).filter((s) => s.x != null && s.y != null), [shots])
  const filtered = useMemo(
    () => (filter === 'all' ? withCoords : withCoords.filter((s) => s.situation === filter)),
    [withCoords, filter]
  )

  const counts = useMemo(() => {
    const c = { all: withCoords.length, EQ: 0, PP: 0, PK: 0 }
    for (const s of withCoords) if (s.situation && c[s.situation] != null) c[s.situation]++
    return c
  }, [withCoords])

  if (withCoords.length === 0) {
    return (
      <div className="muted card-pad" style={{ fontSize: 12.5 }}>
        Noch keine Shot-Daten mit Koordinaten für diesen Spieler verfügbar.
      </div>
    )
  }

  const W = 500, H = 300, pad = 14
  const xs = withCoords.map((s) => s.x), ys = withCoords.map((s) => s.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  // Etwas Rand um die tatsächliche Wertespanne, damit Randpunkte nicht auf
  // der Bande liegen - rein visuell, ändert keine Koordinate.
  const spanX = Math.max(maxX - minX, 1), spanY = Math.max(maxY - minY, 1)
  const marginX = spanX * 0.08, marginY = spanY * 0.08
  const sx = (x) => pad + ((x - (minX - marginX)) / (spanX + marginX * 2)) * (W - pad * 2)
  const sy = (y) => pad + ((y - (minY - marginY)) / (spanY + marginY * 2)) * (H - pad * 2)

  return (
    <div>
      <div className="pill-tabs full mb" style={{ maxWidth: 320 }}>
        {SITUATION_FILTERS.map((f) => (
          <button key={f.key} className={filter === f.key ? 'active' : ''} onClick={() => setFilter(f.key)}>
            {f.label} <span className="muted" style={{ fontSize: 10.5 }}>({counts[f.key] ?? 0})</span>
          </button>
        ))}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 280, maxWidth: 560, display: 'block' }}>
          <RinkBackground w={W} h={H} pad={pad} />
          {filtered.map((s, i) => (
            <ShotMarker key={s.gameId + '-' + i} shot={s} cx={sx(s.x)} cy={sy(s.y)} />
          ))}
        </svg>
      </div>
      <div className="row wrap gap-sm mt" style={{ gap: 14, fontSize: 11.5 }}>
        {Object.entries(TYPE_STYLE).map(([type, style]) => (
          <span key={type} className="row gap-sm">
            <span style={{ width: 9, height: 9, borderRadius: type === 'GOAL' || type === 'SOG' ? '50%' : 0, background: style.fill ? style.color : 'transparent', border: style.fill ? 'none' : `1.6px solid ${style.color}` }} />
            {style.label}
          </span>
        ))}
      </div>
      <div className="muted mt" style={{ fontSize: 10.5 }}>
        Positionen basieren auf den Rohkoordinaten der National-League-API (dynamisch auf die Wertespanne dieses Spielers skaliert), keine offiziellen Bandenmasse.
      </div>
    </div>
  )
}
