import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie } from 'hono/cookie'
import { config } from '../config.js'
import {
  KeymapValidationError,
  InfoValidationError,
  parseHostKeymapSnapshot,
  parseKeymap,
  validateKeymapJson,
  validateInfoJson,
  type HostKeymapDeliverableFile,
  type HostKeymapSnapshot,
  type LayoutKey,
  type ParsedKeymap
} from '@keymap-editor/keymap-core'
import * as auth from '../services/github/auth.js'
import {
  consumeOauthState,
  createOauthState,
  createSession,
  deleteSession,
  oauthTokenNeedsRefresh,
  touchSession,
  updateSessionOauthTokens,
  type Session
} from '../services/github/sessions.js'
import * as installations from '../services/github/installations.js'
import {
  assertInstallationAccess,
  cacheInstallationAccess,
  InstallationAccessError
} from '../services/github/installation-access.js'
import * as files from '../services/github/files.js'
import * as builds from '../services/github/builds.js'

type Variables = {
  session: Session
}

export const githubRoutes = new Hono<{ Variables: Variables }>()

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const POST_BODY_MAX_BYTES = 2_000_000
const limitPostBody = bodyLimit({ maxSize: POST_BODY_MAX_BYTES })
const DEFAULT_GITHUB_RATE_MAX = 120
const DEFAULT_GITHUB_RATE_WINDOW_MS = 60_000
export const GITHUB_RATE_BUCKET_CAP = 2_000

let githubRateMax = DEFAULT_GITHUB_RATE_MAX
let githubRateWindowMs = DEFAULT_GITHUB_RATE_WINDOW_MS
const githubRateBuckets = new Map<string, { count: number; resetAt: number }>()

function socketAddress(c: Context): string | undefined {
  try {
    const address = getConnInfo(c).remote.address?.trim()
    if (address) return address
  } catch {
    // app.request() in tests has no incoming socket
  }
  return undefined
}

function forwardedClientIp(c: Context): string | undefined {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  const realIp = c.req.header('x-real-ip')?.trim()
  return realIp || undefined
}

function clientIp(c: Context): string {
  if (config.TRUST_PROXY) {
    const forwarded = forwardedClientIp(c)
    if (forwarded) return forwarded
  }
  return socketAddress(c) ?? 'local'
}

export function pruneGithubRateBuckets(now: number) {
  for (const [ip, bucket] of githubRateBuckets) {
    if (bucket.resetAt <= now) githubRateBuckets.delete(ip)
  }
  while (githubRateBuckets.size > GITHUB_RATE_BUCKET_CAP) {
    const oldest = githubRateBuckets.keys().next().value
    if (oldest === undefined) break
    githubRateBuckets.delete(oldest)
  }
}

/** Test-only: lower the per-IP cap so 429 can be asserted without flooding. */
export function setGithubRateLimitForTests(opts: { max?: number; windowMs?: number }): void {
  if (opts.max != null) githubRateMax = opts.max
  if (opts.windowMs != null) githubRateWindowMs = opts.windowMs
  githubRateBuckets.clear()
}

export function resetGithubRateLimitForTests(): void {
  githubRateMax = DEFAULT_GITHUB_RATE_MAX
  githubRateWindowMs = DEFAULT_GITHUB_RATE_WINDOW_MS
  githubRateBuckets.clear()
}

/** Test-only: inspect the in-memory map used by pruneGithubRateBuckets. */
export function githubRateBucketsForTests(): Map<string, { count: number; resetAt: number }> {
  return githubRateBuckets
}

githubRoutes.use('*', async (c, next) => {
  const now = Date.now()
  const ip = clientIp(c)
  let bucket = githubRateBuckets.get(ip)
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + githubRateWindowMs }
    githubRateBuckets.set(ip, bucket)
  }
  bucket.count += 1
  if (bucket.count > githubRateMax) {
    if (githubRateBuckets.size > GITHUB_RATE_BUCKET_CAP) pruneGithubRateBuckets(now)
    const retrySec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    c.header('Retry-After', String(retrySec))
    return c.body(null, 429)
  }
  if (githubRateBuckets.size > GITHUB_RATE_BUCKET_CAP) pruneGithubRateBuckets(now)
  await next()
})

githubRoutes.use('*', async (c, next) => {
  if (c.req.method === 'POST') return limitPostBody(c, next)
  await next()
})

githubRoutes.use('*', async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method) && !auth.isTrustedAppOrigin(c)) {
    return c.body(null, 403)
  }
  await next()
})

githubRoutes.get('/authorize', async c => {
  const oauthError = c.req.query('error')
  if (oauthError) {
    const state = c.req.query('state')
    if (state) consumeOauthState(state)
    auth.clearOauthStateCookie(c)
    return c.redirect(auth.createOauthDeniedUrl())
  }

  const code = c.req.query('code')
  const setupAction = c.req.query('setup_action')
  const isInstallationReturn =
    c.req.query('state') === undefined &&
    (setupAction === 'install' || setupAction === 'update') &&
    /^[1-9]\d*$/.test(c.req.query('installation_id') ?? '')

  // GitHub's authorization-during-installation return can omit OAuth state.
  // Neither its code nor installation_id can establish identity or repo access.
  if (isInstallationReturn) {
    const sid = getCookie(c, auth.SID_COOKIE)
    if (sid && touchSession(sid)) return c.redirect(auth.createOauthReturnUrl())
  }
  if (code && !isInstallationReturn) {
    try {
      const state = c.req.query('state')
      const cookieState = getCookie(c, auth.OAUTH_STATE_COOKIE)
      if (!state || !cookieState || state !== cookieState || !consumeOauthState(state)) {
        auth.clearOauthStateCookie(c)
        return c.body(null, 401)
      }

      const { data: oauth } = await auth.getOauthToken(code)
      const oauthData = auth.parseOauthTokenPayload(oauth)
      if (!oauthData) {
        auth.clearOauthStateCookie(c)
        return c.body(null, 401)
      }
      const { data: user } = await auth.getOauthUser(oauthData.accessToken)
      const login = (user as { login: string }).login
      const previousSid = getCookie(c, auth.SID_COOKIE)
      if (previousSid) deleteSession(previousSid)
      const sid = createSession({
        login,
        oauthAccessToken: oauthData.accessToken,
        oauthRefreshToken: oauthData.refreshToken,
        expiresInSec: oauthData.expiresInSec
      })
      auth.setSidCookie(c, sid)
      auth.clearOauthStateCookie(c)
      return c.redirect(auth.createOauthReturnUrl())
    } catch (err) {
      console.error(err)
      return c.body(null, 500)
    }
  }

  const previousSid = getCookie(c, auth.SID_COOKIE)
  if (previousSid) {
    deleteSession(previousSid)
    auth.clearSidCookie(c)
  }

  const state = createOauthState()
  auth.setOauthStateCookie(c, state)
  return c.redirect(auth.createOauthFlowUrl(state))
})

githubRoutes.post('/logout', c => {
  const sid = getCookie(c, auth.SID_COOKIE)
  if (sid) deleteSession(sid)
  auth.clearSidCookie(c)
  return c.body(null, 204)
})

githubRoutes.use('*', async (c, next) => {
  const sid = getCookie(c, auth.SID_COOKIE)
  if (!sid) return c.body(null, 401)

  const session = touchSession(sid)
  if (!session) {
    auth.clearSidCookie(c)
    return c.body(null, 401)
  }

  if (oauthTokenNeedsRefresh(session)) {
    const refreshToken = session.oauthRefreshToken
    if (!refreshToken) {
      deleteSession(sid)
      auth.clearSidCookie(c)
      return c.body(null, 401)
    }
    try {
      const { data } = await auth.refreshOauthToken(refreshToken)
      const refreshed = auth.parseOauthTokenPayload(data)
      if (!refreshed) {
        deleteSession(sid)
        auth.clearSidCookie(c)
        return c.body(null, 401)
      }
      updateSessionOauthTokens(sid, {
        oauthAccessToken: refreshed.accessToken,
        oauthRefreshToken: refreshed.refreshToken ?? refreshToken,
        expiresInSec: refreshed.expiresInSec
      })
    } catch (err) {
      console.error(err)
      deleteSession(sid)
      auth.clearSidCookie(c)
      return c.body(null, 401)
    }
  }

  // Keep browser cookie maxAge aligned with the sliding server TTL.
  auth.setSidCookie(c, sid)

  c.set('session', session)
  await next()
})

githubRoutes.get('/installation', async c => {
  const session = c.get('session')
  try {
    const { repoAccess, ...installationRepos } = await installations.fetchInstallationRepos(
      session.oauthAccessToken
    )
    cacheInstallationAccess(session, repoAccess)
    if ((installationRepos.installations as unknown[]).length === 0) {
      console.log(`User ${session.login} does not have an active app installation.`)
    }
    return c.json({ login: session.login, ...installationRepos })
  } catch (err) {
    return handleGithubError(c, err)
  }
})

githubRoutes.post('/installation/:installationId/:repository/branches', async c => {
  const { installationId, repository: rawRepository } = c.req.param()
  let body: { name?: unknown; from?: unknown } = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json({ name: 'BranchNameError', errors: ['Enter a branch name'] }, 400)
  }
  const name = typeof body.name === 'string' ? body.name : ''
  const from = typeof body.from === 'string' ? body.from : ''
  try {
    const repository = installations.assertRepositoryName(rawRepository)
    installations.assertBranchName(name)
    installations.assertCommitish(from)
    await assertInstallationAccess(
      c.get('session'),
      installationId,
      repository,
      { requirePush: true }
    )
    const { data } = await auth.createInstallationToken(installationId, { repository })
    const created = await installations.createBranch(
      (data as { token: string }).token,
      repository,
      name,
      from
    )
    return c.json(created, 201)
  } catch (err) {
    if (err instanceof InstallationAccessError) {
      return c.body(null, 403)
    }
    if (
      err instanceof installations.BranchNameError ||
      err instanceof installations.RepositoryNameError
    ) {
      return c.json({ name: err.name, errors: err.errors }, 400)
    }
    const status = (err as { response?: { status?: number } }).response?.status
    if (status === 422) {
      return c.json(
        { name: 'BranchExists', errors: ['A branch with that name already exists'] },
        409
      )
    }
    if (status === 404) {
      return c.json({ name: 'BranchNotFound', errors: ['The source branch was not found'] }, 400)
    }
    return handleGithubError(c, err)
  }
})

githubRoutes.get('/installation/:installationId/:repository/branches', async c => {
  const { installationId, repository: rawRepository } = c.req.param()
  try {
    const repository = installations.assertRepositoryName(rawRepository)
    await assertInstallationAccess(
      c.get('session'),
      installationId,
      repository
    )
    const { data } = await auth.createInstallationToken(installationId, { repository })
    const branches = await installations.fetchRepoBranches(
      (data as { token: string }).token,
      repository
    )
    return c.json(branches)
  } catch (err) {
    if (err instanceof InstallationAccessError) {
      return c.body(null, 403)
    }
    if (err instanceof installations.RepositoryNameError) {
      return c.json({ name: err.name, errors: err.errors }, 400)
    }
    return handleGithubError(c, err)
  }
})

githubRoutes.get('/keyboard-files/:installationId/:repository', async c => {
  const { installationId, repository: rawRepository } = c.req.param()
  const rawBranch = c.req.query('branch')
  try {
    const repository = installations.assertRepositoryName(rawRepository)
    const branch =
      rawBranch == null || rawBranch === ''
        ? undefined
        : installations.assertBranchName(rawBranch)
    await assertInstallationAccess(
      c.get('session'),
      installationId,
      repository
    )
    const { info, keymap, hostSnapshot, headSha } = await files.fetchKeyboardFiles(
      installationId,
      repository,
      branch
    )
    if (info != null) validateInfoJson(info)
    validateKeymapJson(keymap)
    return c.json({
      info: info ?? null,
      keymap: parseKeymap(keymap as { layers: string[][] }),
      hostSnapshot: hostSnapshot ?? null,
      headSha
    })
  } catch (err) {
    if (err instanceof InstallationAccessError) {
      return c.body(null, 403)
    }
    if (
      err instanceof installations.BranchNameError ||
      err instanceof installations.RepositoryNameError
    ) {
      return c.json({ name: err.name, errors: err.errors }, 400)
    }
    if (err instanceof files.MissingRepoFile) {
      console.error(`Validation error in ${rawRepository} (${rawBranch}):`, err.name, err.errors)
      return c.json({ name: err.name, path: err.path, errors: err.errors }, 400)
    }
    if (err instanceof InfoValidationError || err instanceof KeymapValidationError) {
      console.error(`Validation error in ${rawRepository} (${rawBranch}):`, err.name, err.errors)
      return c.json({ name: err.name, errors: err.errors }, 400)
    }
    return handleGithubError(c, err)
  }
})

githubRoutes.get('/builds/:installationId/:repository/artifact/:artifactId', async c => {
  const { installationId, repository: rawRepository, artifactId } = c.req.param()
  if (!/^\d+$/.test(artifactId)) return c.body(null, 400)
  const archiveName = builds.firmwareArchiveName(c.req.query('name'))
  try {
    const repository = installations.assertRepositoryName(rawRepository)
    await assertInstallationAccess(
      c.get('session'),
      installationId,
      repository
    )
    const zip = await builds.downloadFirmwareArtifact(
      installationId,
      repository,
      artifactId
    )
    if (!zip.body) return c.body(null, 502)
    return c.body(zip.body, 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${archiveName}"`
    })
  } catch (err) {
    if (err instanceof InstallationAccessError) {
      return c.body(null, 403)
    }
    if (err instanceof builds.ArtifactTooLargeError) {
      return c.body(null, 413)
    }
    if (err instanceof installations.RepositoryNameError) {
      return c.json({ name: err.name, errors: err.errors }, 400)
    }
    return handleGithubError(c, err)
  }
})

githubRoutes.get('/builds/:installationId/:repository', async c => {
  const { installationId, repository: rawRepository } = c.req.param()
  const rawBranch = c.req.query('branch')
  if (!rawBranch) return c.body(null, 400)
  try {
    const repository = installations.assertRepositoryName(rawRepository)
    const branch = installations.assertBranchName(rawBranch)
    await assertInstallationAccess(
      c.get('session'),
      installationId,
      repository
    )
    const build = await builds.fetchFirmwareBuild(installationId, repository, branch)
    return c.json(build)
  } catch (err) {
    if (err instanceof InstallationAccessError) {
      return c.body(null, 403)
    }
    if (
      err instanceof installations.BranchNameError ||
      err instanceof installations.RepositoryNameError
    ) {
      return c.json({ name: err.name, errors: err.errors }, 400)
    }
    return handleGithubError(c, err)
  }
})

githubRoutes.post('/keyboard-files/:installationId/:repository/:branch', async c => {
  const { installationId, repository: rawRepository, branch: rawBranch } = c.req.param()
  let body: {
    keymap?: unknown
    layout?: unknown
    hostSnapshot?: unknown
    hostDeliverables?: unknown
    baseSha?: unknown
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ errors: ['Request body must be valid JSON'] }, 400)
  }
  try {
    const repository = installations.assertRepositoryName(rawRepository)
    const branch = installations.assertBranchName(rawBranch)
    await assertInstallationAccess(
      c.get('session'),
      installationId,
      repository,
      { requirePush: true }
    )
    const { keymap, layout, hostSnapshot, hostDeliverables, baseSha } = body
    if (!Array.isArray(layout)) {
      return c.json({ errors: ['layout must be an array'] }, 400)
    }
    if (
      keymap == null ||
      typeof keymap !== 'object' ||
      !Array.isArray((keymap as { layers?: unknown }).layers)
    ) {
      return c.json({ errors: ['keymap must include a layers array'] }, 400)
    }
    let snapshot: HostKeymapSnapshot | null = null
    if (hostSnapshot != null) {
      const parsed = parseHostKeymapSnapshot(hostSnapshot)
      if (!parsed.ok) {
        return c.json({ errors: ['Invalid host snapshot'] }, 400)
      }
      snapshot = parsed.snapshot
    }
    const { mode, warnings } = await files.commitChanges(
      installationId,
      repository,
      branch,
      layout as LayoutKey[],
      keymap as ParsedKeymap,
      snapshot,
      Array.isArray(hostDeliverables)
        ? (hostDeliverables as HostKeymapDeliverableFile[])
        : null,
      typeof baseSha === 'string' ? baseSha : null
    )
    return c.json({ ok: true, mode, warnings })
  } catch (err) {
    if (err instanceof InstallationAccessError) {
      return c.body(null, 403)
    }
    if (
      err instanceof installations.BranchNameError ||
      err instanceof installations.RepositoryNameError
    ) {
      return c.json({ name: err.name, errors: err.errors }, 400)
    }
    if (err instanceof KeymapValidationError) {
      return c.json({ name: err.name, errors: err.errors }, 400)
    }
    if (err instanceof files.StaleRepoBase) {
      return c.json({ name: err.name, errors: err.errors }, 409)
    }
    return handleGithubError(c, err)
  }
})

const GITHUB_ERROR_LOG_MAX = 1000

function stringifyGithubErrorData(data: unknown): string {
  let text: string
  try {
    text = typeof data === 'string' ? data : (JSON.stringify(data) ?? 'null')
  } catch {
    text = String(data)
  }
  return text.length > GITHUB_ERROR_LOG_MAX ? `${text.slice(0, GITHUB_ERROR_LOG_MAX)}…` : text
}

function isAppInstallationTokenUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url) return false
  try {
    const parsed = new URL(url, 'https://api.github.com')
    return /\/app\/installations\/[^/]+\/access_tokens$/.test(parsed.pathname)
  } catch {
    return false
  }
}

function handleGithubError(c: Context, err: unknown) {
  const e = err as { response?: { status?: number; data?: unknown; url?: string } }
  const status = e.response?.status
  const dataLog = e.response ? stringifyGithubErrorData(e.response.data) : null
  if (status === 401) {
    console.error('Received upstream authentication error', dataLog)
    if (isAppInstallationTokenUrl(e.response?.url)) {
      return c.body(null, 502)
    }
    return c.body(null, 401)
  }
  if (status === 404) {
    console.error(`[404] ${dataLog}`, err)
    return c.body(null, 404)
  }
  if (status === 429) {
    console.error(`[429] ${dataLog}`, err)
    return c.body(null, 429)
  }
  if (status === 403) {
    console.error(`[403] ${dataLog}`, err)
    return c.body(null, 502)
  }
  if (status === 409 || status === 422) {
    if (isAppInstallationTokenUrl(e.response?.url)) {
      console.error(`[${status}] ${dataLog}`, err)
      return c.body(null, 502)
    }
    return c.json(
      { name: 'StaleRepoBase', errors: [files.BRANCH_CHANGED_NOTICE] },
      409
    )
  }
  console.error(status ? `[${status}] ${dataLog}` : err, err)
  return c.body(null, 500)
}
