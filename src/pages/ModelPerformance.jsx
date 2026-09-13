// ---------------------------------------------------------------------------
// Model Performance (/model-performance) - wertet ausschliesslich bereits
// gespeicherte, unveränderliche Pre-Game Prediction Snapshots
// (db.predictions[], server/scripts/predictions.js) gegen die tatsächlichen
// Spielergebnisse aus (src/predictionMetrics.js). Keine erneute Simulation,
// keine neue Prognoseformel, kein H2H/Form. Miss lediglich, wie gut das
// Modell bei echten, bereits gespielten Spielen tatsächlich war.
//
// Zwei strikt getrennte Bereiche (siehe Abschnitt "Historischer Backtest"
// unten): der walk-forward Backtest auf historischen SIHF-Archivdaten
// (server/scripts/backtest-preseason-h2h-result.json, Modell D = aktuell
// produktives ELO+Pre-Season-ELO+SOG-Allowed) liefert nur eine statische
// REFERENZ zum Vergleich - er wird NIE mit den echten 2026/27-Snapshots
// vermischt oder neu berechnet, nur als fixer Zahlenblock zitiert.
// ---------------------------------------------------------------------------

import { useMemo } from 'react'
import { useData } from '../DataContext.jsx'
import { TeamBadge } from '../components/ui.jsx'
import {
  joinPredictionsWithResults, computeAccuracy, computeBrierScore, computeLogLoss,
  computeCalibration, computeFavoriteWinRate, computeUpsetRate, computeCheckpoints,
  computeCumulativeSeries, computeMAE, computeAggregateBias, computeOtSoBreakdown,
  computeCalibrationBins10, computeECE, computeRollingSeries, computeSegments,
  computeTeamStats, computeBiggestMisses, computeDrift,
} from '../predictionMetrics.js'

// Statische Referenzwerte aus dem bereits validierten historischen
// Walk-Forward-Backtest (server/scripts/backtest-preseason-h2h-result.json,
// modelD = ELO mit Pre-Season-ELO-Regression 0.25 + SOG-Allowed - exakt das
// aktuelle Produktivmodell). Nur zur Anzeige zitiert, hier nichts berechnet.
const HISTORICAL_BACKTEST_REF = {
  source: 'server/scripts/backtest-preseason-h2h-result.json (modelD)',
  seasons: '2017/18–2025/26 (ohne Corona-Saisons 2019/20, 2020/21)',
  n: 2620,
  accuracy: 0.6118320610687022,
  brier: 0.23179173452725446,
  logLoss: 0.6558231730465114,
}

function fmtPct(v) { return v == null ? '–' : (v * 100).toFixed(1) + '%' }
function fmtPp(v) { return v == null ? '–' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + ' pp' }
function fmtScore(v) { return v == null ? '–' : v.toFixed(4) }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('de-CH') : '–' }
function fmtN(n) { return n == null ? '–' : n.toLocaleString('de-CH') }

export default function ModelPerformance() {
  const { data } = useData()

  const rows = useMemo(
    () => joinPredictionsWithResults(data?.predictions || [], data?.games || []),
    [data]
  )

  const accuracy = useMemo(() => computeAccuracy(rows), [rows])
  const brier = useMemo(() => computeBrierScore(rows), [rows])
  const logLoss = useMemo(() => computeLogLoss(rows), [rows])
  const mae = useMemo(() => computeMAE(rows), [rows])
  const bias = useMemo(() => computeAggregateBias(rows), [rows])
  const otSo = useMemo(() => computeOtSoBreakdown(rows), [rows])
  const calibration = useMemo(() => computeCalibration(rows), [rows])
  const calibrationBins = useMemo(() => computeCalibrationBins10(rows), [rows])
  const ece = useMemo(() => computeECE(rows, calibrationBins), [rows, calibrationBins])
  const favoriteWinRate = useMemo(() => computeFavoriteWinRate(rows), [rows])
  const upsetRate = useMemo(() => computeUpsetRate(rows), [rows])
  const checkpoints = useMemo(() => computeCheckpoints(rows), [rows])
  const series = useMemo(() => computeCumulativeSeries(rows), [rows])
  const rollingSeries = useMemo(() => computeRollingSeries(rows, 25), [rows])
  const segments = useMemo(() => computeSegments(rows), [rows])
  const teamStats = useMemo(() => computeTeamStats(rows), [rows])
  const biggestMisses = useMemo(() => computeBiggestMisses(rows, 10), [rows])
  const drift = useMemo(() => computeDrift(rows, 25), [rows])

  const predictedCount = data?.predictions?.length || 0
  const teamById = (id) => data?.teams?.find((t) => t.id === id)

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Model Performance</h1>
          <div className="sub">{data?.settings?.seasonName || 'National League'}</div>
        </div>
      </div>

      {/* Historischer Backtest (statische Referenz) - strikt getrennt von der
          echten Saison unten, nie vermischt. */}
      <div className="section-label">Historischer Backtest (Referenz)</div>
      <div className="card card-pad mb">
        <div className="row spread" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="muted" style={{ fontSize: 12, maxWidth: 480 }}>
            Walk-Forward-Backtest auf historischen SIHF-Archivdaten ({HISTORICAL_BACKTEST_REF.seasons}),
            aktuelles Produktivmodell (ELO + Pre-Season-ELO + SOG-Allowed). Statische Referenz aus{' '}
            <code style={{ fontSize: 11 }}>{HISTORICAL_BACKTEST_REF.source}</code> - unabhängig von den
            echten 2026/27-Predictions unten berechnet.
          </div>
          <div className="stat-strip" style={{ marginBottom: 0 }}>
            <div className="stat"><strong>{fmtN(HISTORICAL_BACKTEST_REF.n)}</strong><span>Spiele</span></div>
            <div className="stat"><strong>{fmtPct(HISTORICAL_BACKTEST_REF.accuracy)}</strong><span>Accuracy</span></div>
            <div className="stat"><strong>{fmtScore(HISTORICAL_BACKTEST_REF.brier)}</strong><span>Brier</span></div>
            <div className="stat"><strong>{fmtScore(HISTORICAL_BACKTEST_REF.logLoss)}</strong><span>LogLoss</span></div>
          </div>
        </div>
      </div>

      <div className="section-label">2026/27 Real-Season Performance</div>

      <div className="stat-strip">
        <div className="stat"><strong>{predictedCount}</strong><span>Prognostizierte Spiele</span></div>
        <div className="stat"><strong>{rows.length}</strong><span>Abgeschlossene Spiele mit Prediction</span></div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <div className="title">Noch nicht genügend abgeschlossene Predictions.</div>
          <div className="hint">Sobald Spiele mit gespeichertem Pre-Game-Snapshot abgeschlossen sind, erscheint hier die Modellauswertung.</div>
        </div>
      ) : (
        <>
          {/* 1. Kennzahlen */}
          <div className="tiles mb" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div className="tile"><div className="label">Accuracy</div><div className="value mono">{fmtPct(accuracy)}</div></div>
            <div className="tile"><div className="label">Brier Score</div><div className="value mono">{fmtScore(brier)}</div></div>
            <div className="tile"><div className="label">Log Loss</div><div className="value mono">{fmtScore(logLoss)}</div></div>
            <div className="tile"><div className="label">MAE (Wahrscheinlichkeit)</div><div className="value mono">{fmtScore(mae)}</div></div>
          </div>
          <div className="tiles mb" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div className="tile"><div className="label">Favorit gewinnt</div><div className="value mono">{fmtPct(favoriteWinRate)}</div></div>
            <div className="tile"><div className="label">Upset Rate</div><div className="value mono">{fmtPct(upsetRate)}</div></div>
            <div className="tile"><div className="label">Ø vorhergesagt (Heim)</div><div className="value mono">{fmtPct(bias?.avgPredicted)}</div></div>
            <div className="tile"><div className="label">Tatsächliche Heimsiegrate</div><div className="value mono">{fmtPct(bias?.actualRate)}</div></div>
          </div>
          {bias && (
            <div className="muted mb" style={{ fontSize: 12 }}>
              Aggregierter Bias (Ø vorhergesagt − tatsächlich): <strong style={{ color: Math.abs(bias.diff) > 0.05 ? 'var(--warn)' : 'inherit' }}>{fmtPp(bias.diff)}</strong>
              {' '}· Wichtig: Brier Score und Log Loss sind aussagekräftiger als reine Accuracy - ein 51%- und ein 90%-Tipp dürfen nicht gleich bewertet werden.
            </div>
          )}

          {/* OT/SO separat */}
          <div className="section-label">REG vs. OT/SO</div>
          <div className="card mb">
            <div className="table-wrap">
              <table>
                <thead><tr><th className="left">Typ</th><th className="num">n</th><th className="num">Accuracy</th><th className="num">Brier</th><th className="num">LogLoss</th></tr></thead>
                <tbody>
                  <OtSoRow label="Reguläre Zeit" m={otSo.reg} />
                  <OtSoRow label="OT/SO gesamt" m={otSo.otso} />
                  <OtSoRow label="davon OT" m={otSo.ot} />
                  <OtSoRow label="davon SO" m={otSo.so} />
                </tbody>
              </table>
            </div>
          </div>

          {/* 2-4. Calibration Analysis (voller 0-100%-Bereich) */}
          <div className="section-label">Calibration Analysis</div>
          <div className="card card-pad mb">
            <div className="row spread mb" style={{ flexWrap: 'wrap', gap: 10 }}>
              <div className="muted" style={{ fontSize: 12.5, maxWidth: 520 }}>
                10 Bins über die rohe Heim-Wahrscheinlichkeit (0–100%): sind z.B. 60–70%-Prognosen tatsächlich
                ungefähr 60–70% Heimsiege? Bins mit weniger als 10 Spielen sind als geringe Aussagekraft markiert.
              </div>
              <div className="tile" style={{ minWidth: 160 }}>
                <div className="label">Expected Calibration Error</div>
                <div className="value mono">{fmtScore(ece)}</div>
              </div>
            </div>
            <CalibrationChart bins={calibrationBins} />
            <div className="table-wrap mt">
              <table>
                <thead>
                  <tr><th className="left">Wahrscheinlichkeit</th><th className="num">Spiele</th><th className="num">Prediction</th><th className="num">Realität</th><th className="num">Differenz</th></tr>
                </thead>
                <tbody>
                  {calibrationBins.map((b) => (
                    <tr key={b.label}>
                      <td className="left">{b.label}</td>
                      <td className="num">{b.count}{b.lowSample && b.count > 0 && <span className="muted" style={{ marginLeft: 6, fontSize: 10.5 }}>gering</span>}</td>
                      <td className="num">{fmtPct(b.avgPredicted)}</td>
                      <td className="num">{fmtPct(b.actualRate)}</td>
                      <td className="num" style={{ color: b.diff != null && Math.abs(b.diff) > 0.1 ? 'var(--warn)' : 'inherit' }}>{fmtPp(b.diff)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Favoriten-Calibration (bestehend, favoriten-gefaltet) */}
          <div className="section-label">Calibration nach Favorit</div>
          <div className="card mb">
            <div className="table-wrap">
              <table>
                <thead><tr><th className="left">Prediction</th><th className="num">Anzahl</th><th className="num">Tatsächliche Siegquote</th></tr></thead>
                <tbody>
                  {calibration.map((b) => (
                    <tr key={b.label}>
                      <td className="left">{b.label}</td>
                      <td className="num">{b.count} Spiele</td>
                      <td className="num">{b.count > 0 ? `${fmtPct(b.actualRate)} tatsächlich` : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 5. Zeitlicher Verlauf */}
          <div className="section-label">Performance über die Zeit</div>
          <div className="card card-pad mb">
            {checkpoints.length > 0 && (
              <div className="tiles mb" style={{ gridTemplateColumns: `repeat(${checkpoints.length}, 1fr)` }}>
                {checkpoints.map((c) => (
                  <div key={c.n} className="tile">
                    <div className="label">Nach {c.n} Spielen</div>
                    <div className="value mono" style={{ fontSize: 18 }}>{fmtPct(c.accuracy)}</div>
                    <div className="muted" style={{ fontSize: 10.5, marginTop: 2 }}>Brier {fmtScore(c.brier)} · LogLoss {fmtScore(c.logLoss)}</div>
                  </div>
                ))}
              </div>
            )}
            <AccuracyChart series={series} rolling={rollingSeries} />
          </div>

          {/* 6-7. Segment-Analyse */}
          <div className="section-label">Segment-Analyse</div>
          <div className="card mb">
            <div className="table-wrap">
              <table>
                <thead><tr><th className="left">Segment</th><th className="num">n</th><th className="num">Accuracy</th><th className="num">Brier</th><th className="num">LogLoss</th><th className="num">Favoriten-Gewinnrate</th></tr></thead>
                <tbody>
                  <SegmentRow label="Heimfavorit" m={segments.homeFavorite} />
                  <SegmentRow label="Auswärtsfavorit" m={segments.awayFavorite} />
                  <SegmentRow label="Enges Spiel (45–55%)" m={segments.closeGames} />
                  <SegmentRow label="Leichter Favorit (55–65%)" m={segments.lightFavorites} />
                  <SegmentRow label="Klarer Favorit (65–80%)" m={segments.clearFavorites} />
                  <SegmentRow label="Sehr klarer Favorit (>80%)" m={segments.veryClearFavorites} />
                </tbody>
              </table>
            </div>
          </div>

          {/* 8. Team-Analyse */}
          <div className="section-label">Team-Analyse</div>
          <div className="card mb">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="left">Team</th>
                    <th className="num">Heim n</th><th className="num">Heim Acc.</th><th className="num">Heim Brier</th><th className="num">Heim Ø Pred.</th><th className="num">Heim tats.</th>
                    <th className="num">Ausw. n</th><th className="num">Ausw. Acc.</th><th className="num">Ausw. Brier</th><th className="num">Ausw. Ø Pred.</th><th className="num">Ausw. tats.</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.teams || []).map((t) => {
                    const s = teamStats[t.id]
                    if (!s || (!s.home && !s.away)) return null
                    return (
                      <tr key={t.id}>
                        <td className="left"><TeamBadge team={t} /></td>
                        <TeamSplitCells s={s.home} />
                        <TeamSplitCells s={s.away} />
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="muted card-pad" style={{ fontSize: 11, paddingTop: 0 }}>„gering" = weniger als 5 Spiele, Aussagekraft entsprechend eingeschränkt.</div>
          </div>

          {/* 9. Grösste Fehler */}
          <div className="section-label">Grösste Fehlprognosen</div>
          <div className="card mb">
            <div className="table-wrap">
              <table>
                <thead><tr><th className="left">Datum</th><th className="left">Spiel</th><th className="num">Prediction (Heim)</th><th className="left">Ergebnis</th><th className="num">Brier-Beitrag</th><th className="num">LogLoss-Penalty</th></tr></thead>
                <tbody>
                  {biggestMisses.map((r) => {
                    const h = teamById(r.game.homeTeamId), a = teamById(r.game.awayTeamId)
                    const winTeam = r.homeWon ? h : a
                    return (
                      <tr key={r.prediction.gameId}>
                        <td className="left" style={{ fontSize: 12.5 }}>{fmtDate(r.game.date)}</td>
                        <td className="left">{h?.short} – {a?.short}</td>
                        <td className="num">{h?.short} {fmtPct(r.prediction.homeWinProbability)}</td>
                        <td className="left">{winTeam?.short} gewinnt{r.game.decision !== 'REG' && <span className="chip" style={{ marginLeft: 4 }}>{r.game.decision}</span>}</td>
                        <td className="num">{r.brierContribution.toFixed(4)}</td>
                        <td className="num" style={{ color: 'var(--accent)', fontWeight: 700 }}>{r.logLossPenalty.toFixed(4)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Model Drift */}
          {drift && (
            <>
              <div className="section-label">Model Drift (erste 25 vs. letzte 25 Spiele)</div>
              <div className="card mb">
                <div className="table-wrap">
                  <table>
                    <thead><tr><th className="left">Zeitraum</th><th className="num">n</th><th className="num">Accuracy</th><th className="num">Brier</th><th className="num">LogLoss</th><th className="num">Calibration Error</th></tr></thead>
                    <tbody>
                      <SegmentRow label="Erste 25 Spiele" m={drift.first} extra="calibrationError" />
                      <SegmentRow label="Letzte 25 Spiele" m={drift.last} extra="calibrationError" />
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
          {rows.length < 50 && (
            <div className="muted mb" style={{ fontSize: 11.5 }}>Model Drift wird erst ab 50 ausgewerteten Spielen angezeigt (aktuell {rows.length}).</div>
          )}

          {/* Spiel-für-Spiel */}
          <div className="section-label">Spiel für Spiel</div>
          <div className="card mb">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="left">Datum</th>
                    <th className="left">Spiel</th>
                    <th className="left">Prediction</th>
                    <th className="num">Wahrscheinlichkeit</th>
                    <th className="left">Ergebnis</th>
                    <th className="left">Korrekt?</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows].reverse().map((r) => {
                    const h = teamById(r.game.homeTeamId)
                    const a = teamById(r.game.awayTeamId)
                    const favTeam = r.favoriteIsHome ? h : a
                    const winTeam = r.homeWon ? h : a
                    return (
                      <tr key={r.prediction.gameId}>
                        <td className="left" style={{ fontSize: 12.5 }}>{fmtDate(r.game.date)}</td>
                        <td className="left">{h?.short} – {a?.short}</td>
                        <td className="left">{favTeam?.short} favorisiert</td>
                        <td className="num">{fmtPct(r.favoriteProbability)}</td>
                        <td className="left">
                          {winTeam?.short} gewinnt {r.game.decision !== 'REG' && <span className="chip" style={{ marginLeft: 4 }}>{r.game.decision}</span>}
                        </td>
                        <td className="left">
                          <span className={r.correct ? 'good' : 'bad'} style={{ fontWeight: 700 }}>{r.correct ? 'Ja' : 'Nein'}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  )
}

function OtSoRow({ label, m }) {
  if (!m) return <tr><td className="left">{label}</td><td className="num" colSpan={4}>–</td></tr>
  return (
    <tr>
      <td className="left">{label}{m.n < 10 && <span className="muted" style={{ marginLeft: 6, fontSize: 10.5 }}>n={m.n}, gering</span>}</td>
      <td className="num">{m.n}</td>
      <td className="num">{fmtPct(m.accuracy)}</td>
      <td className="num">{fmtScore(m.brier)}</td>
      <td className="num">{fmtScore(m.logLoss)}</td>
    </tr>
  )
}

function SegmentRow({ label, m, extra }) {
  if (!m) return <tr><td className="left">{label}</td><td className="num" colSpan={5}>n=0 – keine Spiele</td></tr>
  const low = m.n < 10
  return (
    <tr>
      <td className="left">{label}{low && <span className="muted" style={{ marginLeft: 6, fontSize: 10.5 }}>n={m.n} – geringe Aussagekraft</span>}</td>
      <td className="num">{m.n}</td>
      <td className="num">{fmtPct(m.accuracy)}</td>
      <td className="num">{fmtScore(m.brier)}</td>
      <td className="num">{fmtScore(m.logLoss)}</td>
      <td className="num">{extra === 'calibrationError' ? fmtScore(m.calibrationError) : fmtPct(m.favoriteWinRate)}</td>
    </tr>
  )
}

function TeamSplitCells({ s }) {
  if (!s) return <><td className="num">–</td><td className="num">–</td><td className="num">–</td><td className="num">–</td><td className="num">–</td></>
  return (
    <>
      <td className="num">{s.n}{s.lowSample && <span className="muted" style={{ marginLeft: 4, fontSize: 10 }}>gering</span>}</td>
      <td className="num">{fmtPct(s.accuracy)}</td>
      <td className="num">{fmtScore(s.brier)}</td>
      <td className="num">{fmtPct(s.avgPredicted)}</td>
      <td className="num">{fmtPct(s.actualRate)}</td>
    </>
  )
}

// Kumulative + gleitende (letzte 25) Accuracy über die Anzahl ausgewerteter
// Spiele - gleiches Muster wie EloChart in src/pages/EloRanking.jsx.
function AccuracyChart({ series, rolling }) {
  if (!series || series.length < 2) {
    return <div className="muted" style={{ fontSize: 12.5 }}>Zu wenige ausgewertete Spiele für einen Verlauf.</div>
  }

  const W = 900, H = 220, pad = { l: 40, r: 12, t: 12, b: 22 }
  const n = series.length
  const x = (i) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r)
  const y = (v) => pad.t + (1 - v) * (H - pad.t - pad.b)

  const d = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.accuracy)}`).join(' ')
  const dRolling = rolling && rolling.length === n
    ? rolling.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.accuracy)}`).join(' ')
    : null
  const yTicks = [0, 0.25, 0.5, 0.75, 1]

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 480 }}>
        {yTicks.map((tk) => (
          <g key={tk}>
            <line x1={pad.l} x2={W - pad.r} y1={y(tk)} y2={y(tk)} stroke="var(--border)" />
            <text x={pad.l - 8} y={y(tk) + 4} fontSize="11" fill="var(--text-dim)" textAnchor="end">{Math.round(tk * 100)}%</text>
          </g>
        ))}
        <line x1={pad.l} x2={W - pad.r} y1={y(0.5)} y2={y(0.5)} stroke="var(--border-strong)" strokeDasharray="4 4" />
        {dRolling && <path d={dRolling} fill="none" stroke="var(--text-faint)" strokeWidth="1.5" strokeDasharray="3 3" />}
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" />
      </svg>
      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
        Kumulative Accuracy (rot, durchgezogen) nach Anzahl ausgewerteter Spiele{dRolling ? ' · gleitender Schnitt letzte 25 Spiele (grau, gestrichelt)' : ''} · gestrichelte Linie bei 50%
      </div>
    </div>
  )
}

// Calibration Curve: X=Predicted Probability, Y=Observed Win Rate, plus
// 45°-Referenzlinie ("perfekt kalibriert"). Ein Punkt pro Bin, Grösse leicht
// nach Stichprobengrösse variiert (rein informativ, keine Spielerei).
function CalibrationChart({ bins }) {
  const withData = (bins || []).filter((b) => b.count > 0)
  if (withData.length < 2) {
    return <div className="muted" style={{ fontSize: 12.5 }}>Zu wenige besetzte Bins für eine Calibration-Kurve.</div>
  }
  const S = 380, pad = { l: 40, r: 12, t: 12, b: 28 }
  const size = S - pad.l - pad.r
  const x = (v) => pad.l + v * size
  const y = (v) => pad.t + (1 - v) * size
  const maxCount = Math.max(...withData.map((b) => b.count))

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${S} ${S}`} width="100%" style={{ maxWidth: 380 }}>
        {[0, 0.25, 0.5, 0.75, 1].map((tk) => (
          <g key={tk}>
            <line x1={x(tk)} x2={x(tk)} y1={pad.t} y2={S - pad.b} stroke="var(--border)" />
            <line x1={pad.l} x2={S - pad.r} y1={y(tk)} y2={y(tk)} stroke="var(--border)" />
            <text x={x(tk)} y={S - pad.b + 14} fontSize="10" fill="var(--text-dim)" textAnchor="middle">{Math.round(tk * 100)}%</text>
            <text x={pad.l - 6} y={y(tk) + 3} fontSize="10" fill="var(--text-dim)" textAnchor="end">{Math.round(tk * 100)}%</text>
          </g>
        ))}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--border-strong)" strokeDasharray="4 4" />
        <path
          d={withData.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(b.avgPredicted)},${y(b.actualRate)}`).join(' ')}
          fill="none" stroke="var(--accent)" strokeWidth="1.5" opacity="0.6"
        />
        {withData.map((b) => (
          <circle key={b.label} cx={x(b.avgPredicted)} cy={y(b.actualRate)} r={3 + 4 * Math.sqrt(b.count / maxCount)} fill="var(--accent)" opacity="0.85" />
        ))}
        <text x={S / 2} y={S - 4} fontSize="10.5" fill="var(--text-dim)" textAnchor="middle">Predicted Probability</text>
        <text x={-S / 2} y={12} fontSize="10.5" fill="var(--text-dim)" textAnchor="middle" transform="rotate(-90)">Observed Win Rate</text>
      </svg>
      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Gestrichelte Diagonale = perfekte Kalibrierung. Punktgrösse ∝ Stichprobengrösse des Bins.</div>
    </div>
  )
}
