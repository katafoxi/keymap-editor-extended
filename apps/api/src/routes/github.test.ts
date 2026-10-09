import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import jwt from 'jsonwebtoken'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../index.js'
import {
  KeymapValidationError,
  buildHostKeymapSnapshot,
  parseHostKeymapSnapshot,
  parseKeymap
} from '@keymap-editor/keymap-core'
import type { HostLegendView } from '@keymap-editor/keymap-core'
import { config } from '../config.js'
import * as api from '../services/github/api.js'
import * as auth from '../services/github/auth.js'
import * as files from '../services/github/files.js'
import { MissingRepoFile } from '../services/github/files.js'
import * as builds from '../services/github/builds.js'
import * as installations from '../services/github/installations.js'
import {
  consumeOauthState,
  createOauthState,
  createSession,
  deleteSession,
  getSession,
  SESSION_COOKIE_MAX_AGE_SEC
} from '../services/github/sessions.js'
import {
  GITHUB_RATE_BUCKET_CAP,
  githubRateBucketsForTests,
  githubRoutes,
  pruneGithubRateBuckets,
  resetGithubRateLimitForTests,
  setGithubRateLimitForTests
} from './github.js'

const app = new Hono().route('/github', githubRoutes)

const VALID_INFO = {
  layouts: {
    LAYOUT: {
      layout: [{ x: 0, y: 0 }]
    }
  }
}

const VALID_KEYMAP = { layers: [['&kp A']] }

const HOST_VIEW: HostLegendView = {
  columns: [
    {
      language: 'en',
      layoutId: 'system-us',
      visible: true,
      altGr: true,
      altGrShift: true
    },
    {
      language: 'ru',
      layoutId: 'user:ru-1',
      visible: true,
      altGr: true,
      altGrShift: false
    }
  ],
  open: 'ru',
  keycap: ['en', 'ru']
}

const HOST_SNAPSHOT = buildHostKeymapSnapshot(HOST_VIEW, [
  {
    id: 'user:ru-1',
    name: 'typewriter',
    language: 'ru',
    origin: { from: 'copy', layoutId: 'system-ru-legacy' },
    layout: {
      id: 'user:ru-1',
      byZmk: new Map([
        [
          'Q',
          {
            keysyms: ['Cyrillic_shorti', 'Cyrillic_SHORTI', 'NoSymbol', 'NoSymbol'],
            glyphs: ['й', 'Й', '', '']
          }
        ]
      ])
    }
  }
])

const createdSids: string[] = []
const appOrigin = new URL(config.APP_BASE_URL).origin

function setCookieHeaders(res: Response): string[] {
  if (typeof res.headers.getSetCookie === 'function') {
    return res.headers.getSetCookie()
  }
  const single = res.headers.get('set-cookie')
  return single ? [single] : []
}

function parseCookies(res: Response): Record<string, { value: string; raw: string }> {
  const out: Record<string, { value: string; raw: string }> = {}
  for (const header of setCookieHeaders(res)) {
    const [pair] = header.split(';')
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    out[name] = { value, raw: header }
  }
  return out
}

function cookieIsCleared(raw: string): boolean {
  const lower = raw.toLowerCase()
  return /max-age=0/.test(lower) || /expires=thu, 01 jan 1970/.test(lower)
}

function trackSid(sid: string): string {
  createdSids.push(sid)
  return sid
}

function sessionCookie(sid: string): string {
  return `${auth.SID_COOKIE}=${sid}`
}

function withAppOrigin(headers: Headers, init: RequestInit): void {
  const method = (init.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  if (!headers.has('Origin') && !headers.has('Referer')) {
    headers.set('Origin', appOrigin)
  }
}

function appTokenError(status: number) {
  return Object.assign(new Error(`GitHub API ${status}`), {
    response: {
      status,
      data: { message: 'Validation Failed' },
      url: 'https://api.github.com/app/installations/1/access_tokens'
    }
  })
}

async function authedRequest(
  path: string,
  init: RequestInit = {},
  sid = trackSid(createSession({ login: 'octocat', oauthAccessToken: 'user-token' }))
) {
  const headers = new Headers(init.headers)
  headers.set('Cookie', sessionCookie(sid))
  withAppOrigin(headers, init)
  return { sid, res: await app.request(path, { ...init, headers }) }
}

const OWN_INSTALLATION_REPOS = {
  installations: [{ id: 1 }],
  repositories: [{ full_name: 'acme/lark' }, { full_name: 'acme/keymap' }],
  repoInstallationMap: { 'acme/lark': 1, 'acme/keymap': 1 },
  repoAccess: {
    'acme/lark': { installationId: 1, push: true },
    'acme/keymap': { installationId: 1, push: true }
  }
}

beforeEach(() => {
  vi.spyOn(auth, 'getOauthToken')
  vi.spyOn(auth, 'refreshOauthToken')
  vi.spyOn(auth, 'getOauthUser')
  vi.spyOn(installations, 'fetchInstallationRepos').mockResolvedValue(OWN_INSTALLATION_REPOS)
  vi.spyOn(installations, 'fetchRepoBranches')
  vi.spyOn(files, 'fetchKeyboardFiles')
  vi.spyOn(files, 'commitChanges')
})

afterEach(() => {
  for (const sid of createdSids) deleteSession(sid)
  createdSids.length = 0
  auth.clearInstallationTokenCache()
  resetGithubRateLimitForTests()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('GET /github/authorize', () => {
  it.each(['install', 'update'])(
    'restarts protected OAuth after a %s return without trusting its code or installation ID',
    async action => {
      const res = await app.request(
        `/github/authorize?code=unverified-install-code&installation_id=123&setup_action=${action}`
      )
      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location') ?? '')
      expect(location.origin).toBe('https://github.com')
      expect(location.pathname).toBe('/login/oauth/authorize')
      expect(location.searchParams.has('code')).toBe(false)
      expect(location.searchParams.has('installation_id')).toBe(false)
      const state = location.searchParams.get('state') ?? ''
      expect(state).toBeTruthy()
      const cookies = parseCookies(res)
      expect(cookies[auth.OAUTH_STATE_COOKIE]?.value).toBe(state)
      expect(cookies[auth.SID_COOKIE]).toBeUndefined()
      expect(auth.getOauthToken).not.toHaveBeenCalled()
      expect(auth.getOauthUser).not.toHaveBeenCalled()
      expect(installations.fetchInstallationRepos).not.toHaveBeenCalled()
      consumeOauthState(state)
    }
  )

  it('returns an authenticated installer to the app without exchanging the installation code', async () => {
    const sid = trackSid(createSession({ login: 'octocat', oauthAccessToken: 'user-token' }))
    const res = await app.request(
      '/github/authorize?code=unverified-install-code&installation_id=123&setup_action=install',
      { headers: { Cookie: sessionCookie(sid) } }
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(config.APP_BASE_URL)
    expect(getSession(sid)?.login).toBe('octocat')
    expect(auth.getOauthToken).not.toHaveBeenCalled()
    expect(auth.getOauthUser).not.toHaveBeenCalled()
    expect(installations.fetchInstallationRepos).not.toHaveBeenCalled()
  })

  it.each([
    '',
    '&installation_id=123',
    '&installation_id=not-a-number&setup_action=install',
    '&installation_id=0&setup_action=install',
    '&installation_id=123&setup_action=unknown',
    '&installation_id=123&setup_action=install&state=',
    '&installation_id=123&setup_action=install&state=mismatched'
  ])('does not downgrade an invalid OAuth callback to an installation return: %s', async suffix => {
    const res = await app.request(`/github/authorize?code=unverified-code${suffix}`)
    expect(res.status).toBe(401)
    expect(auth.getOauthToken).not.toHaveBeenCalled()
    expect(auth.getOauthUser).not.toHaveBeenCalled()
    expect(parseCookies(res)[auth.SID_COOKIE]).toBeUndefined()
  })

  it('processes installation metadata through normal OAuth when a valid state is present', async () => {
    const state = createOauthState()
    vi.mocked(auth.getOauthToken).mockResolvedValue({
      data: { access_token: 'oauth-token' }
    } as Awaited<ReturnType<typeof auth.getOauthToken>>)
    vi.mocked(auth.getOauthUser).mockResolvedValue({
      data: { login: 'octocat' }
    } as Awaited<ReturnType<typeof auth.getOauthUser>>)
    const res = await app.request(
      `/github/authorize?code=abc&installation_id=123&setup_action=install&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `${auth.OAUTH_STATE_COOKIE}=${state}` } }
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(config.APP_BASE_URL)
    expect(auth.getOauthToken).toHaveBeenCalledWith('abc')
    const sid = parseCookies(res)[auth.SID_COOKIE]?.value
    expect(sid).toBeTruthy()
    trackSid(sid)
    expect(consumeOauthState(state)).toBe(false)
  })

  it('redirects to GitHub OAuth and sets oauth_state when code is missing', async () => {
    const res = await app.request('/github/authorize')
    expect(res.status).toBe(302)

    const location = res.headers.get('location') ?? ''
    expect(location.startsWith('https://github.com/login/oauth/authorize')).toBe(true)

    const cookies = parseCookies(res)
    expect(cookies[auth.OAUTH_STATE_COOKIE]?.value).toBeTruthy()

    const state = new URL(location).searchParams.get('state')
    expect(state).toBe(cookies[auth.OAUTH_STATE_COOKIE].value)
    consumeOauthState(state ?? '')
  })

  it('redirects to the app with login=denied on access_denied and does not start OAuth', async () => {
    const state = createOauthState()
    const res = await app.request(
      `/github/authorize?error=access_denied&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `${auth.OAUTH_STATE_COOKIE}=${state}` } }
    )
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toBe(auth.createOauthDeniedUrl())
    expect(location.includes('github.com')).toBe(false)
    expect(consumeOauthState(state)).toBe(false)
    const cookies = parseCookies(res)
    expect(cookies[auth.OAUTH_STATE_COOKIE]).toBeDefined()
    expect(cookieIsCleared(cookies[auth.OAUTH_STATE_COOKIE].raw)).toBe(true)
  })

  it('returns 401 when the oauth token response contains an error', async () => {
    const state = createOauthState()
    vi.mocked(auth.getOauthToken).mockResolvedValue({
      data: { error: 'bad_verification_code' }
    } as Awaited<ReturnType<typeof auth.getOauthToken>>)

    const res = await app.request(`/github/authorize?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: `${auth.OAUTH_STATE_COOKIE}=${state}` }
    })
    expect(res.status).toBe(401)
    expect(auth.getOauthUser).not.toHaveBeenCalled()
  })

  it('deletes the previous session when starting a new OAuth login', async () => {
    const previous = trackSid(createSession({ login: 'old', oauthAccessToken: 'old-token' }))
    const res = await app.request('/github/authorize', {
      headers: { Cookie: sessionCookie(previous) }
    })
    expect(res.status).toBe(302)
    expect(getSession(previous)).toBeUndefined()
    const cookies = parseCookies(res)
    expect(cookies[auth.SID_COOKIE]).toBeDefined()
    expect(cookieIsCleared(cookies[auth.SID_COOKIE].raw)).toBe(true)
    const state = new URL(res.headers.get('location') ?? '').searchParams.get('state')
    consumeOauthState(state ?? '')
  })

  it('returns 401 and clears oauth_state when state does not match the cookie', async () => {
    const state = createOauthState()
    const res = await app.request(`/github/authorize?code=abc&state=${state}`, {
      headers: { Cookie: `${auth.OAUTH_STATE_COOKIE}=other-state` }
    })
    expect(res.status).toBe(401)
    const cookies = parseCookies(res)
    expect(cookies[auth.OAUTH_STATE_COOKIE]).toBeDefined()
    expect(cookieIsCleared(cookies[auth.OAUTH_STATE_COOKIE].raw)).toBe(true)
    consumeOauthState(state)
  })

  it('returns 401 and clears oauth_state when the cookie is missing', async () => {
    const state = createOauthState()
    const res = await app.request(`/github/authorize?code=abc&state=${state}`)
    expect(res.status).toBe(401)
    const cookies = parseCookies(res)
    expect(cookies[auth.OAUTH_STATE_COOKIE]).toBeDefined()
    expect(cookieIsCleared(cookies[auth.OAUTH_STATE_COOKIE].raw)).toBe(true)
    consumeOauthState(state)
  })

  it('returns 401 and clears oauth_state when state was already consumed', async () => {
    const state = createOauthState()
    expect(consumeOauthState(state)).toBe(true)

    const res = await app.request(`/github/authorize?code=abc&state=${state}`, {
      headers: { Cookie: `${auth.OAUTH_STATE_COOKIE}=${state}` }
    })
    expect(res.status).toBe(401)
    const cookies = parseCookies(res)
    expect(cookies[auth.OAUTH_STATE_COOKIE]).toBeDefined()
    expect(cookieIsCleared(cookies[auth.OAUTH_STATE_COOKIE].raw)).toBe(true)
  })

  it('exchanges a matching single-use state for a sid and reaches installation', async () => {
    const start = await app.request('/github/authorize')
    const startCookies = parseCookies(start)
    const startLocation = start.headers.get('location') ?? ''
    const state = new URL(startLocation).searchParams.get('state') ?? ''
    expect(startCookies[auth.OAUTH_STATE_COOKIE]?.value).toBe(state)

    vi.mocked(auth.getOauthToken).mockResolvedValue({
      data: {
        access_token: 'oauth-token',
        refresh_token: 'refresh-token',
        expires_in: 28800
      }
    } as Awaited<ReturnType<typeof auth.getOauthToken>>)
    vi.mocked(auth.getOauthUser).mockResolvedValue({
      data: { login: 'octocat' }
    } as Awaited<ReturnType<typeof auth.getOauthUser>>)
    vi.mocked(installations.fetchInstallationRepos).mockResolvedValue({
      installations: [{ id: 1 }],
      repositories: [],
      repoInstallationMap: {},
      repoAccess: {}
    })

    const callback = await app.request(`/github/authorize?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: `${auth.OAUTH_STATE_COOKIE}=${state}` }
    })
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe(config.APP_BASE_URL)

    const sid = parseCookies(callback)[auth.SID_COOKIE]?.value
    expect(sid).toBeTruthy()
    trackSid(sid)

    const install = await app.request('/github/installation', {
      headers: { Cookie: sessionCookie(sid) }
    })
    expect(install.status).toBe(200)
    expect(await install.json()).toMatchObject({ login: 'octocat' })
    expect(installations.fetchInstallationRepos).toHaveBeenCalledWith('oauth-token')
    expect(auth.refreshOauthToken).not.toHaveBeenCalled()
  })

  it('refreshes the oauth access token after expires_in elapses', async () => {
    vi.useFakeTimers()
    const start = await app.request('/github/authorize')
    const startCookies = parseCookies(start)
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? ''
    expect(startCookies[auth.OAUTH_STATE_COOKIE]?.value).toBe(state)

    vi.mocked(auth.getOauthToken).mockResolvedValue({
      data: {
        access_token: 'oauth-token',
        refresh_token: 'refresh-1',
        expires_in: 1
      }
    } as Awaited<ReturnType<typeof auth.getOauthToken>>)
    vi.mocked(auth.getOauthUser).mockResolvedValue({
      data: { login: 'octocat' }
    } as Awaited<ReturnType<typeof auth.getOauthUser>>)
    vi.mocked(auth.refreshOauthToken).mockResolvedValue({
      data: {
        access_token: 'oauth-token-2',
        refresh_token: 'refresh-2',
        expires_in: 28800
      }
    } as Awaited<ReturnType<typeof auth.refreshOauthToken>>)

    const callback = await app.request(`/github/authorize?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: `${auth.OAUTH_STATE_COOKIE}=${state}` }
    })
    const sid = parseCookies(callback)[auth.SID_COOKIE]?.value
    expect(sid).toBeTruthy()
    trackSid(sid)

    vi.advanceTimersByTime(2000)

    const install = await app.request('/github/installation', {
      headers: { Cookie: sessionCookie(sid) }
    })
    expect(install.status).toBe(200)
    expect(auth.refreshOauthToken).toHaveBeenCalledWith('refresh-1')
    expect(installations.fetchInstallationRepos).toHaveBeenCalledWith('oauth-token-2')
    expect(getSession(sid)?.oauthAccessToken).toBe('oauth-token-2')
  })

  it('returns 401 and deletes the session when oauth refresh fails', async () => {
    vi.useFakeTimers()
    const sid = trackSid(
      createSession({
        login: 'octocat',
        oauthAccessToken: 'stale-token',
        oauthRefreshToken: 'refresh-bad',
        expiresInSec: 1
      })
    )
    vi.mocked(auth.refreshOauthToken).mockResolvedValue({
      data: { error: 'bad_refresh_token' }
    } as Awaited<ReturnType<typeof auth.refreshOauthToken>>)

    vi.advanceTimersByTime(2000)

    const res = await app.request('/github/installation', {
      headers: { Cookie: sessionCookie(sid) }
    })
    expect(res.status).toBe(401)
    expect(getSession(sid)).toBeUndefined()
    expect(installations.fetchInstallationRepos).not.toHaveBeenCalled()
  })

  it.each([
    {
      title: 'there is no refresh token',
      session: {
        login: 'octocat',
        oauthAccessToken: 'stale-token',
        expiresInSec: 1
      },
      setupRefresh: () => {},
      expectRefreshCalls: 0
    },
    {
      title: 'refreshOauthToken throws',
      session: {
        login: 'octocat',
        oauthAccessToken: 'stale-token',
        oauthRefreshToken: 'refresh-throw',
        expiresInSec: 1
      },
      setupRefresh: () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(auth.refreshOauthToken).mockRejectedValue(new Error('refresh boom'))
      },
      expectRefreshCalls: 1
    },
    {
      title: 'refresh response is { error }',
      session: {
        login: 'octocat',
        oauthAccessToken: 'stale-token',
        oauthRefreshToken: 'refresh-error',
        expiresInSec: 1
      },
      setupRefresh: () => {
        vi.mocked(auth.refreshOauthToken).mockResolvedValue({
          data: { error: 'bad_refresh_token' }
        } as Awaited<ReturnType<typeof auth.refreshOauthToken>>)
      },
      expectRefreshCalls: 1
    }
  ])(
    'returns 401, clears sid, and does not retry refresh when $title',
    async ({ session, setupRefresh, expectRefreshCalls }) => {
      vi.useFakeTimers()
      const sid = trackSid(createSession(session))
      setupRefresh()
      vi.advanceTimersByTime(2000)

      const first = await app.request('/github/installation', {
        headers: { Cookie: sessionCookie(sid) }
      })
      expect(first.status).toBe(401)
      expect(getSession(sid)).toBeUndefined()
      const firstCookies = parseCookies(first)
      expect(firstCookies[auth.SID_COOKIE]).toBeDefined()
      expect(cookieIsCleared(firstCookies[auth.SID_COOKIE].raw)).toBe(true)
      expect(auth.refreshOauthToken).toHaveBeenCalledTimes(expectRefreshCalls)
      expect(installations.fetchInstallationRepos).not.toHaveBeenCalled()

      const second = await app.request('/github/installation', {
        headers: { Cookie: sessionCookie(sid) }
      })
      expect(second.status).toBe(401)
      expect(getSession(sid)).toBeUndefined()
      expect(auth.refreshOauthToken).toHaveBeenCalledTimes(expectRefreshCalls)
      expect(installations.fetchInstallationRepos).not.toHaveBeenCalled()
    }
  )

  it('returns 500 without a sid when the OAuth callback throws', async () => {
    const start = await app.request('/github/authorize')
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? ''
    expect(state).toBeTruthy()

    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(auth.getOauthToken).mockRejectedValue(new Error('token exchange boom'))

    const callback = await app.request(`/github/authorize?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: `${auth.OAUTH_STATE_COOKIE}=${state}` }
    })
    expect(callback.status).toBe(500)
    const cookies = parseCookies(callback)
    const sidCookie = cookies[auth.SID_COOKIE]
    expect(sidCookie === undefined || cookieIsCleared(sidCookie.raw)).toBe(true)
    expect(auth.getOauthUser).not.toHaveBeenCalled()

    const replay = await app.request(`/github/authorize?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: `${auth.OAUTH_STATE_COOKIE}=${state}` }
    })
    expect(replay.status).toBe(401)
    expect(auth.getOauthToken).toHaveBeenCalledTimes(1)
    expect(consumeOauthState(state)).toBe(false)
    // The 500 response does not clear oauth_state; usability is the consumed nonce.
    expect(cookies[auth.OAUTH_STATE_COOKIE]).toBeUndefined()
  })
})

function connEnv(remoteAddress: string) {
  return { incoming: { socket: { remoteAddress } } }
}

function consumeAuthorizeState(res: Response) {
  if (res.status !== 302) return
  const location = res.headers.get('location') ?? ''
  const state = new URL(location).searchParams.get('state')
  if (state) consumeOauthState(state)
}

describe('github rate limit', () => {
  let previousTrustProxy: boolean

  beforeEach(() => {
    previousTrustProxy = config.TRUST_PROXY
    config.TRUST_PROXY = false
  })

  afterEach(() => {
    config.TRUST_PROXY = previousTrustProxy
  })

  it('returns 429 when an IP exceeds the /github/* cap', async () => {
    setGithubRateLimitForTests({ max: 2, windowMs: 60_000 })
    const first = await app.request('/github/authorize')
    const second = await app.request('/github/authorize')
    const third = await app.request('/github/authorize')
    expect(first.status).toBe(302)
    expect(second.status).toBe(302)
    expect(third.status).toBe(429)
    expect(third.headers.get('retry-after')).toBeTruthy()
    consumeAuthorizeState(first)
    consumeAuthorizeState(second)
  })

  it('ignores X-Forwarded-For when TRUST_PROXY is unset so one client stays in one bucket', async () => {
    setGithubRateLimitForTests({ max: 2, windowMs: 60_000 })
    const env = connEnv('203.0.113.10')
    const first = await app.request(
      '/github/authorize',
      { headers: { 'X-Forwarded-For': '198.51.100.1' } },
      env
    )
    const second = await app.request(
      '/github/authorize',
      { headers: { 'X-Forwarded-For': '198.51.100.2' } },
      env
    )
    const third = await app.request(
      '/github/authorize',
      { headers: { 'X-Forwarded-For': '198.51.100.3' } },
      env
    )
    expect(first.status).toBe(302)
    expect(second.status).toBe(302)
    expect(third.status).toBe(429)
    consumeAuthorizeState(first)
    consumeAuthorizeState(second)
  })

  it('ignores X-Real-IP when TRUST_PROXY is unset', async () => {
    setGithubRateLimitForTests({ max: 1, windowMs: 60_000 })
    const env = connEnv('203.0.113.10')
    const first = await app.request(
      '/github/authorize',
      { headers: { 'X-Real-IP': '198.51.100.8' } },
      env
    )
    const second = await app.request(
      '/github/authorize',
      { headers: { 'X-Real-IP': '198.51.100.9' } },
      env
    )
    expect(first.status).toBe(302)
    expect(second.status).toBe(429)
    consumeAuthorizeState(first)
  })

  it('keys buckets on the socket address when TRUST_PROXY is unset', async () => {
    setGithubRateLimitForTests({ max: 1, windowMs: 60_000 })
    const first = await app.request('/github/authorize', {}, connEnv('203.0.113.1'))
    const second = await app.request('/github/authorize', {}, connEnv('203.0.113.2'))
    expect(first.status).toBe(302)
    expect(second.status).toBe(302)
    consumeAuthorizeState(first)
    consumeAuthorizeState(second)
  })

  it('uses X-Forwarded-For when TRUST_PROXY is true', async () => {
    config.TRUST_PROXY = true
    setGithubRateLimitForTests({ max: 1, windowMs: 60_000 })
    const env = connEnv('203.0.113.10')
    const first = await app.request(
      '/github/authorize',
      { headers: { 'X-Forwarded-For': '198.51.100.1, 10.0.0.1' } },
      env
    )
    const second = await app.request(
      '/github/authorize',
      { headers: { 'X-Forwarded-For': '198.51.100.2' } },
      env
    )
    const firstRepeat = await app.request(
      '/github/authorize',
      { headers: { 'X-Forwarded-For': '198.51.100.1' } },
      env
    )
    expect(first.status).toBe(302)
    expect(second.status).toBe(302)
    expect(firstRepeat.status).toBe(429)
    consumeAuthorizeState(first)
    consumeAuthorizeState(second)
  })

  it('uses X-Real-IP when TRUST_PROXY is true and X-Forwarded-For is absent', async () => {
    config.TRUST_PROXY = true
    setGithubRateLimitForTests({ max: 1, windowMs: 60_000 })
    const env = connEnv('203.0.113.10')
    const first = await app.request('/github/authorize', { headers: { 'X-Real-IP': '198.51.100.8' } }, env)
    const second = await app.request('/github/authorize', { headers: { 'X-Real-IP': '198.51.100.9' } }, env)
    expect(first.status).toBe(302)
    expect(second.status).toBe(302)
    consumeAuthorizeState(first)
    consumeAuthorizeState(second)
  })

  it('falls back to the socket address when TRUST_PROXY is true but forwarded headers are missing', async () => {
    config.TRUST_PROXY = true
    setGithubRateLimitForTests({ max: 1, windowMs: 60_000 })
    const first = await app.request('/github/authorize', {}, connEnv('203.0.113.1'))
    const second = await app.request('/github/authorize', {}, connEnv('203.0.113.1'))
    const other = await app.request('/github/authorize', {}, connEnv('203.0.113.2'))
    expect(first.status).toBe(302)
    expect(second.status).toBe(429)
    expect(other.status).toBe(302)
    consumeAuthorizeState(first)
    consumeAuthorizeState(other)
  })

  it('deletes expired rate buckets and caps the map at GITHUB_RATE_BUCKET_CAP', () => {
    const now = 1_700_000_000_000
    const buckets = githubRateBucketsForTests()
    buckets.clear()
    buckets.set('expired', { count: 3, resetAt: now - 1 })
    buckets.set('live', { count: 1, resetAt: now + 60_000 })
    pruneGithubRateBuckets(now)
    expect(buckets.has('expired')).toBe(false)
    expect(buckets.get('live')).toEqual({ count: 1, resetAt: now + 60_000 })

    buckets.clear()
    for (let i = 0; i < GITHUB_RATE_BUCKET_CAP + 7; i++) {
      buckets.set(`ip-${i}`, { count: 1, resetAt: now + 60_000 })
    }
    pruneGithubRateBuckets(now)
    expect(buckets.size).toBe(GITHUB_RATE_BUCKET_CAP)
    expect(buckets.has('ip-0')).toBe(false)
    expect(buckets.has(`ip-${GITHUB_RATE_BUCKET_CAP + 6}`)).toBe(true)
  })
})

describe('session and errors', () => {
  it('POST /github/logout with a valid sid returns 204 and invalidates the session', async () => {
    const sid = trackSid(createSession({ login: 'octocat', oauthAccessToken: 'user-token' }))
    const logout = await app.request('/github/logout', {
      method: 'POST',
      headers: { Cookie: sessionCookie(sid), Origin: appOrigin }
    })
    expect(logout.status).toBe(204)

    const install = await app.request('/github/installation', {
      headers: { Cookie: sessionCookie(sid) }
    })
    expect(install.status).toBe(401)
    expect(installations.fetchInstallationRepos).not.toHaveBeenCalled()
  })

  it('rejects mutating requests with a foreign Origin', async () => {
    const sid = trackSid(createSession({ login: 'octocat', oauthAccessToken: 'user-token' }))
    const logout = await app.request('/github/logout', {
      method: 'POST',
      headers: { Cookie: sessionCookie(sid), Origin: 'https://evil.example' }
    })
    expect(logout.status).toBe(403)

    const commit = vi.mocked(files.commitChanges)
    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Flark/main', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example'
      },
      body: JSON.stringify({ keymap: parseKeymap(VALID_KEYMAP), layout: [{ x: 0, y: 0 }] })
    })
    expect(res.status).toBe(403)
    expect(commit).not.toHaveBeenCalled()
  })

  it('rejects mutating requests with neither Origin nor Referer', async () => {
    const sid = trackSid(createSession({ login: 'octocat', oauthAccessToken: 'user-token' }))
    const logout = await app.request('/github/logout', {
      method: 'POST',
      headers: { Cookie: sessionCookie(sid) }
    })
    expect(logout.status).toBe(403)
  })

  it('accepts mutating requests when Referer matches APP_BASE_URL', async () => {
    const sid = trackSid(createSession({ login: 'octocat', oauthAccessToken: 'user-token' }))
    const logout = await app.request('/github/logout', {
      method: 'POST',
      headers: {
        Cookie: sessionCookie(sid),
        Referer: `${appOrigin}/editor`
      }
    })
    expect(logout.status).toBe(204)
  })

  it('refreshes the sid cookie maxAge on authenticated requests', async () => {
    const { sid, res } = await authedRequest('/github/installation')
    expect(res.status).toBe(200)
    const cookies = parseCookies(res)
    expect(cookies[auth.SID_COOKIE]?.value).toBe(sid)
    expect(cookies[auth.SID_COOKIE].raw.toLowerCase()).toContain(
      `max-age=${SESSION_COOKIE_MAX_AGE_SEC}`
    )
  })

  it('GET /github/installation without a cookie returns 401', async () => {
    const res = await app.request('/github/installation')
    expect(res.status).toBe(401)
    expect(installations.fetchInstallationRepos).not.toHaveBeenCalled()
  })

  it('GET /github/installation with an expired sid returns 401 and clears sid', async () => {
    vi.useFakeTimers()
    const sid = trackSid(createSession({ login: 'octocat', oauthAccessToken: 'user-token' }))
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1)

    const res = await app.request('/github/installation', {
      headers: { Cookie: sessionCookie(sid) }
    })
    expect(res.status).toBe(401)
    const cookies = parseCookies(res)
    expect(cookies[auth.SID_COOKIE]).toBeDefined()
    expect(cookieIsCleared(cookies[auth.SID_COOKIE].raw)).toBe(true)
    expect(installations.fetchInstallationRepos).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('returns 401 when fetchInstallationRepos throws an upstream 401', async () => {
    vi.mocked(installations.fetchInstallationRepos).mockRejectedValue(
      Object.assign(new Error('unauthorized'), { response: { status: 401, data: 'bad token' } })
    )
    const { res } = await authedRequest('/github/installation')
    expect(res.status).toBe(401)
  })

  it('returns 500 when fetchInstallationRepos throws any other error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(installations.fetchInstallationRepos).mockRejectedValue(new Error('boom'))
    const { res } = await authedRequest('/github/installation')
    expect(res.status).toBe(500)
  })

  it('maps GitHub 404/403/429 and App-token 401 to client statuses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.mocked(installations.fetchInstallationRepos).mockRejectedValueOnce(
      Object.assign(new Error('GitHub API 404'), { response: { status: 404, data: { message: 'Not Found' } } })
    )
    expect((await authedRequest('/github/installation')).res.status).toBe(404)

    vi.mocked(installations.fetchInstallationRepos).mockRejectedValueOnce(
      Object.assign(new Error('GitHub API 403'), { response: { status: 403, data: { message: 'forbidden' } } })
    )
    expect((await authedRequest('/github/installation')).res.status).toBe(502)

    vi.mocked(installations.fetchInstallationRepos).mockRejectedValueOnce(
      Object.assign(new Error('GitHub API 429'), { response: { status: 429, data: { message: 'rate' } } })
    )
    expect((await authedRequest('/github/installation')).res.status).toBe(429)

    vi.mocked(files.fetchKeyboardFiles).mockRejectedValueOnce(
      Object.assign(new Error('GitHub API 401'), {
        response: {
          status: 401,
          data: { message: 'A JSON web token could not be decoded' },
          url: 'https://api.github.com/app/installations/1/access_tokens'
        }
      })
    )
    expect((await authedRequest('/github/keyboard-files/1/acme%2Flark')).res.status).toBe(502)
  })

  it.each([
    {
      title: 'GET branches',
      path: '/github/installation/1/acme%2Flark/branches',
      status: 422,
      reject: () =>
        vi.spyOn(auth, 'createInstallationToken').mockRejectedValue(appTokenError(422))
    },
    {
      title: 'GET branches',
      path: '/github/installation/1/acme%2Flark/branches',
      status: 409,
      reject: () =>
        vi.spyOn(auth, 'createInstallationToken').mockRejectedValue(appTokenError(409))
    },
    {
      title: 'GET keyboard-files',
      path: '/github/keyboard-files/1/acme%2Flark',
      status: 422,
      reject: () => vi.mocked(files.fetchKeyboardFiles).mockRejectedValue(appTokenError(422))
    },
    {
      title: 'GET keyboard-files',
      path: '/github/keyboard-files/1/acme%2Flark',
      status: 409,
      reject: () => vi.mocked(files.fetchKeyboardFiles).mockRejectedValue(appTokenError(409))
    }
  ])('maps App-token $status on $title to 502 instead of StaleRepoBase', async ({
    path,
    reject
  }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    reject()
    const { res } = await authedRequest(path)
    expect(res.status).toBe(502)
    expect(await res.text()).toBe('')
  })

  it('stringifies GitHub error bodies in logs instead of [object Object]', async () => {
    const logged: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
    vi.mocked(installations.fetchInstallationRepos).mockRejectedValue(
      Object.assign(new Error('GitHub API 500'), {
        response: { status: 500, data: { message: 'server exploded' } }
      })
    )
    const { res } = await authedRequest('/github/installation')
    expect(res.status).toBe(500)
    const text = logged.join('\n')
    expect(text).toContain('{"message":"server exploded"}')
    expect(text).not.toContain('[object Object]')
  })

  it('GET /github/keyboard-files returns 400 JSON for MissingRepoFile', async () => {
    vi.mocked(files.fetchKeyboardFiles).mockRejectedValue(
      new MissingRepoFile('config/*.keymap')
    )
    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Flark')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      name: 'MissingRepoFile',
      path: 'config/*.keymap',
      errors: ['Missing file config/*.keymap']
    })
  })

  it('GET /github/keyboard-files allows a missing info.json', async () => {
    vi.mocked(files.fetchKeyboardFiles).mockResolvedValue({
      info: null,
      keymap: VALID_KEYMAP,
      hostSnapshot: null,
      headSha: 'abc123'
    })
    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Flark')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      info: null,
      keymap: parseKeymap(VALID_KEYMAP),
      hostSnapshot: null,
      headSha: 'abc123'
    })
  })

  it('GET /github/keyboard-files returns 400 JSON for KeymapValidationError', async () => {
    vi.mocked(files.fetchKeyboardFiles).mockRejectedValue(
      new KeymapValidationError(['layer 0 is invalid'])
    )
    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Flark')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      name: 'KeymapValidationError',
      errors: ['layer 0 is invalid']
    })
  })

  it('GET /github/keyboard-files returns parsed keymap on success', async () => {
    vi.mocked(files.fetchKeyboardFiles).mockResolvedValue({
      info: VALID_INFO,
      keymap: VALID_KEYMAP,
      hostSnapshot: null,
      headSha: 'abc123'
    })
    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Flark')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      info: VALID_INFO,
      keymap: parseKeymap(VALID_KEYMAP),
      hostSnapshot: null,
      headSha: 'abc123'
    })
  })

  it('POST /github/keyboard-files returns 409 when GitHub PATCH is not a fast-forward', async () => {
    vi.mocked(files.commitChanges).mockRejectedValue(
      Object.assign(new Error('GitHub API 422'), {
        response: { status: 422, data: 'Update is not a fast forward' }
      })
    )
    const layout = [{ x: 0, y: 0 }]
    const keymap = parseKeymap(VALID_KEYMAP)
    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Flark/main', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keymap, layout, baseSha: 'abc123' })
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      name: 'StaleRepoBase',
      errors: ['Branch changed on GitHub — reload']
    })
  })

  it('POST /github/keyboard-files returns 409 when baseSha does not match head', async () => {
    vi.mocked(files.commitChanges).mockRejectedValue(new files.StaleRepoBase())
    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Flark/main', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keymap: parseKeymap(VALID_KEYMAP),
        layout: [{ x: 0, y: 0 }],
        baseSha: 'stale'
      })
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      name: 'StaleRepoBase',
      errors: ['Branch changed on GitHub — reload']
    })
  })

  it('POST /github/keyboard-files decodes a single branch segment and returns 400 on KeymapValidationError', async () => {
    const commit = vi.mocked(files.commitChanges).mockRejectedValue(
      new KeymapValidationError(['bad keymap'])
    )
    const layout = [{ x: 0, y: 0 }]
    const keymap = parseKeymap(VALID_KEYMAP)
    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Flark/feature%2Fx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keymap, layout })
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      name: 'KeymapValidationError',
      errors: ['bad keymap']
    })
    expect(commit).toHaveBeenCalledWith(
      '1',
      'acme/lark',
      'feature/x',
      layout,
      keymap,
      null,
      null,
      null
    )
  })

  it('POST /github/keyboard-files returns 400 for invalid JSON bodies', async () => {
    const commit = vi.mocked(files.commitChanges)
    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Flark/main', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json'
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ errors: ['Request body must be valid JSON'] })
    expect(commit).not.toHaveBeenCalled()
  })

  it('POST /github/keyboard-files returns 400 for an invalid host snapshot', async () => {
    const commit = vi.mocked(files.commitChanges)
    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Flark/main', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keymap: parseKeymap(VALID_KEYMAP),
        layout: [{ x: 0, y: 0 }],
        hostSnapshot: { version: 99 }
      })
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ errors: ['Invalid host snapshot'] })
    expect(commit).not.toHaveBeenCalled()
  })

  it('POST /github/keyboard-files returns 400 when layout or keymap is not an array payload', async () => {
    const commit = vi.mocked(files.commitChanges)
    const badLayout = await authedRequest('/github/keyboard-files/1/acme%2Flark/main', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keymap: parseKeymap(VALID_KEYMAP), layout: { x: 0 } })
    })
    expect(badLayout.res.status).toBe(400)
    expect(await badLayout.res.json()).toEqual({ errors: ['layout must be an array'] })

    const badKeymap = await authedRequest('/github/keyboard-files/1/acme%2Flark/main', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keymap: { layers: 'nope' }, layout: [{ x: 0, y: 0 }] })
    })
    expect(badKeymap.res.status).toBe(400)
    expect(await badKeymap.res.json()).toEqual({
      errors: ['keymap must include a layers array']
    })
    expect(commit).not.toHaveBeenCalled()
  })

  it('POST /github/keyboard-files returns 400 for an invalid branch name', async () => {
    const commit = vi.mocked(files.commitChanges)
    const layout = [{ x: 0, y: 0 }]
    const keymap = parseKeymap(VALID_KEYMAP)
    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Flark/has%20space', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keymap, layout })
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ name: 'BranchNameError' })
    expect(commit).not.toHaveBeenCalled()
  })

  it('POST /github/keyboard-files does not commit a triple-encoded dot-dot branch', async () => {
    const commit = vi.mocked(files.commitChanges)
    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Flark/x%25252e%25252e', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keymap: parseKeymap(VALID_KEYMAP), layout: [{ x: 0, y: 0 }] })
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ name: 'BranchNameError' })
    expect(commit).not.toHaveBeenCalled()
  })

  it('POST /github/keyboard-files returns 400 for a branch name with %', async () => {
    const commit = vi.mocked(files.commitChanges)
    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Flark/feature%2F100%25', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keymap: parseKeymap(VALID_KEYMAP), layout: [{ x: 0, y: 0 }] })
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ name: 'BranchNameError' })
    expect(commit).not.toHaveBeenCalled()
  })

  it('POST /github/installation branches rejects a traversing from', async () => {
    const create = vi.spyOn(installations, 'createBranch')
    const { res } = await authedRequest('/github/installation/1/acme%2Flark/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'topic', from: '../../x' })
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ name: 'BranchNameError' })
    expect(create).not.toHaveBeenCalled()
  })

  it('GET /github/keyboard-files returns 400 for an invalid branch query', async () => {
    const fetchFiles = vi.mocked(files.fetchKeyboardFiles)
    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Flark?branch=bad..name')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ name: 'BranchNameError' })
    expect(fetchFiles).not.toHaveBeenCalled()
  })

  it('POST /github/installation branches requires a session and a valid name', async () => {
    const anon = await app.request('/github/installation/1/acme%2Flark/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: appOrigin },
      body: JSON.stringify({ name: 'topic', from: 'main' })
    })
    expect(anon.status).toBe(401)

    const invalid = await authedRequest('/github/installation/1/acme%2Flark/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'has space', from: 'main' })
    })
    expect(invalid.res.status).toBe(400)
    expect(await invalid.res.json()).toMatchObject({ name: 'BranchNameError' })
  })

  it('POST /github/installation branches creates a branch from the source commit', async () => {
    vi.spyOn(auth, 'createInstallationToken').mockResolvedValue({
      data: { token: 'install-token' }
    } as Awaited<ReturnType<typeof auth.createInstallationToken>>)
    const create = vi.spyOn(installations, 'createBranch').mockResolvedValue({ name: 'topic' })

    const { res } = await authedRequest('/github/installation/1/acme%2Flark/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'topic', from: 'main' })
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ name: 'topic' })
    expect(create).toHaveBeenCalledWith('install-token', 'acme/lark', 'topic', 'main')
  })

  it('GET /github/installation branches mints one token for two requests', async () => {
    vi.mocked(installations.fetchRepoBranches).mockResolvedValue([])
    vi.spyOn(fs, 'readFileSync').mockReturnValue('test-pem')
    vi.spyOn(jwt, 'sign').mockImplementation(() => 'app-jwt')
    const mint = vi.spyOn(api, 'request').mockResolvedValue({
      data: {
        token: 'install-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      },
      headers: {},
      status: 201
    })
    const sid = trackSid(createSession({ login: 'octocat', oauthAccessToken: 'user-token' }))

    const first = await authedRequest('/github/installation/1/acme%2Flark/branches', {}, sid)
    const second = await authedRequest('/github/installation/1/acme%2Flark/branches', {}, sid)
    expect(first.res.status).toBe(200)
    expect(second.res.status).toBe(200)
    expect(mint).toHaveBeenCalledTimes(1)
    expect(mint).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/app/installations/1/access_tokens',
        data: { repositories: ['lark'] }
      })
    )
  })

  it('GET /github/builds requires a session and a branch', async () => {
    const anon = await app.request('/github/builds/1/acme%2Fkeymap?branch=main')
    expect(anon.status).toBe(401)

    const missingBranch = await authedRequest('/github/builds/1/acme%2Fkeymap')
    expect(missingBranch.res.status).toBe(400)
  })

  it('GET /github/builds returns the firmware build for the branch', async () => {
    const fetchBuild = vi.spyOn(builds, 'fetchFirmwareBuild').mockResolvedValue({
      status: 'success',
      sha: 'abcdef1234567890',
      shortSha: 'abcdef1',
      at: '2026-09-29T11:40:00.000Z',
      htmlUrl: 'https://github.com/acme/keymap/actions/runs/7',
      artifactId: 2,
      artifactName: 'firmware',
      detail: null
    })
    const { res } = await authedRequest('/github/builds/1/acme%2Fkeymap?branch=main')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'success', artifactId: 2 })
    expect(fetchBuild).toHaveBeenCalledWith('1', 'acme/keymap', 'main')
  })

  it('GET /github/builds returns unavailable JSON when Actions is not granted', async () => {
    vi.spyOn(builds, 'fetchFirmwareBuild').mockResolvedValue({
      status: 'unavailable',
      sha: null,
      shortSha: null,
      at: null,
      htmlUrl: null,
      artifactId: null,
      artifactName: null,
      detail: 'actions_permission'
    })
    const { res } = await authedRequest('/github/builds/1/acme%2Fkeymap?branch=main')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      status: 'unavailable',
      detail: 'actions_permission'
    })
  })

  it('GET /github/builds artifact downloads a zip', async () => {
    vi.spyOn(builds, 'downloadFirmwareArtifact').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]))
    )
    const { res } = await authedRequest(
      '/github/builds/1/acme%2Fkeymap/artifact/22?name=firmware'
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/zip')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="firmware.zip"')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('POST with a 5 MB body returns 413', async () => {
    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Flark/main', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(5_000_000)
    })
    expect(res.status).toBe(413)
    expect(files.commitChanges).not.toHaveBeenCalled()
  })
})

describe('POST /github/keyboard-files commit', () => {
  const layout = [{ x: 0, y: 0 }]
  const keymap = parseKeymap(VALID_KEYMAP)
  const deliverables = [
    { path: 'host_keymap/linux/ru.xkb', content: 'xkb_symbols "ru" { };\n' }
  ]
  const commitPath = '/github/keyboard-files/1/acme%2Flark/feature%2Fx'

  it('commits a parsed snapshot and returns { ok, mode, warnings }', async () => {
    const parsed = parseHostKeymapSnapshot(HOST_SNAPSHOT)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const commit = vi.mocked(files.commitChanges).mockResolvedValue({
      mode: 'splice',
      warnings: ['note']
    })
    const { res } = await authedRequest(commitPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keymap,
        layout,
        hostSnapshot: HOST_SNAPSHOT,
        hostDeliverables: deliverables,
        baseSha: 'abc123'
      })
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, mode: 'splice', warnings: ['note'] })
    expect(commit).toHaveBeenCalledWith(
      '1',
      'acme/lark',
      'feature/x',
      layout,
      keymap,
      parsed.snapshot,
      deliverables,
      'abc123'
    )
  })

  it('passes a canonical snapshot when the payload has extra fields or non-canonical order', async () => {
    const parsed = parseHostKeymapSnapshot(HOST_SNAPSHOT)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const messy = {
      extra: 'drop-me',
      layouts: HOST_SNAPSHOT.layouts.map(item => ({ ...item, leftover: true })),
      view: { leftover: 'column', ...HOST_SNAPSHOT.view },
      version: HOST_SNAPSHOT.version
    }
    const commit = vi.mocked(files.commitChanges).mockResolvedValue({
      mode: 'splice',
      warnings: []
    })
    const { res } = await authedRequest(commitPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keymap, layout, hostSnapshot: messy })
    })
    expect(res.status).toBe(200)
    expect(commit).toHaveBeenCalledTimes(1)
    const passed = commit.mock.calls[0]?.[5]
    expect(passed).toEqual(parsed.snapshot)
    expect(passed).not.toHaveProperty('extra')
    expect(passed).not.toMatchObject({ layouts: [{ leftover: true }] })
  })

  it('coerces a non-array hostDeliverables and non-string baseSha to null', async () => {
    const commit = vi.mocked(files.commitChanges).mockResolvedValue({
      mode: 'splice',
      warnings: []
    })
    const { res } = await authedRequest(commitPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keymap,
        layout,
        hostDeliverables: 'x',
        baseSha: 1
      })
    })
    expect(res.status).toBe(200)
    expect(commit).toHaveBeenCalledWith(
      '1',
      'acme/lark',
      'feature/x',
      layout,
      keymap,
      null,
      null,
      null
    )
  })

  it('returns 403 and does not commit when the installation has push:false', async () => {
    vi.mocked(installations.fetchInstallationRepos).mockResolvedValue({
      installations: [{ id: 1 }],
      repositories: [{ full_name: 'acme/lark' }],
      repoInstallationMap: { 'acme/lark': 1 },
      repoAccess: { 'acme/lark': { installationId: 1, push: false } }
    })
    const commit = vi.mocked(files.commitChanges)
    const { res } = await authedRequest(commitPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keymap, layout })
    })
    expect(res.status).toBe(403)
    expect(commit).not.toHaveBeenCalled()
  })
})

describe('installation access control', () => {
  it('rejects a foreign installationId with 403 before minting a token', async () => {
    const fetchFiles = vi.mocked(files.fetchKeyboardFiles)
    const createToken = vi.spyOn(auth, 'createInstallationToken')

    const { res } = await authedRequest('/github/keyboard-files/999/acme%2Flark')
    expect(res.status).toBe(403)
    expect(fetchFiles).not.toHaveBeenCalled()
    expect(createToken).not.toHaveBeenCalled()
  })

  it('rejects a non-digit installationId with 403 before minting a token', async () => {
    const fetchFiles = vi.mocked(files.fetchKeyboardFiles)
    const createToken = vi.spyOn(auth, 'createInstallationToken')

    const { res } = await authedRequest('/github/keyboard-files/1e2/acme%2Flark')
    expect(res.status).toBe(403)
    expect(fetchFiles).not.toHaveBeenCalled()
    expect(createToken).not.toHaveBeenCalled()
  })

  it('rejects a foreign repository within an own installation with 403', async () => {
    const fetchFiles = vi.mocked(files.fetchKeyboardFiles)
    const createToken = vi.spyOn(auth, 'createInstallationToken')

    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Fother')
    expect(res.status).toBe(403)
    expect(fetchFiles).not.toHaveBeenCalled()
    expect(createToken).not.toHaveBeenCalled()
  })

  it('allows own installation and repository', async () => {
    vi.mocked(files.fetchKeyboardFiles).mockResolvedValue({
      info: VALID_INFO,
      keymap: VALID_KEYMAP,
      hostSnapshot: null,
      headSha: 'abc123'
    })
    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Flark')
    expect(res.status).toBe(200)
    expect(files.fetchKeyboardFiles).toHaveBeenCalledWith('1', 'acme/lark', undefined)
  })

  it('caches installation access on the session across requests', async () => {
    vi.mocked(files.fetchKeyboardFiles).mockResolvedValue({
      info: VALID_INFO,
      keymap: VALID_KEYMAP,
      hostSnapshot: null,
      headSha: 'abc123'
    })
    const sid = trackSid(createSession({ login: 'octocat', oauthAccessToken: 'user-token' }))

    const first = await app.request('/github/keyboard-files/1/acme%2Flark', {
      headers: { Cookie: sessionCookie(sid) }
    })
    const second = await app.request('/github/keyboard-files/1/acme%2Flark', {
      headers: { Cookie: sessionCookie(sid) }
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(installations.fetchInstallationRepos).toHaveBeenCalledTimes(1)
  })

  it('rejects foreign installation on branch and build routes', async () => {
    const createToken = vi.spyOn(auth, 'createInstallationToken')
    const fetchBuild = vi.spyOn(builds, 'fetchFirmwareBuild')

    const branches = await authedRequest('/github/installation/999/acme%2Flark/branches')
    expect(branches.res.status).toBe(403)

    const buildsRes = await authedRequest('/github/builds/999/acme%2Fkeymap?branch=main')
    expect(buildsRes.res.status).toBe(403)

    expect(createToken).not.toHaveBeenCalled()
    expect(fetchBuild).not.toHaveBeenCalled()
  })

  it('rejects acme/b when the user list only includes acme/a', async () => {
    vi.mocked(installations.fetchInstallationRepos).mockResolvedValue({
      installations: [{ id: 1 }],
      repositories: [{ full_name: 'acme/a' }],
      repoInstallationMap: { 'acme/a': 1 },
      repoAccess: { 'acme/a': { installationId: 1, push: true } }
    })
    const fetchFiles = vi.mocked(files.fetchKeyboardFiles)
    const commit = vi.mocked(files.commitChanges)

    const { res } = await authedRequest('/github/keyboard-files/1/acme%2Fb')
    expect(res.status).toBe(403)
    expect(fetchFiles).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('allows GET without push and rejects POST commit', async () => {
    vi.mocked(installations.fetchInstallationRepos).mockResolvedValue({
      installations: [{ id: 1 }],
      repositories: [{ full_name: 'acme/a' }],
      repoInstallationMap: { 'acme/a': 1 },
      repoAccess: { 'acme/a': { installationId: 1, push: false } }
    })
    vi.mocked(files.fetchKeyboardFiles).mockResolvedValue({
      info: VALID_INFO,
      keymap: VALID_KEYMAP,
      hostSnapshot: null,
      headSha: 'abc123'
    })
    const commit = vi.mocked(files.commitChanges)
    const sid = trackSid(createSession({ login: 'octocat', oauthAccessToken: 'user-token' }))

    const read = await app.request('/github/keyboard-files/1/acme%2Fa', {
      headers: { Cookie: sessionCookie(sid) }
    })
    expect(read.status).toBe(200)

    const write = await app.request('/github/keyboard-files/1/acme%2Fa/main', {
      method: 'POST',
      headers: {
        Cookie: sessionCookie(sid),
        Origin: appOrigin,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ keymap: parseKeymap(VALID_KEYMAP), layout: [{ x: 0, y: 0 }] })
    })
    expect(write.status).toBe(403)
    expect(commit).not.toHaveBeenCalled()
  })

  it('GET /github/installation fills the session ACL cache', async () => {
    vi.mocked(files.fetchKeyboardFiles).mockResolvedValue({
      info: VALID_INFO,
      keymap: VALID_KEYMAP,
      hostSnapshot: null,
      headSha: 'abc123'
    })
    const { sid, res } = await authedRequest('/github/installation')
    expect(res.status).toBe(200)
    expect(getSession(sid)?.installationAccess?.repos).toEqual({
      'acme/lark': { installationId: 1, push: true },
      'acme/keymap': { installationId: 1, push: true }
    })
    expect(installations.fetchInstallationRepos).toHaveBeenCalledTimes(1)

    const filesRes = await app.request('/github/keyboard-files/1/acme%2Flark', {
      headers: { Cookie: sessionCookie(sid) }
    })
    expect(filesRes.status).toBe(200)
    expect(installations.fetchInstallationRepos).toHaveBeenCalledTimes(1)
  })
})

describe('GitHub error status and body.name', () => {
  const createBranchPath = '/github/installation/1/acme%2Flark/branches'
  const artifactPath = '/github/builds/1/acme%2Fkeymap/artifact/22?name=firmware'
  const buildsPath = '/github/builds/1/acme%2Fkeymap'

  function githubStatusError(status: number) {
    return Object.assign(new Error(`GitHub API ${status}`), {
      response: { status, data: { message: 'failed' } }
    })
  }

  function mockInstallToken() {
    vi.spyOn(auth, 'createInstallationToken').mockResolvedValue({
      data: { token: 'install-token' }
    } as Awaited<ReturnType<typeof auth.createInstallationToken>>)
  }

  it.each([
    {
      title: 'create-branch JSON is invalid',
      status: 400,
      name: 'BranchNameError',
      request: () =>
        authedRequest(createBranchPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{not-json'
        })
    },
    {
      title: 'create-branch GitHub 422 maps to BranchExists',
      status: 409,
      name: 'BranchExists',
      setup: () => {
        mockInstallToken()
        vi.spyOn(installations, 'createBranch').mockRejectedValue(githubStatusError(422))
      },
      request: () =>
        authedRequest(createBranchPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'topic', from: 'main' })
        })
    },
    {
      title: 'create-branch GitHub 404 maps to BranchNotFound',
      status: 400,
      name: 'BranchNotFound',
      setup: () => {
        mockInstallToken()
        vi.spyOn(installations, 'createBranch').mockRejectedValue(githubStatusError(404))
      },
      request: () =>
        authedRequest(createBranchPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'topic', from: 'main' })
        })
    },
    {
      title: 'artifact zip has an empty body',
      status: 502,
      name: undefined,
      setup: () => {
        vi.spyOn(builds, 'downloadFirmwareArtifact').mockResolvedValue(new Response(null))
      },
      request: () => authedRequest(artifactPath)
    },
    {
      title: 'artifact InstallationAccessError',
      status: 403,
      name: undefined,
      request: () => authedRequest('/github/builds/999/acme%2Fkeymap/artifact/22?name=firmware')
    },
    {
      title: 'artifact is too large',
      status: 413,
      name: undefined,
      setup: () => {
        vi.spyOn(builds, 'downloadFirmwareArtifact').mockRejectedValue(
          new builds.ArtifactTooLargeError(99_000_000)
        )
      },
      request: () => authedRequest(artifactPath)
    },
    {
      title: 'artifact id is not digits',
      status: 400,
      name: undefined,
      request: () => authedRequest('/github/builds/1/acme%2Fkeymap/artifact/not-a-number')
    },
    {
      title: 'builds query is missing branch',
      status: 400,
      name: undefined,
      request: () => authedRequest(buildsPath)
    },
    {
      title: 'builds JSON has an invalid branch name',
      status: 400,
      name: 'BranchNameError',
      request: () => authedRequest(`${buildsPath}?branch=has%20space`)
    },
    {
      title: 'create-branch InstallationAccessError',
      status: 403,
      name: undefined,
      request: () =>
        authedRequest('/github/installation/999/acme%2Flark/branches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'topic', from: 'main' })
        })
    }
  ])('returns $status and name $name when $title', async ({ status, name, setup, request }) => {
    setup?.()
    const { res } = await request()
    expect(res.status).toBe(status)
    const text = await res.text()
    const body = text ? (JSON.parse(text) as { name?: string }) : {}
    expect(body.name).toBe(name)
  })
})

type GithubRequestContract = {
  name: string
  method: string
  url: string
  body?: unknown
}

const GITHUB_REQUEST_CONTRACT = JSON.parse(
  fs.readFileSync(
    fileURLToPath(new URL('../../../../contracts/github-requests.json', import.meta.url)),
    'utf8'
  )
) as GithubRequestContract[]

const CONTRACT_REPOS = {
  installations: [{ id: 42 }],
  repositories: [{ full_name: 'acme/lark' }],
  repoInstallationMap: { 'acme/lark': 42 },
  repoAccess: {
    'acme/lark': { installationId: 42, push: true }
  }
}

describe('GitHub request contract with the web client', () => {
  const contractApp = createApp({
    enableGithub: true,
    enableDevServer: true,
    webDist: path.join(path.dirname(fileURLToPath(import.meta.url)), '__missing-web-dist__')
  })

  async function playContract(entry: GithubRequestContract) {
    const parsed = new URL(entry.url)
    const requestPath = `${parsed.pathname}${parsed.search}`
    const headers = new Headers()
    headers.set('Cookie', sessionCookie(trackSid(createSession({ login: 'octocat', oauthAccessToken: 'user-token' }))))
    const method = entry.method.toUpperCase()
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      headers.set('Origin', appOrigin)
    }
    const init: RequestInit = { method, headers }
    if (entry.body !== undefined) {
      headers.set('Content-Type', 'application/json')
      init.body = JSON.stringify(entry.body)
    }
    return contractApp.request(requestPath, init)
  }

  beforeEach(() => {
    vi.mocked(installations.fetchInstallationRepos).mockResolvedValue(CONTRACT_REPOS)
    vi.spyOn(auth, 'createInstallationToken').mockResolvedValue({
      data: { token: 'install-token' }
    } as Awaited<ReturnType<typeof auth.createInstallationToken>>)
    vi.mocked(installations.fetchRepoBranches).mockResolvedValue([])
    vi.spyOn(installations, 'createBranch').mockResolvedValue({ name: 'feature/x#1' })
    vi.mocked(files.fetchKeyboardFiles).mockResolvedValue({
      info: VALID_INFO,
      keymap: VALID_KEYMAP,
      hostSnapshot: null,
      headSha: 'abc123'
    })
    vi.mocked(files.commitChanges).mockResolvedValue({ mode: 'splice', warnings: [] })
    vi.spyOn(builds, 'fetchFirmwareBuild').mockResolvedValue({
      status: 'none',
      sha: null,
      shortSha: null,
      at: null,
      htmlUrl: null,
      artifactId: null,
      artifactName: null,
      detail: null
    })
    vi.spyOn(builds, 'downloadFirmwareArtifact').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]))
    )
  })

  for (const entry of GITHUB_REQUEST_CONTRACT) {
    it(`decodes ${entry.name} the way the SPA encodes it`, async () => {
      const res = await playContract(entry)
      expect(res.status, `${entry.name} ${entry.method} ${entry.url}`).toBeGreaterThanOrEqual(200)
      expect(res.status, `${entry.name} ${entry.method} ${entry.url}`).toBeLessThan(300)

      if (entry.name === 'init') return

      expect(
        vi.mocked(installations.fetchRepoBranches).mock.calls[0]?.[1] ??
          vi.mocked(installations.createBranch).mock.calls[0]?.[1] ??
          vi.mocked(files.fetchKeyboardFiles).mock.calls[0]?.[1] ??
          vi.mocked(files.commitChanges).mock.calls[0]?.[1] ??
          vi.mocked(builds.fetchFirmwareBuild).mock.calls[0]?.[1] ??
          vi.mocked(builds.downloadFirmwareArtifact).mock.calls[0]?.[1]
      ).toBe('acme/lark')

      if (entry.name === 'fetchRepoBranches' || entry.name === 'firmwareDownloadUrl') return

      if (entry.name === 'createBranch') {
        expect(vi.mocked(installations.createBranch).mock.calls[0]?.[2]).toBe('feature/x#1')
        return
      }

      expect(
        vi.mocked(files.fetchKeyboardFiles).mock.calls[0]?.[2] ??
          vi.mocked(files.commitChanges).mock.calls[0]?.[2] ??
          vi.mocked(builds.fetchFirmwareBuild).mock.calls[0]?.[2]
      ).toBe('feature/x#1')
    })
  }
})
