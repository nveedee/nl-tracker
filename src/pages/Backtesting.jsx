// ---------------------------------------------------------------------------
// Backtesting (/backtesting) - historischer Modellvergleich auf den
// Archiv-Saisons 2017/18-2025/26 (server/scripts/backtesting/run.js ->
// public/backtest-results.json, statischer Export, exakt dasselbe Muster wie
// public/preseason-elo.json/player-history.json).
//
// STRIKT GETRENNT von /model-performance (src/pages/ModelPerformance.jsx):
// diese Seite zeigt AUSSCHLIESSLICH den historischen Walk-Forward-Backtest,
// nie die echten 2026/27-Snapshots. Keine Vermischung, siehe Bericht.
//
// Zeigt nur an, was der Backtest-Lauf tatsächlich berechnet hat - keine neue
// Berechnung/Kalibrierung hier im Frontend.
// ---------------------------------------------------------------------------

import { useEffect, useState, useMemo } from 'react'

let cache = null
function useBacktestResults() {
  const [data, setData] = useState(cache)
  useEffect(() => {
    if (cache) { setData(cache); return }
    let cancelled = false
    fetch('/backtest-results.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => { cache = json; if (!cancelled) setData(json) })
      .catch(() => { if (!cancelled) setData(null) })
    return () => { cancelled = true }
  }, [])
  return data // undefined = lädt noch, null = nicht verfügbar
}

function fmtPct(v) { return v == null ? '–' : (v * 100).toFixed(1) + '%' }
function fmtScore(v, d = 4) { return v == null ? '–' : v.toFixed(d) }
function fmtDelta(v) { return v == null ? '–' : (v >= 0 ? '+' : '') + v.toFixed(4) }
function fmtDate(iso) { return iso ? new Date(iso).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–' }

const STATUS_LABEL = {
  candidate: 'Kandidat', validated: 'Validiert', rejected: 'Verworfen',
  production: 'Produktiv', not_validatable: 'Historisch nicht validierbar',
}
const STATUS_TONE = {
  candidate: '', validated: 'good', rejected: 'bad',
  production: 'good', not_validatable: 'muted',
}

export default function Backtesting() {
  const data = useBacktestResults()
  const [seasonFilter, setSeasonFilter] = useState('all')
  const [calibrationModel, setCalibrationModel] = useState('production_reference')

  const validatable = useMemo(() => (data ? data.predictors.filter((p) => !p.notValidatable) : []), [data])

  if (data === undefined) return <div className="muted" style={{ padding: '20px 0' }}>Lädt…</div>
  if (data === null) {
    return (
      <div className="empty">
        <div className="title">Kein Backtest-Ergebnis gefunden</div>
        <div className="hint">
          Führe <code>node server/scripts/backtesting/run.js</code> aus, um{' '}
          <code>public/backtest-results.json</code> zu erzeugen.
        </div>
      </div>
    )
  }

  const bestOf = (key, lowerIsBetter = true) => {
    const vals = validatable.map((p) => p.overall.core?.[key]).filter((v) => v != null)
    if (vals.length === 0) return null
    return lowerIsBetter ? Math.min(...vals) : Math.max(...vals)
  }
  const bestAcc = bestOf('accuracy', false)
  const bestBrier = bestOf('brier', true)
  const bestLogloss = bestOf('logLoss', true)
  const bestEce = Math.min(...validatable.map((p) => p.ece).filter((v) => v != null))

  const seasonOptions = ['all', ...data.seasons]
  const metricsForSelection = (p) => {
    if (seasonFilter === 'all') return p.overall.core
    return p.perSeason[seasonFilter]
  }

  const calibModel = data.predictors.find((p) => p.id === calibrationModel) || data.predictors[0]

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Backtesting</h1>
          <div className="sub">
            Historischer Walk-Forward-Vergleich · {data.seasons.length} Saisons ({data.seasons[0]}–{data.seasons.at(-1)}) ·{' '}
            {data.totalGames.toLocaleString('de-CH')} Spiele · erzeugt {fmtDate(data.generatedAt)}
          </div>
        </div>
      </div>

      {/* Data Audit */}
      <div className="card card-pad mb">
        <h2 className="mb">Data Audit</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th className="left">Saison</th><th className="num">Spiele</th><th className="num">OT</th><th className="num">SO</th><th className="left">Hinweis</th></tr>
            </thead>
            <tbody>
              {data.dataAudit.perSeason.map((s) => (
                <tr key={s.season}>
                  <td className="left">{s.season}{s.corona ? <span className="chip" style={{ marginLeft: 6, fontSize: 10 }}>Corona</span> : null}</td>
                  <td className="num">{s.games}</td>
                  <td className="num">{s.ot}</td>
                  <td className="num">{s.so}</td>
                  <td className="left muted" style={{ fontSize: 11.5 }}>{s.failedImports?.length ? `${s.failedImports.length} Spiele beim Import fehlgeschlagen` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid grid-2 mt" style={{ gap: 10 }}>
          <div className="tile">
            <div className="label">Marktwerte historisch verfügbar?</div>
            <div className="value" style={{ fontSize: 15 }}><span className="bad">Nein</span></div>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{data.dataAudit.marketValueReason}</div>
          </div>
          <div className="tile">
            <div className="label">SOG-Allowed historisch verfügbar?</div>
            <div className="value" style={{ fontSize: 15 }}><span className="good">Ja</span></div>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{data.dataAudit.sogSource}</div>
          </div>
        </div>
      </div>

      {/* Model Comparison */}
      <div className="card mb">
        <div className="card-pad" style={{ paddingBottom: 6 }}>
          <div className="row spread wrap" style={{ gap: 10 }}>
            <h2 style={{ margin: 0 }}>Model Comparison</h2>
            <select style={{ width: 'auto' }} value={seasonFilter} onChange={(e) => setSeasonFilter(e.target.value)}>
              {seasonOptions.map((s) => <option key={s} value={s}>{s === 'all' ? 'Alle Saisons (ohne Corona)' : s}</option>)}
            </select>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="left">Version</th>
                <th className="num">n</th>
                <th className="num">Accuracy</th>
                <th className="num">Brier</th>
                <th className="num">LogLoss</th>
                <th className="num">ECE</th>
                <th className="left">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.predictors.map((p) => {
                const m = seasonFilter === 'all' ? p.overall.core : metricsForSelection(p)
                const status = data.modelVersions.find((v) => v.id === p.id)?.status
                if (p.notValidatable) {
                  return (
                    <tr key={p.id}>
                      <td className="left"><strong>{p.name}</strong></td>
                      <td className="num muted" colSpan={5} style={{ textAlign: 'left' }}>Historisch nicht validierbar – {p.reason}</td>
                      <td className="left"><span className={`chip ${STATUS_TONE[status]}`}>{STATUS_LABEL[status] || status}</span></td>
                    </tr>
                  )
                }
                return (
                  <tr key={p.id}>
                    <td className="left"><strong>{p.name}</strong></td>
                    <td className="num">{m?.n ?? '–'}</td>
                    <td className="num"><strong className={seasonFilter === 'all' && m?.accuracy === bestAcc ? 'good' : ''}>{fmtPct(m?.accuracy)}</strong></td>
                    <td className="num"><strong className={seasonFilter === 'all' && m?.brier === bestBrier ? 'good' : ''}>{fmtScore(m?.brier)}</strong></td>
                    <td className="num"><strong className={seasonFilter === 'all' && m?.logLoss === bestLogloss ? 'good' : ''}>{fmtScore(m?.logLoss)}</strong></td>
                    <td className="num">{seasonFilter === 'all' ? <span className={p.ece === bestEce ? 'good' : ''}>{fmtScore(p.ece)}</span> : <span className="muted">–</span>}</td>
                    <td className="left"><span className={`chip ${STATUS_TONE[status]}`}>{STATUS_LABEL[status] || status}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="muted card-pad" style={{ paddingTop: 8, fontSize: 11.5 }}>
          Primäre Vergleichsmetriken: Brier &amp; LogLoss (niedriger = besser). Accuracy allein ist KEIN alleiniger Qualitätsnachweis (siehe Bericht). Grün = bester Wert der Spalte, nur bei „Alle Saisons".
        </div>
      </div>

      {/* Comparisons / Model Verdict */}
      <div className="card card-pad mb">
        <h2 className="mb">Model Verdict</h2>
        {data.comparisons.map((c) => (
          <div key={c.a + c.b} className="card card-pad mb" style={{ background: 'var(--bg-elev)' }}>
            <div className="row spread wrap" style={{ marginBottom: 6, gap: 8 }}>
              <strong>{c.label}</strong>
              <span className={`chip ${c.robust ? 'good' : 'bad'}`}>{c.robust ? 'Robuster Zusatznutzen' : 'Kein robuster Zusatznutzen'}</span>
            </div>
            <p style={{ margin: '0 0 8px 0', fontSize: 13.5, lineHeight: 1.6 }}>{c.verdict}</p>
            <div className="row gap-sm wrap" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              <span>ΔLogLoss: <strong style={{ color: 'inherit' }}>{fmtDelta(c.observedLogLossDelta)}</strong></span>
              <span>·</span>
              <span>95%-Bootstrap-CI: [{c.bootstrapCi95 ? c.bootstrapCi95.map((v) => v.toFixed(4)).join(', ') : '–'}]</span>
              <span>·</span>
              <span>Saisons besser: {c.seasonsBetter.better}/{c.seasonsBetter.total}</span>
              <span>·</span>
              <span>n={c.n}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Calibration */}
      <div className="card card-pad mb">
        <div className="row spread wrap mb" style={{ gap: 10 }}>
          <h2 style={{ margin: 0 }}>Calibration</h2>
          <select style={{ width: 'auto' }} value={calibrationModel} onChange={(e) => setCalibrationModel(e.target.value)}>
            {data.predictors.filter((p) => !p.notValidatable).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <ReliabilityChart buckets={calibModel.calibration} ece={calibModel.ece} />
        <div className="table-wrap mt">
          <table>
            <thead>
              <tr><th className="left">Bucket</th><th className="num">n</th><th className="num">Ø Prognose</th><th className="num">Tatsächl. Quote</th><th className="num">Differenz</th></tr>
            </thead>
            <tbody>
              {calibModel.calibration.map((b) => (
                <tr key={b.label}>
                  <td className="left">{b.label}{b.lowSample && b.count > 0 ? <span className="muted" style={{ marginLeft: 6, fontSize: 10.5 }}>(dünn)</span> : null}</td>
                  <td className="num">{b.count}</td>
                  <td className="num">{fmtPct(b.avgPredicted)}</td>
                  <td className="num">{fmtPct(b.actualRate)}</td>
                  <td className="num">{b.diff == null ? '–' : <span className={Math.abs(b.diff) < 0.03 ? 'good' : Math.abs(b.diff) < 0.08 ? '' : 'bad'}>{(b.diff >= 0 ? '+' : '') + (b.diff * 100).toFixed(1) + 'pp'}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Model Version Registry */}
      <div className="card mb">
        <div className="card-pad" style={{ paddingBottom: 6 }}><h2 style={{ margin: 0 }}>Model Version History</h2></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th className="left">Version</th><th className="left">Features</th><th className="left">Datum</th><th className="left">Status</th></tr>
            </thead>
            <tbody>
              {data.modelVersions.map((v) => (
                <tr key={v.id}>
                  <td className="left"><strong>{v.name}</strong><div className="muted" style={{ fontSize: 11.5, maxWidth: 420 }}>{v.description}</div></td>
                  <td className="left" style={{ fontSize: 12 }}>{v.features.join(', ')}</td>
                  <td className="left muted" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{v.date}</td>
                  <td className="left"><span className={`chip ${STATUS_TONE[v.status]}`}>{STATUS_LABEL[v.status] || v.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

// Reliability-Chart (45°-Ideallinie + Ø-Prognose/tatsächliche-Quote je
// Bucket) - handgebautes SVG nach dem Muster von GoalieChart/SkaterChart
// (src/pages/PlayerDetail.jsx), keine Chart-Bibliothek. Dünne Buckets
// (lowSample) werden als hohle statt gefüllte Punkte dargestellt.
function ReliabilityChart({ buckets, ece }) {
  const W = 500, H = 320, pad = { l: 44, r: 16, t: 16, b: 34 }
  const x = (v) => pad.l + v * (W - pad.l - pad.r)
  const y = (v) => H - pad.b - v * (H - pad.t - pad.b)
  const points = buckets.filter((b) => b.count > 0)

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 320, maxWidth: 560 }}>
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={pad.t} y2={H - pad.b} stroke="var(--border)" strokeWidth="0.5" />
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="0.5" />
            <text x={pad.l - 6} y={y(v) + 3} fontSize="9" fill="var(--text-dim)" textAnchor="end">{Math.round(v * 100)}%</text>
            <text x={x(v)} y={H - pad.b + 14} fontSize="9" fill="var(--text-dim)" textAnchor="middle">{Math.round(v * 100)}%</text>
          </g>
        ))}
        {/* 45°-Ideallinie */}
        <line x1={x(0.5)} y1={y(0.5)} x2={x(1)} y2={y(1)} stroke="var(--text-faint)" strokeWidth="1.5" strokeDasharray="4 4" />
        {/* Reliability-Kurve */}
        <path
          d={points.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(b.avgPredicted)},${y(b.actualRate)}`).join(' ')}
          fill="none" stroke="var(--accent)" strokeWidth="2"
        />
        {points.map((b) => (
          <circle
            key={b.label} cx={x(b.avgPredicted)} cy={y(b.actualRate)}
            r={b.lowSample ? 3.5 : 4 + Math.min(6, Math.sqrt(b.count) / 3)}
            fill={b.lowSample ? 'var(--bg)' : 'var(--accent)'}
            stroke="var(--accent)" strokeWidth={b.lowSample ? 1.5 : 0}
          >
            <title>{`${b.label}: n=${b.count}, Ø Prognose ${(b.avgPredicted * 100).toFixed(1)}%, tatsächlich ${(b.actualRate * 100).toFixed(1)}%${b.lowSample ? ' (dünne Stichprobe)' : ''}`}</title>
          </circle>
        ))}
        <text x={x(0.5)} y={y(1) - 6} fontSize="9" fill="var(--text-faint)" textAnchor="end">ideal (45°)</text>
      </svg>
      <div className="row wrap gap-sm mt" style={{ gap: 14, fontSize: 12 }}>
        <span className="row gap-sm"><span className="dot" style={{ background: 'var(--accent)' }} />gefüllt = ≥20 Spiele im Bucket</span>
        <span className="row gap-sm"><span className="dot" style={{ background: 'var(--bg)', border: '1.5px solid var(--accent)' }} />hohl = &lt;20 Spiele (dünn, mit Vorsicht lesen)</span>
        <span className="muted">ECE (gepoolt, ohne Corona): {ece == null ? '–' : ece.toFixed(4)}</span>
      </div>
    </div>
  )
}
