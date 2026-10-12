import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, stripQueryFromRequestLog } from './index.js'

function parseCsp(header: string | null): Map<string, string[]> {
  const map = new Map<string, string[]>()
  if (!header) return map
  for (const part of header.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    map.set(tokens[0], tokens.slice(1))
  }
  return map
}

describe('production static security headers', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  function tempWebDist(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keymap-web-dist-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>editor</title>\n')
    fs.mkdirSync(path.join(dir, 'assets'))
    fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)\n')
    return dir
  }

  it('GET / from WEB_DIST sends CSP, XFO, nosniff, and Referrer-Policy', async () => {
    const webDist = tempWebDist()
    const app = createApp({
      webDist,
      appBaseUrl: 'http://localhost:8080',
      enableGithub: false,
      enableDevServer: false
    })
    const res = await app.request('/')
    expect(res.status).toBe(200)

    const csp = parseCsp(res.headers.get('content-security-policy'))
    expect(csp.get('default-src')).toEqual(["'self'"])
    expect(csp.get('style-src')).toEqual(["'self'", 'https://fonts.googleapis.com'])
    expect(csp.get('style-src-attr')).toEqual(["'unsafe-inline'"])
    expect(csp.get('font-src')).toEqual(['https://fonts.gstatic.com'])
    expect(csp.get('img-src')).toEqual(["'self'", 'data:'])
    expect(csp.get('connect-src')).toEqual(["'self'"])
    expect(csp.get('frame-ancestors')).toEqual(["'none'"])

    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBeTruthy()
    expect(res.headers.get('strict-transport-security')).toBeNull()
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
  })

  it('lets other sites embed /og.jpg and keeps other files same-origin', async () => {
    const webDist = tempWebDist()
    fs.writeFileSync(path.join(webDist, 'og.jpg'), 'jpeg')
    const app = createApp({
      webDist,
      appBaseUrl: 'https://zmk-keymap-editor.com',
      enableGithub: false,
      enableDevServer: false
    })
    const preview = await app.request('https://zmk-keymap-editor.com/og.jpg')
    expect(preview.status).toBe(200)
    expect(preview.headers.get('content-type')).toMatch(/^image\/jpeg/)
    expect(preview.headers.get('cross-origin-resource-policy')).toBe('cross-origin')

    const script = await app.request('/assets/app.js')
    expect(script.headers.get('cross-origin-resource-policy')).toBe('same-origin')
  })

  it('GET / with a public Host still serves the SPA (local adapter Host guard is not global)', async () => {
    const webDist = tempWebDist()
    const app = createApp({
      webDist,
      appBaseUrl: 'https://zmk-keymap-editor.com',
      enableGithub: false,
      enableDevServer: false
    })
    const res = await app.request('https://zmk-keymap-editor.com/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<!doctype html>')
  })

  it('sets HSTS only when APP_BASE_URL is https', async () => {
    const webDist = tempWebDist()
    const app = createApp({
      webDist,
      appBaseUrl: 'https://editor.example',
      enableGithub: false,
      enableDevServer: false
    })
    const res = await app.request('/')
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=/)
  })

  it('sets immutable Cache-Control on /assets/*', async () => {
    const webDist = tempWebDist()
    const app = createApp({
      webDist,
      appBaseUrl: 'http://localhost:8080',
      enableGithub: false,
      enableDevServer: false
    })
    const res = await app.request('/assets/app.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })
})

describe('request logs', () => {
  it('stripQueryFromRequestLog drops the search string', () => {
    expect(
      stripQueryFromRequestLog('<-- GET /github/authorize?code=secret&state=abc')
    ).toBe('<-- GET /github/authorize')
    expect(
      stripQueryFromRequestLog('--> GET /github/authorize?code=secret 302 12ms')
    ).toBe('--> GET /github/authorize 302 12ms')
  })

  it('GET /health with a query does not log code or state', async () => {
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      if (typeof msg === 'string') lines.push(msg)
    })
    const app = createApp({
      webDist: path.join(os.tmpdir(), 'keymap-missing-web-dist'),
      enableGithub: false,
      enableDevServer: true
    })
    await app.request('/health?code=oauth-secret&state=csrf')
    log.mockRestore()
    const joined = lines.join('\n')
    expect(joined).toMatch(/GET \/health/)
    expect(joined).not.toContain('oauth-secret')
    expect(joined).not.toContain('code=')
  })
})
