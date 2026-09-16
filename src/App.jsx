import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { useData } from './DataContext.jsx'
import { ToastHost } from './components/ui.jsx'

import Dashboard from './pages/Dashboard.jsx'
import Standings from './pages/Standings.jsx'
import EloRanking from './pages/EloRanking.jsx'
import PowerRankings from './pages/PowerRankings.jsx'
import PlayoffOdds from './pages/PlayoffOdds.jsx'
import Goalies from './pages/Goalies.jsx'
import HeadToHead from './pages/HeadToHead.jsx'
import Teams from './pages/Teams.jsx'
import TeamDetail from './pages/TeamDetail.jsx'
import PlayerDetail from './pages/PlayerDetail.jsx'
import Games from './pages/Games.jsx'
import Schedule from './pages/Schedule.jsx'
import PlayerRankings from './pages/PlayerRankings.jsx'
import Settings from './pages/Settings.jsx'
import ModelPerformance from './pages/ModelPerformance.jsx'
import Backtesting from './pages/Backtesting.jsx'
import MatchupDetail from './pages/MatchupDetail.jsx'
import SyncStatus from './components/SyncStatus.jsx'
// DEV-ONLY: Live-Replay-Testseite (siehe DevLiveReplay.jsx-Kopfkommentar) -
// lazy() statt statischem import, damit Vite die Komponente in einen
// EIGENEN Chunk auslagert, der im Produktions-Build (`npm run build`) nie
// angefordert wird (siehe DEV_ROUTES unten, nur unter import.meta.env.DEV
// gemountet - der Backend-Endpunkt existiert in Produktion ohnehin gar
// nicht, siehe server/index.js).
const DevLiveReplay = import.meta.env.DEV ? lazy(() => import('./pages/DevLiveReplay.jsx')) : null

// Primäre Navigation: eine Zeile, keine Icons.
const primaryNav = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/standings', label: 'Tabelle' },
  { to: '/elo', label: 'ELO' },
  { to: '/power', label: 'Power Ranking' },
  { to: '/playoff-odds', label: 'Playoff Odds' },
  { to: '/players', label: 'Spieler' },
  { to: '/goalies', label: 'Torhüter' },
  { to: '/head-to-head', label: 'H2H' },
  { to: '/model-performance', label: 'Modell' },
  { to: '/backtesting', label: 'Backtest' },
]

// Verwaltung/Erfassung: sekundäres Menü, nicht Teil der Hauptnavigation.
const secondaryNav = [
  { to: '/schedule', label: 'Spielplan' },
  { to: '/games', label: 'Alle Spiele' },
  { to: '/teams', label: 'Teams & Kader' },
  { to: '/settings', label: 'Einstellungen' },
]

function NavMore() {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const location = useLocation()

  useEffect(() => { setOpen(false) }, [location.pathname])

  useEffect(() => {
    if (!open) return
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="nav-more" ref={ref}>
      <button className="nav-more-trigger" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Verwalten <span className="car">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="nav-more-menu">
          {secondaryNav.map((it) => (
            <NavLink key={it.to} to={it.to} className={({ isActive }) => (isActive ? 'active' : '')}>
              {it.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

// Misst die TATSÄCHLICHE Header-Höhe (inkl. iOS-Safe-Area-Padding, das je
// nach Gerät/Ausrichtung variiert) und legt sie als CSS-Variable ab, damit
// sticky Sub-Tabs (.subtabs, z.B. Season Projections) exakt darunter andocken
// statt unter dem festen --header-h zu verschwinden/zu überlappen.
function useHeaderHeight() {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const set = () => document.documentElement.style.setProperty('--header-actual-h', `${el.offsetHeight}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return ref
}

export default function App() {
  const { loading, error, data } = useData()
  const headerRef = useHeaderHeight()

  return (
    <div className="app">
      <header className="topbar" ref={headerRef}>
        <div className="topbar-inner">
          <div className="brand">
            <span className="mark">NL</span>
            <div className="name-block">
              <span>NL Tracker</span>
              <span className="season">{data?.settings?.seasonName || 'Saison 2026/27'}</span>
            </div>
          </div>
          <nav className="nav">
            {primaryNav.map((it) => (
              <NavLink key={it.to} to={it.to} end={it.end}
                className={({ isActive }) => (isActive ? 'active' : '')}>
                {it.label}
              </NavLink>
            ))}
          </nav>
          <NavMore />
          {!loading && !error && <SyncStatus />}
        </div>
      </header>

      <main className="main">
        {loading && <div className="muted">Lädt…</div>}
        {error && (
          <div className="card card-pad" style={{ borderColor: '#ef444455' }}>
            <strong className="bad">Verbindung zum Server fehlgeschlagen.</strong>
            <div className="muted mt">
              Läuft der Backend-Server? Starte alles mit <code>npm run dev</code>.
              <br />Fehler: {error}
            </div>
          </div>
        )}
        {!loading && !error && (
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/standings" element={<Standings />} />
            <Route path="/elo" element={<EloRanking />} />
            <Route path="/power" element={<PowerRankings />} />
            <Route path="/playoff-odds" element={<PlayoffOdds />} />
            <Route path="/goalies" element={<Goalies />} />
            <Route path="/head-to-head" element={<HeadToHead />} />
            <Route path="/model-performance" element={<ModelPerformance />} />
            <Route path="/backtesting" element={<Backtesting />} />
            <Route path="/players" element={<PlayerRankings />} />
            <Route path="/games" element={<Games />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/matchup/:gameId" element={<MatchupDetail />} />
            <Route path="/teams" element={<Teams />} />
            <Route path="/teams/:id" element={<TeamDetail />} />
            <Route path="/players/:id" element={<PlayerDetail />} />
            <Route path="/settings" element={<Settings />} />
            {import.meta.env.DEV && (
              <Route path="/dev/live-replay" element={<Suspense fallback={<div className="muted">Lädt…</div>}><DevLiveReplay /></Suspense>} />
            )}
            <Route path="*" element={<Dashboard />} />
          </Routes>
        )}
      </main>
      <ToastHost />
    </div>
  )
}
