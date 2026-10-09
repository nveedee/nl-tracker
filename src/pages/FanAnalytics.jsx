import { useMemo, useState } from 'react'
import { useData } from '../DataContext.jsx'
import { buildFanAnalytics } from '../fanAnalytics.js'

const nf = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 })
const oneDecimal = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 1, minimumFractionDigits: 1 })
const percent = new Intl.NumberFormat('de-CH', { style: 'percent', maximumFractionDigits: 0 })
const compactDate = new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: 'short', timeZone: 'UTC' })

function fmtCount(value) { return value == null ? '–' : nf.format(value) }
function fmtAverage(value) { return value == null ? '–' : oneDecimal.format(value) }
function fmtDate(value) {
  if (!value) return 'Datum fehlt'
  const date = new Date(`${value}T12:00:00Z`)
  return !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? 'Datum fehlt'
    : compactDate.format(date)
}

function PageTitle({ note, season }) {
  return (
    <div className="page-head fan-page-head">
      <div>
        <div className="fan-eyebrow"><span className="fan-eyebrow-dot" /> CROWD REPORT · {season}</div>
        <h1>Fan Analytics</h1>
        <div className="sub">Publikumsinteresse im Kontext von Spieltag, Heimteam und sportlichem Verlauf.</div>
      </div>
      <div className="fan-title-note"><strong>{note}</strong><span>Nur erfasste Zuschauerzahlen</span></div>
    </div>
  )
}

function StatCard({ label, value, detail, accent = false }) {
  return (
    <div className={`fan-stat-card${accent ? ' is-accent' : ''}`}>
      <div className="fan-stat-label">{label}</div>
      <div className="fan-stat-value">{value}</div>
      <div className="fan-stat-detail">{detail}</div>
    </div>
  )
}

function CardHeader({ eyebrow, title, detail, right }) {
  return (
    <div className="fan-card-head">
      <div>
        {eyebrow && <div className="fan-card-eyebrow">{eyebrow}</div>}
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
      </div>
      {right && <div className="fan-card-right">{right}</div>}
    </div>
  )
}

function EmptyChart({ title, detail }) {
  return <div className="fan-empty"><span className="fan-empty-mark">—</span><strong>{title}</strong><span>{detail}</span></div>
}

function AttendanceTrend({ rows, average }) {
  if (!rows.length) return <EmptyChart title="Noch keine Zuschauerwerte" detail="Für diese Auswahl liegen keine echten Werte in game.attendance vor." />
  const width = 900, height = 280
  const pad = { left: 58, right: 20, top: 24, bottom: 42 }
  const maxValue = Math.max(...rows.map((row) => row.average), average || 0, 1000)
  const ceiling = Math.ceil(maxValue / 2000) * 2000
  const x = (index) => rows.length < 2 ? (width - pad.left - pad.right) / 2 + pad.left : pad.left + index * (width - pad.left - pad.right) / (rows.length - 1)
  const y = (value) => height - pad.bottom - (value / ceiling) * (height - pad.top - pad.bottom)
  const points = rows.map((row, index) => `${x(index)},${y(row.average)}`).join(' ')
  const area = `${pad.left},${height - pad.bottom} ${points} ${x(rows.length - 1)},${height - pad.bottom}`
  const tickValues = [0, ceiling / 2, ceiling]
  const labelIndexes = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])]
  return (
    <div className="fan-svg-scroll">
      <svg className="fan-trend-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Durchschnittliche Zuschauerzahl pro Spieltag">
        <defs><linearGradient id="fanTrendFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".2" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
        {tickValues.map((tick) => <g key={tick}>
          <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} className="fan-grid-line" />
          <text x={pad.left - 10} y={y(tick) + 4} textAnchor="end" className="fan-axis-label">{fmtCount(tick)}</text>
        </g>)}
        <text x="13" y={(pad.top + height - pad.bottom) / 2} transform={`rotate(-90 13 ${(pad.top + height - pad.bottom) / 2})`} textAnchor="middle" className="fan-axis-label">Zuschauer</text>
        {average != null && <>
          <line x1={pad.left} x2={width - pad.right} y1={y(average)} y2={y(average)} className="fan-average-line" />
          <text x={width - pad.right - 2} y={y(average) - 7} textAnchor="end" className="fan-average-label">Schnitt {fmtCount(average)}</text>
        </>}
        {rows.length > 1 && <polygon points={area} fill="url(#fanTrendFill)" />}
        {rows.length > 1 && <polyline points={points} className="fan-trend-line" />}
        {rows.map((row, index) => <g key={row.key}>
          <circle cx={x(index)} cy={y(row.average)} r="4" className="fan-trend-point"><title>{`${row.label}: ${fmtCount(row.average)} im Schnitt, ${row.games} ${row.games === 1 ? 'Spiel' : 'Spiele'}`}</title></circle>
        </g>)}
        {labelIndexes.map((index) => <text key={index} x={x(index)} y={height - 14} textAnchor={index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle'} className="fan-axis-label">{fmtDate(rows[index].key)}</text>)}
      </svg>
      <div className="fan-chart-caption"><span><i className="fan-legend-dot" /> Tagesdurchschnitt</span><span>Punktgrösse konstant · Stichprobe pro Tag im Tooltip</span></div>
    </div>
  )
}

function MiniBars({ title, detail, rows, emptyText, selectedKey, onSelect }) {
  const max = Math.max(...rows.map((row) => row.average || 0), 1)
  return (
    <section className="fan-mini-chart">
      <div className="fan-mini-head"><h3>{title}</h3><span>{detail}</span></div>
      {!rows.length ? <EmptyChart title={emptyText} detail="Keine erfassten Werte für die aktuelle Auswahl." /> : (
        <div className="fan-bars">
          {rows.map((row) => {
            const active = selectedKey != null && String(selectedKey) === String(row.key)
            const content = <>
              <span className="fan-bar-label">{row.label}</span>
              <span className="fan-bar-track"><i style={{ width: `${Math.max(3, (row.average / max) * 100)}%` }} /></span>
              <strong className="fan-bar-value">{fmtAverage(row.average)}</strong>
              <span className="fan-bar-n">n={row.games}</span>
            </>
            return onSelect
              ? <button type="button" className={`fan-bar-row${active ? ' active' : ''}`} key={row.key} onClick={() => onSelect(active ? '' : String(row.key))} aria-pressed={active}>{content}</button>
              : <div className="fan-bar-row" key={row.key}>{content}</div>
          })}
        </div>
      )}
    </section>
  )
}

function TeamComparison({ rows, selectedTeamId, onSelect }) {
  const max = Math.max(...rows.map((row) => row.average || 0), 1)
  const ordered = [...rows].sort((a, b) => (b.average ?? -1) - (a.average ?? -1))
  if (!ordered.some((row) => row.recorded)) return <EmptyChart title="Noch kein Team mit Messwerten" detail="Erfasste Heimspiele erscheinen hier, sobald Zuschauerzahlen vorliegen." />
  return (
    <div className="fan-team-bars">
      {ordered.map((row) => (
        <button type="button" key={row.team.id} className={`fan-team-row${selectedTeamId === row.team.id ? ' selected' : ''}`} onClick={() => onSelect(selectedTeamId === row.team.id ? '' : row.team.id)} aria-pressed={selectedTeamId === row.team.id}>
          <span className="fan-team-name"><i style={{ background: row.team.color || 'var(--accent)' }} />{row.team.short || row.team.name}</span>
          <span className="fan-team-track"><i style={{ width: `${row.average == null ? 0 : (row.average / max) * 100}%`, background: row.team.color || 'var(--accent)' }} /></span>
          <strong>{fmtAverage(row.average)}</strong>
          <span className="fan-team-sample">{row.recorded}/{row.games} · {row.coverage == null ? '–' : percent.format(row.coverage)}</span>
        </button>
      ))}
      <div className="fan-chart-caption">Ø Zuschauer pro Heimspiel · n erfasst / Heimspiele · Abdeckung</div>
    </div>
  )
}

function FormScatter({ points, correlation }) {
  if (!points.length) return <EmptyChart title="Noch keine Form-Vorgeschichte" detail="Für diese Spiele sind keine früheren Resultate des betrachteten Teams vorhanden." />
  const width = 620, height = 258
  const pad = { left: 52, right: 16, top: 18, bottom: 42 }
  const maxAttendance = Math.max(...points.map((point) => point.y), 1000)
  const ceiling = Math.ceil(maxAttendance / 2000) * 2000
  const x = (value) => pad.left + (value / 3) * (width - pad.left - pad.right)
  const y = (value) => height - pad.bottom - (value / ceiling) * (height - pad.top - pad.bottom)
  return (
    <div className="fan-svg-scroll">
      <svg className="fan-scatter-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Zuschauerzahl im Vergleich zur Punkteform vor dem Spiel">
        {[0, 1, 2, 3].map((tick) => <g key={tick}><line x1={pad.left} x2={width - pad.right} y1={y(tick * ceiling / 3)} y2={y(tick * ceiling / 3)} className="fan-grid-line" /><text x={pad.left - 8} y={y(tick * ceiling / 3) + 4} textAnchor="end" className="fan-axis-label">{fmtCount(tick * ceiling / 3)}</text></g>)}
        <text x="12" y={(pad.top + height - pad.bottom) / 2} transform={`rotate(-90 12 ${(pad.top + height - pad.bottom) / 2})`} textAnchor="middle" className="fan-axis-label">Zuschauer</text>
        {[0, 1, 2, 3].map((tick) => <g key={tick}><line x1={x(tick)} x2={x(tick)} y1={pad.top} y2={height - pad.bottom} className="fan-grid-line vertical" /><text x={x(tick)} y={height - 13} textAnchor="middle" className="fan-axis-label">{tick} Pkt./Sp.</text></g>)}
        {points.map((point) => <circle key={point.game.id} cx={x(point.x)} cy={y(point.y)} r="5" fill={point.team?.color || 'var(--accent)'} className="fan-scatter-point"><title>{`${point.game.date} · ${point.team?.short || 'Team'} · ${fmtCount(point.y)} Zuschauer · Form ${fmtAverage(point.x)} Punkte/Spiel aus ${point.priorGames} vorherigen Spielen`}</title></circle>)}
      </svg>
      <div className="fan-correlation">Pearson r {correlation == null ? 'nicht berechenbar' : oneDecimal.format(correlation)} <span>·</span> n={points.length}</div>
    </div>
  )
}

function RankScatter({ rows }) {
  if (rows.length < 4) return <EmptyChart title="Zu wenig Teamdaten für den Querschnitt" detail={`Benötigt mindestens vier Teams mit Heim-Zuschauerschnitt; vorhanden: ${rows.length}.`} />
  const width = 560, height = 252
  const pad = { left: 56, right: 18, top: 18, bottom: 42 }
  const maxRank = Math.max(...rows.map((row) => row.rank), 1)
  const maxAttendance = Math.max(...rows.map((row) => row.average), 1000)
  const ceiling = Math.ceil(maxAttendance / 2000) * 2000
  const x = (rank) => pad.left + ((rank - 1) / Math.max(1, maxRank - 1)) * (width - pad.left - pad.right)
  const y = (value) => height - pad.bottom - (value / ceiling) * (height - pad.top - pad.bottom)
  return (
    <div className="fan-svg-scroll">
      <svg className="fan-rank-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Aktuelle Tabellenposition und durchschnittliche Zuschauerzahl bei Heimspielen">
        {[0, 0.5, 1].map((fraction) => <g key={fraction}><line x1={pad.left} x2={width - pad.right} y1={y(ceiling * fraction)} y2={y(ceiling * fraction)} className="fan-grid-line" /><text x={pad.left - 8} y={y(ceiling * fraction) + 4} textAnchor="end" className="fan-axis-label">{fmtCount(ceiling * fraction)}</text></g>)}
        <text x="13" y={(pad.top + height - pad.bottom) / 2} transform={`rotate(-90 13 ${(pad.top + height - pad.bottom) / 2})`} textAnchor="middle" className="fan-axis-label">Ø Zuschauer</text>
        {[1, Math.round(maxRank / 2), maxRank].map((rank, index) => <text key={`${rank}-${index}`} x={x(rank)} y={height - 13} textAnchor="middle" className="fan-axis-label">Rang {rank}</text>)}
        {rows.map((row) => <g key={row.team.id}><circle cx={x(row.rank)} cy={y(row.average)} r="6" fill={row.team.color || 'var(--accent)'} className="fan-scatter-point"><title>{`Rang ${row.rank} · ${row.team.name} · Ø ${fmtCount(row.average)} · n=${row.recorded}/${row.games}`}</title></circle><text x={x(row.rank)} y={y(row.average) - 10} textAnchor="middle" className="fan-rank-team-label">{row.team.short}</text></g>)}
      </svg>
    </div>
  )
}

function Highlight({ label, game, teamById }) {
  if (!game) return <div className="fan-highlight"><span>{label}</span><strong>–</strong><small>Keine Werte im Filter</small></div>
  const home = teamById.get(game.homeTeamId)
  const away = teamById.get(game.awayTeamId)
  return <div className="fan-highlight">
    <span>{label}</span><strong>{fmtCount(game.attendance)}</strong>
    <small>{fmtDate(game.date)} · {home?.short || 'Heim'} {game.homeGoals}–{game.awayGoals} {away?.short || 'Gast'}</small>
  </div>
}

export default function FanAnalytics() {
  const { data, derived } = useData()
  const finals = useMemo(() => (data?.games || []).filter((game) => game.status === 'final' && game.homeGoals != null && game.awayGoals != null), [data?.games])
  const bounds = useMemo(() => {
    const dates = finals.map((game) => game.date).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort()
    return { min: dates[0] || '', max: dates[dates.length - 1] || '' }
  }, [finals])
  const [teamId, setTeamId] = useState('')
  const [venuePerspective, setVenuePerspective] = useState('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [weekday, setWeekday] = useState('')

  const analytics = useMemo(() => buildFanAnalytics({
    games: data?.games || [],
    teams: data?.teams || [],
    standings: derived?.standings || [],
    filters: { teamId, venuePerspective: teamId ? venuePerspective : 'all', from, to, weekday },
  }), [data?.games, data?.teams, derived?.standings, teamId, venuePerspective, from, to, weekday])

  const teamById = useMemo(() => new Map((data?.teams || []).map((team) => [team.id, team])), [data?.teams])
  const selectedTeam = teamById.get(teamId)
  const perspectiveText = !selectedTeam
    ? 'Alle Arenen; Besucherzahlen werden dem Heimteam zugeordnet.'
    : venuePerspective === 'away'
      ? `${selectedTeam.name} auswärts – attendance bleibt der Heim-Arena des Gegners zugeordnet.`
      : venuePerspective === 'home'
        ? `${selectedTeam.name} als Gastgeber; Zuschauerzahl der eigenen Heim-Arena.`
        : `${selectedTeam.name} Heim- und Auswärtsspiele; venue attendance bleibt der jeweiligen Heim-Arena zugeordnet.`

  const resetFilters = () => { setTeamId(''); setVenuePerspective('all'); setFrom(''); setTo(''); setWeekday('') }
  const activeFilters = Boolean(teamId || from || to || weekday !== '')
  const hasFinals = finals.length > 0

  return (
    <div className="fan-page">
      <PageTitle season={data?.settings?.seasonName || 'Saison'} note={`${fmtCount(analytics.observedGames.length)} / ${fmtCount(analytics.finalGames.length)} Spiele erfasst`} />

      <section className="fan-filter-card" aria-label="Analysen filtern">
        <div className="fan-filter-heading"><span>Ansicht eingrenzen</span>{activeFilters && <button type="button" className="fan-reset" onClick={resetFilters}>Filter zurücksetzen</button>}</div>
        <div className="fan-filters">
          <label><span>Team</span><select value={teamId} onChange={(event) => { setTeamId(event.target.value); setVenuePerspective('all') }}><option value="">Alle Teams</option>{(data?.teams || []).slice().sort((a, b) => a.name.localeCompare(b.name)).map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
          <label><span>Betrachtung</span><select value={venuePerspective} onChange={(event) => setVenuePerspective(event.target.value)} disabled={!teamId}><option value="all">Heim &amp; auswärts</option><option value="home">Heimspiele</option><option value="away">Auswärtsspiele</option></select></label>
          <label><span>Von</span><input type="date" value={from} min={bounds.min} max={to || bounds.max} onChange={(event) => setFrom(event.target.value)} /></label>
          <label><span>Bis</span><input type="date" value={to} min={from || bounds.min} max={bounds.max} onChange={(event) => setTo(event.target.value)} /></label>
          <label><span>Wochentag</span><select value={weekday} onChange={(event) => setWeekday(event.target.value)}><option value="">Alle Tage</option>{analytics.weekDays.map((day) => <option key={day.id} value={day.id}>{day.label}</option>)}</select></label>
        </div>
        <div className="fan-perspective-note"><span className="fan-note-icon">i</span>{perspectiveText}</div>
      </section>

      {!hasFinals ? <div className="empty fan-page-empty"><div className="title">Noch keine abgeschlossenen Spiele</div><div>Fan Analytics wird angezeigt, sobald Resultate vorliegen.</div></div> : analytics.finalGames.length === 0 ? <div className="empty fan-page-empty"><div className="title">Keine Spiele in dieser Auswahl</div><div>Ändere Zeitraum, Wochentag oder Teamfilter.</div></div> : analytics.observedGames.length === 0 ? <div className="empty fan-page-empty"><div className="title">Für diese Spiele fehlen Zuschauerzahlen</div><div>Es werden keine Werte geschätzt. Wähle einen anderen Zeitraum oder ein anderes Team.</div></div> : <>
        <section className="fan-stats" aria-label="Kennzahlen zur aktuellen Auswahl">
          <StatCard label="Zuschauer im Ausschnitt" value={fmtCount(analytics.totalAttendance)} detail={`${analytics.observedGames.length} Spiele mit echtem Wert`} accent />
          <StatCard label="Schnitt pro Spiel" value={fmtAverage(analytics.average)} detail={`Abdeckung ${analytics.coverage == null ? '–' : percent.format(analytics.coverage)} · ${analytics.missingAttendance} ohne Wert`} />
          <StatCard label="Höchster Besuch" value={fmtCount(analytics.highest?.attendance)} detail={analytics.highest ? `${fmtDate(analytics.highest.date)} · ${teamById.get(analytics.highest.homeTeamId)?.short || 'Heim'}` : '–'} />
          <StatCard label="Niedrigster Besuch" value={fmtCount(analytics.lowest?.attendance)} detail={analytics.lowest ? `${fmtDate(analytics.lowest.date)} · ${teamById.get(analytics.lowest.homeTeamId)?.short || 'Heim'}` : '–'} />
        </section>

        <section className="fan-grid fan-grid-main">
          <article className="card fan-card fan-trend-card">
            <CardHeader eyebrow="SAISONVERLAUF" title="Publikum pro Spieltag" detail="Tagesmittel aus den vorhandenen Heimspiel-Zuschauerzahlen. Tage mit mehreren Spielen werden zusammengefasst." right={<span className="fan-period-tag">{fmtDate(from || bounds.min)} — {fmtDate(to || bounds.max)}</span>} />
            <AttendanceTrend rows={analytics.dailyRows} average={analytics.average} />
          </article>
          <article className="card fan-card fan-extremes-card">
            <CardHeader eyebrow="SPIELHIGHLIGHTS" title="Besuch im Ausschnitt" detail="Extreme basieren nur auf echten Zuschauerwerten." />
            <div className="fan-highlights"><Highlight label="GRÖSSTER BESUCH" game={analytics.highest} teamById={teamById} /><Highlight label="KLEINSTER BESUCH" game={analytics.lowest} teamById={teamById} /></div>
            <div className="fan-sample-note"><strong>{analytics.observedGames.length} Spiele</strong><span>in der aktuellen Auswahl · keine Hochrechnung auf nicht erfasste Spiele</span></div>
          </article>
        </section>

        <section className="fan-grid fan-grid-secondary">
          <article className="card fan-card">
            <CardHeader eyebrow="HEIMARENEN" title="Zuschauerschnitt nach Team" detail="Durchschnitt nur an Heimspielen des jeweiligen Clubs. Klick auf ein Team setzt den Teamfilter." right={<span className="fan-period-tag">{analytics.teamRows.reduce((sum, row) => sum + row.recorded, 0)} erfasste Teamspiele</span>} />
            <TeamComparison rows={analytics.teamRows} selectedTeamId={teamId} onSelect={(id) => { setTeamId(id); setVenuePerspective('all') }} />
          </article>
          <article className="card fan-card">
            <CardHeader eyebrow="SPIELPLAN" title="Wann kommen die Fans?" detail="Tages- und Anspielzeitmittel; n zeigt die Anzahl erfasster Partien." />
            <div className="fan-mini-grid">
              <MiniBars title="Wochentag" detail="Ø Zuschauer" rows={analytics.weekdayRows} selectedKey={weekday} onSelect={setWeekday} emptyText="Keine Wochentage" />
              <MiniBars title="Anspielzeit" detail="Ø Zuschauer" rows={analytics.kickoffRows} emptyText="Keine Zeitangaben" />
            </div>
          </article>
        </section>

        <section className="fan-grid fan-grid-secondary">
          <article className="card fan-card">
            <CardHeader eyebrow="SPORTLICHER KONTEXT" title="Form vor dem Spiel und Besuch" detail={`Punkte pro Spiel aus bis zu fünf vorherigen Resultaten von ${selectedTeam ? selectedTeam.name : 'jeweils dem Heimteam'}.`} right={<span className="fan-period-tag">r {analytics.formCorrelation == null ? '–' : oneDecimal.format(analytics.formCorrelation)} · n {analytics.formPoints.length}</span>} />
            <FormScatter points={analytics.formPoints} correlation={analytics.formCorrelation} />
            <div className="fan-outcome-list">
              <div className="fan-outcome-head"><strong>Ø nach Resultat</strong><span>Gewähltes Team, sonst Heimteam · Stichprobe</span></div>
              {analytics.outcomeRows.map((row) => <div className="fan-outcome-row" key={row.key}><span>{row.label}</span><strong>{fmtAverage(row.average)}</strong><small>n={row.games}</small></div>)}
            </div>
            <p className="fan-caveat">Deskriptiver Zusammenhang, keine Aussage über Ursache und Wirkung. Frühe Saisonphase und kleine Stichproben schränken die Aussagekraft ein.</p>
          </article>
          <article className="card fan-card">
            <CardHeader eyebrow="TABELLENQUERSCHNITT" title="Rang und Heim-Publikum" detail="Aktuelle lokale Tabellenposition im Vergleich zum Heim-Zuschauerschnitt der Saison." right={<span className="fan-period-tag">{analytics.rankAttendance.length} Teams</span>} />
            <RankScatter rows={analytics.rankAttendance} />
            <p className="fan-caveat">Die Daten enthalten keine historische Tabelle pro Spieltag. Gezeigt wird daher ein aktueller Querschnitt, keine gemeinsame Zeitentwicklung und keine Kausalität.</p>
          </article>
        </section>

        {analytics.missingAttendance > 0 && <div className="fan-missing-banner"><strong>{analytics.missingAttendance} Spiel(e) ohne Zuschauerwert</strong><span>Diese Partien fehlen in Durchschnitt und Diagrammen. Es wird nichts geschätzt.</span></div>}
      </>}
      <div className="fan-footer">Quelle: game.attendance · offizielle Zuschauerangabe je Spiel · Schweizer Zahlenformat</div>
    </div>
  )
}
