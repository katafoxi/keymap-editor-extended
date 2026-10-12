import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertLocalDevAdapterAllowed, config, originFromBaseUrl } from './config.js'
import { keyboardsRoutes } from './routes/keyboards.js'
import { githubRoutes } from './routes/github.js'
import { startSessionPruneTimer } from './services/github/sessions.js'

export type CreateAppOptions = {
  webDist?: string
  appBaseUrl?: string
  enableGithub?: boolean
  enableDevServer?: boolean
}

/** Hono's logger includes `?query`; strip it so OAuth `code`/`state` stay out of logs. */
export function stripQueryFromRequestLog(line: string): string {
  return line.replace(
    /^((?:<--|-->) [A-Z]+ )([^?\s]+)(?:\?[^\s]*)?/,
    (_all, prefix: string, pathname: string) => `${prefix}${pathname}`
  )
}

function printRequestLog(line: string) {
  console.log(stripQueryFromRequestLog(line))
}

function isHttpsBaseUrl(appBaseUrl: string): boolean {
  try {
    return new URL(appBaseUrl).protocol === 'https:'
  } catch {
    return false
  }
}

function isApiPath(reqPath: string): boolean {
  return (
    reqPath === '/health' ||
    reqPath.startsWith('/github') ||
    reqPath.startsWith('/layout') ||
    reqPath.startsWith('/keymap')
  )
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const webDist = options.webDist ?? config.WEB_DIST
  const appBaseUrl = options.appBaseUrl ?? config.APP_BASE_URL
  const enableGithub = options.enableGithub ?? config.ENABLE_GITHUB
  const enableDevServer = options.enableDevServer ?? config.ENABLE_DEV_SERVER
  const origin = originFromBaseUrl(appBaseUrl)

  const app = new Hono()

  app.use('*', cors({ origin, credentials: true }))
  app.use('*', logger(printRequestLog))
  // secureHeaders writes Cross-Origin-Resource-Policy after next(). This wrapper
  // runs later and opens only the link-preview image, which other sites put in <img>.
  app.use('*', async (c, next) => {
    await next()
    if (c.req.path === '/og.jpg') {
      c.res.headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
    }
  })
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        // Key positions and scale-to-fit set element.style; style-src does not
        // cover attributes, so Chrome reports style-src-attr without this.
        styleSrcAttr: ["'unsafe-inline'"],
        fontSrc: ['https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"]
      },
      xFrameOptions: 'DENY',
      strictTransportSecurity: isHttpsBaseUrl(appBaseUrl)
        ? 'max-age=15552000; includeSubDomains'
        : false
    })
  )

  app.get('/health', c => c.body(null, 200))
  app.route('/', keyboardsRoutes)

  if (enableGithub) {
    app.route('/github', githubRoutes)
  }

  if (fs.existsSync(webDist)) {
    const files = serveStatic({
      root: webDist,
      onFound(_filePath, c) {
        if (c.req.path.startsWith('/assets/')) {
          c.header('Cache-Control', 'public, max-age=31536000, immutable')
        }
      }
    })
    const index = serveStatic({ root: webDist, path: 'index.html' })
    // The SPA fallback must not answer API routes. A miss was returning index.html
    // with 200, and the firmware chip treated that page as an empty build.
    app.use('/*', async (c, next) => {
      if (isApiPath(c.req.path)) return next()
      return files(c, next)
    })
    app.get('*', async (c, next) => {
      if (isApiPath(c.req.path)) return c.notFound()
      return index(c, next)
    })
  } else if (!enableDevServer) {
    console.warn(`Web dist not found at ${webDist}; API-only mode`)
  }

  return app
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return path.normalize(path.resolve(entry)) === path.normalize(fileURLToPath(import.meta.url))
}

if (isDirectRun()) {
  if (config.ENABLE_GITHUB) {
    startSessionPruneTimer()
  }
  assertLocalDevAdapterAllowed()
  console.log(
    `API listening on ${config.HOST}:${config.PORT} (github=${config.ENABLE_GITHUB}, local=${config.ENABLE_LOCAL})`
  )
  serve({
    fetch: createApp().fetch,
    port: config.PORT,
    hostname: config.HOST
  })
}
