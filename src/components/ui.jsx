import { useEffect, useState } from 'react'
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

// Delta-Anzeige ggü. der letzten Baseline (src/baselineStore.js) oder einer
// anderen Vergleichsprojektion (z.B. What-if ggü. unbedingter Projektion).
// Bewusst neutral eingefärbt (kein grün/rot) - siehe Kommentar in styles.css.
// `unit`: "pp" für Prozentpunkte (Standard, Wahrscheinlichkeiten), "" für
// andere Grössen (z.B. Rang-Differenz).
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
