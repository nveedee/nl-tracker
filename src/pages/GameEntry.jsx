import { useMemo, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge, toast } from '../components/ui.jsx'

const emptyStat = () => ({
  played: false, goals: '', assists: '', plusMinus: '', pim: '',
  goalsAgainst: '', saves: '', decision: '', shutout: false,
})

export default function GameEntry() {
  const { id } = useParams()
  const nav = useNavigate()
  const { data, api, refresh } = useData()
  const existing = id ? data.games.find((g) => g.id === id) : null

  const today = new Date().toISOString().slice(0, 10)
  const [date, setDate] = useState(existing?.date || today)
  const [homeTeamId, setHomeTeamId] = useState(existing?.homeTeamId || '')
  const [awayTeamId, setAwayTeamId] = useState(existing?.awayTeamId || '')
  const [homeGoals, setHomeGoals] = useState(existing?.homeGoals != null ? String(existing.homeGoals) : '')
  const [awayGoals, setAwayGoals] = useState(existing?.awayGoals != null ? String(existing.awayGoals) : '')
  const [decision, setDecision] = useState(existing?.decision || 'REG')
  const [saving, setSaving] = useState(false)
  const [scheduledOnly, setScheduledOnly] = useState(existing ? existing.status === 'scheduled' : false)

  // playerId -> statline
  const [stats, setStats] = useState(() => {
    const m = {}
    if (existing) {
      for (const s of existing.playerStats || []) {
        m[s.playerId] = {
          ...emptyStat(),
          played: true,
          goals: s.goals ?? '', assists: s.assists ?? '', plusMinus: s.plusMinus ?? '',
          pim: s.pim ?? '', goalsAgainst: s.goalsAgainst ?? '', saves: s.saves ?? '',
          decision: s.decision ?? '', shutout: !!s.shutout,
        }
      }
    }
    return m
  })

  const homeTeam = data.teams.find((t) => t.id === homeTeamId)
  const awayTeam = data.teams.find((t) => t.id === awayTeamId)

  const rosterOf = (tid) => data.players
    .filter((p) => p.teamId === tid)
    .sort((a, b) => ({ G: 0, D: 1, F: 2 }[a.position] - { G: 0, D: 1, F: 2 }[b.position]) || Number(a.number) - Number(b.number))

  const setStat = (pid, field, value) => {
    setStats((prev) => {
      const cur = prev[pid] || emptyStat()
      const next = { ...cur, [field]: value }
      // Automatisch als "dabei" markieren, sobald etwas eingetragen wird.
      if (value !== '' && value !== false) next.played = true
      return { ...prev, [pid]: next }
    })
  }

  const goalTotals = useMemo(() => {
    const sum = (tid) => rosterOf(tid).reduce((s, p) => s + (Number(stats[p.id]?.goals) || 0), 0)
    return { home: sum(homeTeamId), away: sum(awayTeamId) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, homeTeamId, awayTeamId, data.players])

  const save = async () => {
    if (!homeTeamId || !awayTeamId) return toast('Bitte beide Teams wählen', true)
    if (homeTeamId === awayTeamId) return toast('Heim- und Auswärtsteam müssen unterschiedlich sein', true)

    let payload
    if (scheduledOnly) {
      payload = {
        date, homeTeamId, awayTeamId, status: 'scheduled',
        homeGoals: null, awayGoals: null, decision: null, playerStats: [],
      }
    } else {
      if (homeGoals === '' || awayGoals === '') return toast('Bitte Endstand eintragen', true)
      const hg = Number(homeGoals), ag = Number(awayGoals)
      if (hg === ag) return toast('Unentschieden gibt es nicht – Sieger via OT/PS eintragen', true)

      const playerStats = []
      for (const [pid, s] of Object.entries(stats)) {
        if (!s.played) continue
        const player = data.players.find((p) => p.id === pid)
        if (!player) continue
        if (player.position === 'G') {
          playerStats.push({
            playerId: pid,
            goalsAgainst: Number(s.goalsAgainst) || 0,
            saves: Number(s.saves) || 0,
            decision: s.decision || null,
            shutout: !!s.shutout,
            pim: Number(s.pim) || 0,
          })
        } else {
          playerStats.push({
            playerId: pid,
            goals: Number(s.goals) || 0,
            assists: Number(s.assists) || 0,
            plusMinus: Number(s.plusMinus) || 0,
            pim: Number(s.pim) || 0,
          })
        }
      }

      payload = { date, homeTeamId, awayTeamId, homeGoals: hg, awayGoals: ag, decision, playerStats, status: 'final' }
    }

    setSaving(true)
    try {
      if (existing) await api.updateGame(existing.id, payload)
      else await api.createGame(payload)
      await refresh()
      toast(existing ? 'Spiel aktualisiert' : 'Spiel gespeichert')
      nav(scheduledOnly ? '/schedule' : '/games')
    } catch (e) { toast(e.message, true) } finally { setSaving(false) }
  }

  const del = async () => {
    if (!existing || !window.confirm('Dieses Spiel löschen?')) return
    try { await api.deleteGame(existing.id); await refresh(); toast('Spiel gelöscht'); nav('/games') }
    catch (e) { toast(e.message, true) }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{existing ? 'Spiel bearbeiten' : 'Spiel erfassen'}</h1>
          <div className="sub">Tipp: Mit <kbd>Tab</kbd> springst du von Feld zu Feld – Zeilen füllen sich automatisch als „dabei".</div>
        </div>
        <div className="row gap-sm">
          {existing && <button className="btn danger" onClick={del}>Löschen</button>}
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Speichert…' : 'Speichern'}</button>
        </div>
      </div>

      <div className="card card-pad mb">
        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          <div style={{ maxWidth: 170 }}>
            <label className="field">Datum</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="field">Heim</label>
            <select value={homeTeamId} onChange={(e) => setHomeTeamId(e.target.value)}>
              <option value="">– wählen –</option>
              {data.teams.map((t) => <option key={t.id} value={t.id} disabled={t.id === awayTeamId}>{t.name}</option>)}
            </select>
          </div>
          {!scheduledOnly && (
            <>
              <div style={{ maxWidth: 90 }}>
                <label className="field">Tore H</label>
                <input className="mini" type="number" min="0" value={homeGoals} onChange={(e) => setHomeGoals(e.target.value)} />
              </div>
              <div style={{ maxWidth: 90 }}>
                <label className="field">Tore A</label>
                <input className="mini" type="number" min="0" value={awayGoals} onChange={(e) => setAwayGoals(e.target.value)} />
              </div>
            </>
          )}
          <div>
            <label className="field">Auswärts</label>
            <select value={awayTeamId} onChange={(e) => setAwayTeamId(e.target.value)}>
              <option value="">– wählen –</option>
              {data.teams.map((t) => <option key={t.id} value={t.id} disabled={t.id === homeTeamId}>{t.name}</option>)}
            </select>
          </div>
          {!scheduledOnly && (
            <div style={{ maxWidth: 150 }}>
              <label className="field">Entscheidung</label>
              <select value={decision} onChange={(e) => setDecision(e.target.value)}>
                <option value="REG">Reguläre Zeit</option>
                <option value="OT">Overtime</option>
                <option value="SO">Penaltyschiessen</option>
              </select>
            </div>
          )}
        </div>
        <div className="row gap-sm mt">
          <input type="checkbox" id="scheduledOnly" checked={scheduledOnly}
            onChange={(e) => setScheduledOnly(e.target.checked)} />
          <label htmlFor="scheduledOnly" className="muted" style={{ fontSize: 13, cursor: 'pointer' }}>
            Nur Spielplan (noch kein Resultat)
          </label>
        </div>
      </div>

      {scheduledOnly ? (
        <div className="empty">
          <div className="title">Wird als Spielplan-Eintrag gespeichert</div>
          <div className="hint">Kein Resultat, keine Spielerstats. Sobald das Spiel gespielt wurde, hier den Haken entfernen und Endstand + Stats nachtragen.</div>
        </div>
      ) : (!homeTeamId || !awayTeamId) ? (
        <div className="empty"><div className="title">Wähle Heim- und Auswärtsteam</div><div className="hint">Danach erscheinen beide Kader zur schnellen Stat-Eingabe.</div></div>
      ) : (
        <div className="grid grid-2">
          <RosterEntry team={homeTeam} roster={rosterOf(homeTeamId)} stats={stats} setStat={setStat}
            goalHint={goalTotals.home} target={homeGoals} />
          <RosterEntry team={awayTeam} roster={rosterOf(awayTeamId)} stats={stats} setStat={setStat}
            goalHint={goalTotals.away} target={awayGoals} />
        </div>
      )}
    </>
  )
}

function RosterEntry({ team, roster, stats, setStat, goalHint, target }) {
  if (!team) return null
  const skaters = roster.filter((p) => p.position !== 'G')
  const goalies = roster.filter((p) => p.position === 'G')
  const mismatch = target !== '' && Number(target) !== goalHint

  return (
    <div className="card">
      <div className="card-pad" style={{ paddingBottom: 8 }}>
        <div className="row spread">
          <TeamBadge team={team} link={false} />
          <span className="chip" title="Summe eingetragener Tore vs. Endstand"
            style={{ color: mismatch ? 'var(--warn)' : 'var(--text-dim)' }}>
            Σ Tore: {goalHint}{target !== '' ? ` / ${target}` : ''}
          </span>
        </div>
      </div>

      {roster.length === 0 ? (
        <div className="card-pad muted">
          Kein Kader hinterlegt. <Link to={`/teams/${team.id}`}>Spieler hinzufügen →</Link>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="left">Spieler</th>
                <th className="num" title="Tore">T</th>
                <th className="num" title="Assists">A</th>
                <th className="num" title="Plus/Minus">±</th>
                <th className="num" title="Strafminuten">SM</th>
              </tr>
            </thead>
            <tbody>
              {skaters.map((p) => {
                const s = stats[p.id] || {}
                return (
                  <tr key={p.id} style={{ opacity: s.played ? 1 : 0.75 }}>
                    <td className="left"><span className="muted">#{p.number}</span> {p.name}</td>
                    <td className="num"><Cell v={s.goals} on={(v) => setStat(p.id, 'goals', v)} /></td>
                    <td className="num"><Cell v={s.assists} on={(v) => setStat(p.id, 'assists', v)} /></td>
                    <td className="num"><Cell v={s.plusMinus} on={(v) => setStat(p.id, 'plusMinus', v)} allowNeg /></td>
                    <td className="num"><Cell v={s.pim} on={(v) => setStat(p.id, 'pim', v)} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {goalies.length > 0 && (
            <table style={{ borderTop: '2px solid var(--border-strong)' }}>
              <thead>
                <tr>
                  <th className="left">Torhüter</th>
                  <th className="num" title="Gegentore">GT</th>
                  <th className="num" title="Paraden">PAR</th>
                  <th className="num" title="Sieg/Niederlage">E</th>
                  <th className="num" title="Shutout">SO</th>
                </tr>
              </thead>
              <tbody>
                {goalies.map((p) => {
                  const s = stats[p.id] || {}
                  return (
                    <tr key={p.id} style={{ opacity: s.played ? 1 : 0.75 }}>
                      <td className="left"><span className="muted">#{p.number}</span> {p.name}</td>
                      <td className="num"><Cell v={s.goalsAgainst} on={(v) => setStat(p.id, 'goalsAgainst', v)} /></td>
                      <td className="num"><Cell v={s.saves} on={(v) => setStat(p.id, 'saves', v)} /></td>
                      <td className="num">
                        <select value={s.decision || ''} onChange={(e) => setStat(p.id, 'decision', e.target.value)}
                          style={{ width: 58, padding: '4px 6px' }}>
                          <option value="">–</option>
                          <option value="W">S</option>
                          <option value="L">N</option>
                        </select>
                      </td>
                      <td className="num">
                        <input type="checkbox" checked={!!s.shutout} onChange={(e) => setStat(p.id, 'shutout', e.target.checked)} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

function Cell({ v, on, allowNeg }) {
  return (
    <input
      className="mini"
      type="number"
      min={allowNeg ? undefined : '0'}
      value={v ?? ''}
      onChange={(e) => on(e.target.value)}
      style={{ width: 52 }}
      placeholder="0"
    />
  )
}
