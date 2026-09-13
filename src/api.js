// Dünner Wrapper um fetch. Im Dev-Modus proxyt Vite /api -> localhost:3001.
const base = '/api'

async function req(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const j = await res.json()
      if (j.error) msg = j.error
    } catch (_) {}
    throw new Error(msg)
  }
  return res.json()
}

export const api = {
  getData: () => req('GET', '/data'),

  updateSettings: (patch) => req('PUT', '/settings', patch),

  createTeam: (t) => req('POST', '/teams', t),
  updateTeam: (id, t) => req('PUT', `/teams/${id}`, t),
  deleteTeam: (id) => req('DELETE', `/teams/${id}`),

  createPlayer: (p) => req('POST', '/players', p),
  updatePlayer: (id, p) => req('PUT', `/players/${id}`, p),
  deletePlayer: (id) => req('DELETE', `/players/${id}`),

  createGame: (g) => req('POST', '/games', g),
  updateGame: (id, g) => req('PUT', `/games/${id}`, g),
  deleteGame: (id) => req('DELETE', `/games/${id}`),

  importData: (data) => req('POST', '/import', data),
  reset: (opts) => req('POST', '/reset', opts || {}),

  getSyncStatus: () => req('GET', '/sync-status'),
  runSync: () => req('POST', '/sync'),

  getNlSyncStatus: () => req('GET', '/sync-nl-status'),
  runNlSync: () => req('POST', '/sync-nl'),
}
