import { useMemo, useState } from 'react'
import { useData } from '../DataContext.jsx'
import { buildArenaUtilization, buildFanAnalytics, summarizeSelectedUtilization, weekdayForDate } from '../fanAnalytics.js'

const nf = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 })
const oneDecimal = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 1, minimumFractionDigits: 1 })
const percent = new Intl.NumberFormat('de-CH', { style: 'percent', maximumFractionDigits: 0 })
const compactDate = new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: 'short', timeZone: 'UTC' })

function fmtCount(value) { return value == null ? '–' : nf.format(value) }
function fmtAverage(value) { return value == null ? '–' : oneDecimal.format(value) }
function fmtUtilization(value) { return value == null ? '—' : `${oneDecimal.format(value)}%` }

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

function TeamComparison({ analysis, selectedTeamId, standings, onSelect }) {
  const [rankMode, setRankMode] = useState('utilization')
  const isUtilization = rankMode === 'utilization'
  const ranked = isUtilization ? analysis.ranking : analysis.attendanceRanking
  const rankedIds = new Set(ranked.map((row) => row.team.id))
  const ordered = [...ranked, ...analysis.rows.filter((row) => !rankedIds.has(row.team.id))
    .sort((a, b) => a.team.name.localeCompare(b.team.name))]
  const valueFor = (row) => isUtilization ? row.averageUtilization : row.averageAttendance
  const max = Math.max(...ordered.map((row) => valueFor(row) || 0), 1)
  const tableRankById = new Map((standings || []).map((row, index) => [row.team?.id || row.id, index + 1]))
  if (!ordered.length) return <EmptyChart title="Noch kein Team mit Messwerten" detail="Erfasste Heimspiele erscheinen hier, sobald Zuschauerzahlen vorliegen." />
  return (
    <div className="fan-arena-ranking">
      <div className="fan-ranking-toggle" role="group" aria-label="Ranking sortieren nach">
        <button type="button" className={isUtilization ? 'active' : ''} aria-pressed={isUtilization} onClick={() => setRankMode('utilization')}>Auslastung</button>
        <button type="button" className={!isUtilization ? 'active' : ''} aria-pressed={!isUtilization} onClick={() => setRankMode('attendance')}>Zuschauerschnitt</button>
      </div>
      <div className="fan-team-bars">
        {ordered.map((row) => {
          const value = valueFor(row)
          const unresolved = row.capacityConfidence === 'unverified'
          const sampleSize = isUtilization ? row.utilizationGames : row.attendanceGames
          const tableRank = tableRankById.get(row.team.id)
          const title = `${row.arena || row.team.name} · Quelle: ${row.capacitySource || 'keine'} · geprüft am ${row.capacityCheckedAt || 'unbekannt'}${row.capacityConfidence === 'provisional' ? ' · Kapazität vorläufig' : ''}`
          return <button type="button" key={row.team.id} title={title} className={`fan-team-row fan-arena-team-row${selectedTeamId === row.team.id ? ' selected' : ''}`} onClick={() => onSelect(selectedTeamId === row.team.id ? '' : row.team.id)} aria-pressed={selectedTeamId === row.team.id}>
            <span className="fan-team-name"><i style={{ background: row.team.color || 'var(--accent)' }} />{row.team.short || row.team.name}</span>
            <span className="fan-team-track"><i style={{ width: `${value == null ? 0 : (value / max) * 100}%`, background: row.team.color || 'var(--accent)' }} /></span>
            <strong>{isUtilization ? fmtUtilization(value) : fmtAverage(value)}</strong>
            <span className="fan-team-sample">{row.coverage == null ? 'n=0' : `${row.attendanceGames}/${row.completedHomeGames} · ${percent.format(row.coverage)}`}</span>
            <span className="fan-arena-status">
              {row.state === 'no-home-games-yet' && <span className="fan-status-badge">Noch keine Heimspiele{row.upcomingHomeGames ? ` · ${row.upcomingHomeGames} geplant` : ''}</span>}
              {unresolved && <span className="fan-status-badge is-warning">Kapazität ungeklärt</span>}
              {isUtilization && row.capacityConfidence === 'provisional' && <span className="fan-status-badge">Kapazität vorläufig</span>}
              {sampleSize > 0 && <span className="fan-status-badge">{sampleSize < analysis.preliminarySampleSize ? 'Vorläufig · ' : ''}n={sampleSize}</span>}
              {tableRank != null && <span className="fan-status-badge">Tabellenplatz #{tableRank}</span>}
            </span>
          </button>
        })}
      </div>
      <div className="fan-chart-caption">{isUtilization ? 'Ø der einzelnen Heimspiel-Auslastungen · Stichprobe und Datenabdeckung' : 'Ø Zuschauer pro Heimspiel · Stichprobe und Datenabdeckung'}</div>
      <details className="fan-capacity-sources">
        <summary>Kapazitätsquellen und Prüfdatum</summary>
        <ul>{analysis.rows.map((row) => <li key={row.team.id}>
          <strong>{row.team.name} · {row.arena || 'Arena nicht zugeordnet'}</strong>
          <span>{row.capacityPeriods.length === 0 ? 'Kapazität ungeklärt' : row.capacityPeriods.map((period) => `${nf.format(period.capacity)} Plätze (${period.validFrom}–${period.validTo})`).join(' · ')}</span>
          <span>Geprüft am {row.capacityCheckedAt || 'unbekannt'} · {row.capacityConfidence === 'unverified' ? 'ungeprüft' : 'vorläufig'}</span>
          {row.capacityNote && <span>{row.capacityNote}</span>}
          {row.capacityConflicts.length > 0 && <span className="fan-capacity-conflict-note">Mögliche Kapazitäts- oder Datenkonflikte: {row.capacityConflicts.map((entry) => `${fmtDate(entry.game.date)} · ${fmtUtilization(entry.utilization)}`).join(' · ')}</span>}
          {row.capacitySource && <a href={row.capacitySource} target="_blank" rel="noreferrer">Quelle öffnen</a>}
        </li>)}</ul>
      </details>
    </div>
  )
}

function FormScatter({ points, correlation, teamById }) {
  if (!points.length) return <EmptyChart title="Noch keine Form-Vorgeschichte" detail="Für diese Spiele sind keine früheren Resultate des betrachteten Teams vorhanden." />
  const width = 720, height = 292
  const pad = { left: 62, right: 18, top: 18, bottom: 48 }
  const maxAttendance = Math.max(...points.map((point) => point.y), 1000)
  const ceiling = Math.ceil(maxAttendance / 2000) * 2000
  const x = (value) => pad.left + (value / 3) * (width - pad.left - pad.right)
  const y = (value) => height - pad.bottom - (value / ceiling) * (height - pad.top - pad.bottom)
  const teams = [...new Map(points.filter((point) => point.team).map((point) => [point.team.id, point.team])).values()]
  return (
    <div className="fan-form-chart">
      <div className="fan-chart-meta"><span>Explorativ · Pearson r <strong>{correlation == null ? '–' : oneDecimal.format(correlation)}</strong></span><i /><span>n={points.length}{points.length < 30 ? ' · kleine Stichprobe' : ''}</span></div>
      <div className="fan-svg-scroll">
        <svg className="fan-scatter-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Zuschauerzahl im Vergleich zur Punkteform vor dem Spiel">
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => <g key={fraction}><line x1={pad.left} x2={width - pad.right} y1={y(ceiling * fraction)} y2={y(ceiling * fraction)} className="fan-grid-line" /><text x={pad.left - 9} y={y(ceiling * fraction) + 4} textAnchor="end" className="fan-axis-label">{fmtCount(ceiling * fraction)}</text></g>)}
          <text x="14" y={(pad.top + height - pad.bottom) / 2} transform={`rotate(-90 14 ${(pad.top + height - pad.bottom) / 2})`} textAnchor="middle" className="fan-axis-label">Zuschauer</text>
          {[0, 1, 2, 3].map((tick) => <g key={tick}><text x={x(tick)} y={height - 25} textAnchor="middle" className="fan-axis-label">{tick}</text></g>)}
          <text x={(pad.left + width - pad.right) / 2} y={height - 5} textAnchor="middle" className="fan-axis-title">Punkte pro Spiel vor der Partie (bis zu 5 Spiele)</text>
          {points.map((point) => {
            const home = teamById.get(point.game.homeTeamId)?.name || 'Heimteam'
            const away = teamById.get(point.game.awayTeamId)?.name || 'Auswärtsteam'
            const matchup = `${home} ${point.game.homeGoals}–${point.game.awayGoals} ${away}`
            const tooltip = `${point.game.date} · ${point.team?.name || 'Team'} · ${matchup} · ${fmtCount(point.y)} Zuschauer · Form ${fmtAverage(point.x)} Punkte/Spiel aus ${point.priorGames} vorherigen Spielen`
            return <circle key={point.game.id} cx={x(point.x)} cy={y(point.y)} r="4.5" fill={point.team?.color || 'var(--accent)'} className="fan-scatter-point"><title>{tooltip}</title></circle>
          })}
        </svg>
      </div>
      <div className="fan-form-legend" aria-label="Teams im Diagramm">
        {teams.map((team) => <span key={team.id}><i style={{ background: team.color || 'var(--accent)' }} />{team.short || team.name}</span>)}
      </div>
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

  const arenaGames = useMemo(() => {
    const scheduledGames = (data?.games || []).filter((game) => {
      if (game.status !== 'scheduled' || weekdayForDate(game.date) == null) return false
      if (from && game.date < from) return false
      if (to && game.date > to) return false
      if (weekday !== '' && weekdayForDate(game.date) !== Number(weekday)) return false
      return true
    })
    return [...analytics.calendarGames, ...scheduledGames]
  }, [data?.games, analytics.calendarGames, from, to, weekday])

  const arenaUtilization = useMemo(() => buildArenaUtilization({
    games: arenaGames,
    teams: data?.teams || [],
  }), [arenaGames, data?.teams])

  const selectedUtilization = useMemo(() => summarizeSelectedUtilization(analytics.observedGames), [analytics.observedGames])

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
  const formCorrelationIsWeak = analytics.formCorrelation != null && Math.abs(analytics.formCorrelation) < 0.3
  const formInterpretation = formCorrelationIsWeak
    ? 'In diesen Spielen ist kein klarer linearer Zusammenhang erkennbar.'
    : 'Der beobachtete Zusammenhang ist explorativ und keine Aussage über Ursache und Wirkung.'

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

      {!hasFinals
        ? <div className="empty fan-page-empty"><div className="title">Noch keine abgeschlossenen Spiele</div><div>Fan Analytics wird angezeigt, sobald Resultate vorliegen.</div></div>
        : analytics.finalGames.length === 0
          ? <div className="empty fan-page-empty"><div className="title">Keine Spiele in dieser Auswahl</div><div>Ändere Zeitraum, Wochentag oder Teamfilter.</div></div>
          : analytics.observedGames.length === 0
            ? <div className="empty fan-page-empty"><div className="title">Für diese Spiele fehlen Zuschauerzahlen</div><div>Es werden keine Werte geschätzt. Wähle einen anderen Zeitraum oder ein anderes Team.</div></div>
            : null}

      {analytics.observedGames.length > 0 && <>
        <section className="fan-stats" aria-label="Kennzahlen zur aktuellen Auswahl">
          <StatCard label="Zuschauer im Ausschnitt" value={fmtCount(analytics.totalAttendance)} detail={`${analytics.observedGames.length} Spiele mit echtem Wert`} accent />
          <StatCard label="Schnitt pro Spiel" value={fmtAverage(analytics.average)} detail={`Abdeckung ${analytics.coverage == null ? '–' : percent.format(analytics.coverage)} · ${analytics.missingAttendance} ohne Wert`} />
          <StatCard label="Ø Stadionauslastung" value={fmtUtilization(selectedUtilization.average)} detail={`Vorläufig · n=${selectedUtilization.games} in der Auswahl · ${selectedUtilization.withoutCapacity} ohne Kapazität · ${analytics.missingAttendance} ohne Zuschauerwert${selectedUtilization.conflicts.length ? ` · ${selectedUtilization.conflicts.length} mögliche Konflikte` : ''}`} />
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
            <CardHeader eyebrow="SPIELPLAN" title="Wann kommen die Fans?" detail="Tages- und Anspielzeitmittel; n zeigt die Anzahl erfasster Partien." />
            <div className="fan-mini-grid">
              <MiniBars title="Wochentag" detail="Ø Zuschauer" rows={analytics.weekdayRows} selectedKey={weekday} onSelect={setWeekday} emptyText="Keine Wochentage" />
              <MiniBars title="Anspielzeit" detail="Ø Zuschauer" rows={analytics.kickoffRows} emptyText="Keine Zeitangaben" />
            </div>
          </article>
        </section>

        <section className="fan-grid fan-grid-secondary">
          <article className="card fan-card">
            <CardHeader eyebrow="SPORTLICHER KONTEXT" title="Form vor dem Spiel und Besuch" detail={`Explorative Gegenüberstellung mit bis zu fünf vorherigen Resultaten von ${selectedTeam ? selectedTeam.name : 'jeweils dem Heimteam'}.`} />
            <FormScatter points={analytics.formPoints} correlation={analytics.formCorrelation} teamById={teamById} />
            <p className="fan-form-interpretation">{formInterpretation}{analytics.formPoints.length < 30 ? ' Kleine Stichprobe; bitte vorsichtig einordnen.' : ''}</p>
            <div className="fan-outcome-list">
              <div className="fan-outcome-head"><strong>Ø nach Resultat</strong><span>Gewähltes Team, sonst Heimteam · Stichprobe</span></div>
              <div className="fan-outcome-grid">{analytics.outcomeRows.map((row) => <div className="fan-outcome-row" key={row.key}><span>{row.label}</span><strong>{fmtAverage(row.average)}</strong><small>n={row.games}</small></div>)}</div>
            </div>
            <details className="fan-methodology"><summary>Methodik und Einschränkungen</summary><p>Die Form nutzt bis zu fünf vorherige Resultate. Pearson r beschreibt nur einen linearen Zusammenhang; mehrere Spiele desselben Teams sind nicht unabhängig. Eine Kausalität lässt sich daraus nicht ableiten.</p></details>
          </article>
        </section>

        {analytics.missingAttendance > 0 && <div className="fan-missing-banner"><strong>{analytics.missingAttendance} Spiel(e) ohne Zuschauerwert</strong><span>Diese Partien fehlen in Durchschnitt und Diagrammen. Es wird nichts geschätzt.</span></div>}
      </>}

      {(data?.teams || []).length > 0 && <section className="fan-grid fan-grid-secondary fan-grid-single">
        <article className="card fan-card">
          <CardHeader eyebrow="TEAMVERGLEICH" title="Heimarenen im Vergleich" detail="Auslastung ist vorläufig, solange Kapazitäten provisorisch sind. Das Ranking folgt Zeitraum und Wochentag, nicht dem Team- oder Heim-/Auswärtsfilter." right={<span className="fan-period-tag">{arenaUtilization.utilizationGames} auswertbare Spiele</span>} />
          <TeamComparison analysis={arenaUtilization} selectedTeamId={teamId} standings={derived?.standings || []} onSelect={(id) => { setTeamId(id); setVenuePerspective('all') }} />
          <details className="fan-methodology"><summary>Methodik und Einordnung</summary><p>Der Zuschauerschnitt und die Auslastung verwenden nur abgeschlossene Heimspiele mit echten Zuschauerwerten. Vorläufige Kapazitäten können die Rangfolge verändern. Der Tabellenplatz ist der aktuelle Stand; historische Tabellenstände pro Spieltag liegen nicht vor.</p></details>
        </article>
      </section>}
      <div className="fan-footer">Quelle: game.attendance · offizielle Zuschauerangabe je Spiel · Schweizer Zahlenformat</div>
    </div>
  )
}
