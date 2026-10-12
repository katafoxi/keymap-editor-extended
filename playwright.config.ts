import { defineConfig } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { resolveE2eZmkConfig } from './e2e/lark-temp'

const REPO_ROOT = process.cwd()

function reservePort(preferred: number): number {
  const script = `
    const net = require('net');
    const preferred = ${preferred};
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      const fallback = net.createServer();
      fallback.unref();
      fallback.listen(0, '127.0.0.1', () => {
        const port = fallback.address().port;
        fallback.close(() => process.stdout.write(String(port)));
      });
    });
    server.listen(preferred, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => process.stdout.write(String(port)));
    });
  `
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(result.stderr || 'failed to reserve a TCP port')
  }
  const port = Number(result.stdout.trim())
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`invalid reserved port: ${result.stdout}`)
  }
  return port
}

const tmpRoot = resolveE2eZmkConfig()
process.env.E2E_ZMK_CONFIG = tmpRoot

const apiPort = process.env.E2E_API_PORT
  ? Number(process.env.E2E_API_PORT)
  : reservePort(18080)
const webPort = process.env.E2E_WEB_PORT
  ? Number(process.env.E2E_WEB_PORT)
  : reservePort(15173)
process.env.E2E_API_PORT = String(apiPort)
process.env.E2E_WEB_PORT = String(webPort)

const apiOrigin = `http://127.0.0.1:${apiPort}`
const webOrigin = `http://127.0.0.1:${webPort}`

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  testIgnore: ['prod/**'],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: webOrigin,
    browserName: 'chromium',
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
    // Optional local Chromium (Brave, Chrome) when the Playwright browser download is unavailable.
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : undefined
  },
  webServer: [
    {
      command: 'pnpm --filter @keymap-editor/api exec tsx src/index.ts',
      cwd: REPO_ROOT,
      url: `${apiOrigin}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        ENABLE_LOCAL: 'true',
        ENABLE_GITHUB: 'false',
        ZMK_CONFIG_PATH: tmpRoot,
        PORT: String(apiPort),
        APP_BASE_URL: webOrigin
      }
    },
    {
      command: `pnpm --filter @keymap-editor/web exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
      cwd: REPO_ROOT,
      url: webOrigin,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        VITE_ENABLE_LOCAL: 'true',
        VITE_ENABLE_GITHUB: 'true',
        API_PROXY: apiOrigin,
        VITE_PORT: String(webPort)
      }
    }
  ],
  globalTeardown: './e2e/global-teardown.ts'
})
