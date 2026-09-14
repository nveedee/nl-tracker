import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

// Team-Badge mit Farbpunkt
export function TeamBadge({ team, link = true, short = false }) {
  if (!team) return <span className="muted">–</span>
  const inner = (
    <span className="team-badge">
      <span className="dot" style={{ background: team.color }} />
      {short ? team.short : team.name}
    </span>
  )
  if (!link) return inner
  return <Link to={`/teams/${team.id}`}>{inner}</Link>
}

// Modal-Dialog
export function Modal({ title, children, onClose, footer }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">{title}</div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

// Kleiner Toast über einen globalen Event-Bus
let toastCb = null
export function toast(msg, isError = false) {
  if (toastCb) toastCb({ msg, isError, id: Date.now() })
}
export function ToastHost() {
  const [t, setT] = useState(null)
  useEffect(() => {
    toastCb = (payload) => {
      setT(payload)
      setTimeout(() => setT((cur) => (cur && cur.id === payload.id ? null : cur)), 2600)
    }
    return () => { toastCb = null }
  }, [])
  if (!t) return null
  return <div className={'toast' + (t.isError ? ' err' : '')}>{t.msg}</div>
}

// Sortierbare Tabelle.
// columns: [{ key, label, align, num, className, render(row), value(row), left }]
export function SortableTable({ columns, rows, initialSort, initialDir = 'desc', rowKey }) {
  const [sort, setSort] = useState(initialSort || columns[0].key)
  const [dir, setDir] = useState(initialDir)

  const col = columns.find((c) => c.key === sort) || columns[0]
  const sorted = [...rows].sort((a, b) => {
    const va = col.value ? col.value(a) : a[col.key]
    const vb = col.value ? col.value(b) : b[col.key]
    let cmp
    if (typeof va === 'string' || typeof vb === 'string') {
      cmp = String(va ?? '').localeCompare(String(vb ?? ''))
    } else {
      cmp = (va ?? -Infinity) - (vb ?? -Infinity)
    }
    return dir === 'asc' ? cmp : -cmp
  })

  const clickHead = (c) => {
    if (c.noSort) return
    if (c.key === sort) setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSort(c.key); setDir('desc') }
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={[c.left ? 'left' : '', c.num ? 'num' : '', c.noSort ? '' : 'sortable'].join(' ')}
                onClick={() => clickHead(c)}
                title={c.title}
              >
                {c.label}
                {sort === c.key && <span className="sort-ind">{dir === 'asc' ? '▲' : '▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={rowKey ? rowKey(row) : i}>
              {columns.map((c) => (
                <td key={c.key} className={[c.left ? 'left' : '', c.num ? 'num' : '', c.className || ''].join(' ')}>
                  {c.render ? c.render(row, i) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Marktwert-Trend-Pfeil (NL-API marketValueTrend: 1 steigend, -1 fallend, 0
// stabil, null/undefined = keine Angabe -> nichts gerendert).
export function MarketValueTrend({ trend }) {
  if (trend === 1) return <span style={{ color: 'var(--good)' }} title="steigend">▲</span>
  if (trend === -1) return <span style={{ color: 'var(--bad)' }} title="fallend">▼</span>
  if (trend === 0) return <span className="muted" title="stabil">→</span>
  return null
}

// DeltaBadge: ▲ grün / ▼ rot, ggü. der letzten Baseline (src/baselineStore.js)
// oder einer anderen Vergleichsprojektion (z.B. What-if ggü. unbedingter
// Projektion). `unit`: "pp" für Prozentpunkte (Standard), "" für andere
// Grössen (z.B. Rang-Differenz).
export function Delta({ pp, digits = 1, unit = 'pp' }) {
  if (pp == null) return null
  if (Math.abs(pp) < 0.05) return <span className="delta">±0.0{unit}</span>
  const dir = pp > 0 ? 'up' : 'down'
  return <span className={'delta ' + dir}>{Math.abs(pp).toFixed(digits)}{unit}</span>
}

export function Empty({ title, hint, action }) {
  return (
    <div className="empty">
      <div className="title">{title}</div>
      {hint && <div className="hint">{hint}</div>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  )
}

// Titel + einzeilige Erklärung darunter (FMD-Caption-Stil) - jede Auswertung
// bekommt so eine kurze Einordnung, ohne dass man Vorwissen braucht.
export function SectionHeader({ title, caption, action }) {
  return (
    <div className="section-header row spread" style={{ alignItems: 'flex-start' }}>
      <div>
        <div className="title">{title}</div>
        {caption && <div className="caption">{caption}</div>}
      </div>
      {action}
    </div>
  )
}

// Wahrscheinlichkeit als Balken + %-Wert - macht Grössenunterschiede auf
// einen Blick erfassbar statt nur als Zahl. `max` normiert die Balkenlänge
// (Default 1 = Anteil von 100%).
export function ProbBar({ value, max = 1, digits = 1, color }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(1, value / max)) * 100
  return (
    <div className="prob-bar-row">
      <div className="prob-bar-track">
        <div className="prob-bar-fill" style={{ width: `${pct}%`, ...(color ? { background: color } : {}) }} />
      </div>
      <span className="prob-bar-value">{value == null ? '–' : (value * 100).toFixed(digits) + '%'}</span>
    </div>
  )
}

// Kompakte Kennzahl-Kachel (Ø-Werte, Stat-Übersichten).
export function StatTile({ label, value, hint, accent = false }) {
  return (
    <div className="stat-tile">
      <div className="label">{label}</div>
      <div className={'value' + (accent ? ' accent' : '')}>{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}

// Farbskala/Kategorie-Legende - z.B. Heatmap-Rampe oder Bracket-Farben.
// `swatches`: [{ label, color }]. `scale`: { fromLabel, toLabel, stops: [rgbCss,...] } für einen Farbverlauf.
export function Legend({ swatches, scale }) {
  return (
    <div className="legend">
      {scale && (
        <span className="scale">
          <span>{scale.fromLabel}</span>
          <span className="ramp">{scale.stops.map((c, i) => <span key={i} style={{ background: c }} />)}</span>
          <span>{scale.toLabel}</span>
        </span>
      )}
      {swatches?.map((s) => (
        <span className="swatch" key={s.label}>
          <span className="sq" style={{ background: s.color }} /> {s.label}
        </span>
      ))}
    </div>
  )
}

// Zeigt zunächst nur `initialCount` Kinder, darunter ein "Alle N anzeigen"-
// Trigger (progressive disclosure statt alles auf einmal). `items` optional -
// wenn übergeben, wird nur die Anzahl fürs Label genutzt (Kinder kommen
// weiterhin über `children`, bereits auf `initialCount`/alle geschnitten -
// so bleibt die Slicing-Logik beim Aufrufer, der z.B. auch sortiert).
export function Expander({ total, initialCount, expanded, onExpand, moreLabel }) {
  if (expanded || total <= initialCount) return null
  return (
    <button className="expander-trigger" onClick={onExpand}>
      {moreLabel || `Alle ${total} anzeigen`}
    </button>
  )
}

// Horizontal scrollbare, sticky Sub-Tab-Leiste (z.B. Season Projections:
// Matrix/Brackets/What-if/...). `tabs`: [{ key, label }].
export function Tabs({ tabs, active, onChange }) {
  const ref = useRef(null)
  useEffect(() => {
    const btn = ref.current?.querySelector(`button[data-key="${active}"]`)
    btn?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [active])
  return (
    <div className="subtabs" ref={ref}>
      {tabs.map((t) => (
        <button key={t.key} data-key={t.key} className={active === t.key ? 'active' : ''} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

// Setzt `.scrollable` auf einen `.table-wrap`, sobald sein Inhalt tatsächlich
// breiter ist als der sichtbare Container - schaltet den rechten Fade
// (Scroll-Affordanz, siehe styles.css) nur dann zu, wenn wirklich etwas zu
// scrollen ist. Ref ans `.table-wrap`-Element hängen.
export function useScrollFade() {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => el.classList.toggle('scrollable', el.scrollWidth > el.clientWidth + 2)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return ref
}
